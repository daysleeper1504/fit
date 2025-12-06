/**
 * Gitea Remote Vault
 *
 * Implements IVault for Gitea repository trees.
 * Gitea API is largely compatible with GitHub API v3, with some differences.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from "./vault";
import { FileChange, FileStates } from "./util/changeTracking";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha, computeSha1 } from "./util/hashing";
import { FileContent, isBinaryExtension } from "./util/contentEncoding";
import { FilePath, detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import { fitLogger } from "./logger";
import { createObsidianFetchAdapter } from "./util/obsidianFetchAdapter";
import { merge3Way } from "./util/merge";
import type {
	GiteaBranch,
	GiteaRepository,
	GiteaCommitResponse
} from "./types/giteaApi";

/**
 * Represents a node in Gitea's git tree structure
 * Compatible with GitHub API tree object format
 */
export type GiteaTreeNode = {
	path: string,
	mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined
} & (
	| { type: "commit", sha: CommitSha | null }
	| { type: "blob", sha: BlobSha | null }
	| { type: "tree", sha: TreeSha | null }
	| { type: undefined, sha: null }
);

/**
 * Remote vault implementation for Gitea repositories.
 *
 * Uses Octokit with custom baseUrl for Gitea API endpoint.
 * Gitea API is largely compatible with GitHub API v3.
 *
 * Architecture:
 * - Read operations: Fetch tree state from Gitea API
 * - Write operations: Create blobs/trees/commits and update refs
 * - No filtering logic: Caller (Fit) is responsible for filtering paths before calling vault methods
 */
export class RemoteGiteaVault implements IVault<"remote"> {
	private octokit: Octokit;
	private owner: string;
	private repo: string;
	private branch: string;
	private giteaUrl: string;
	private headers: {[k: string]: string};
	private deviceName: string;
	private repoExistsCache: boolean | null = null;

	// Internal cache for remote state optimization
	private latestKnownCommitSha: CommitSha | null = null;
	private latestKnownState: FileStates | null = null;

	constructor(
		giteaUrl: string,
		token: string,
		owner: string,
		repo: string,
		branch: string,
		deviceName: string,
		useHttp: boolean = false
	) {
		// Normalize Gitea URL (remove trailing slash)
		let normalizedUrl = giteaUrl.replace(/\/$/, '');

		// Force HTTP or HTTPS based on useHttp setting
		if (useHttp) {
			// Convert to HTTP if needed
			normalizedUrl = normalizedUrl.replace(/^https:\/\//i, 'http://');
			// Add http:// if no protocol specified
			if (!normalizedUrl.match(/^https?:\/\//i)) {
				normalizedUrl = 'http://' + normalizedUrl;
			}
		} else {
			// Convert to HTTPS if needed (default secure behavior)
			normalizedUrl = normalizedUrl.replace(/^http:\/\//i, 'https://');
			// Add https:// if no protocol specified
			if (!normalizedUrl.match(/^https?:\/\//i)) {
				normalizedUrl = 'https://' + normalizedUrl;
			}
		}

		this.giteaUrl = normalizedUrl;

		// Use Octokit with custom baseUrl for Gitea
		// Gitea requires "token" prefix in Authorization header
		// Use Obsidian's requestUrl as fetch adapter to bypass CORS
		const OctokitWithRetry = Octokit.plugin(retry);
		this.octokit = new OctokitWithRetry({
			auth: `token ${token}`,
			baseUrl: `${this.giteaUrl}/api/v1`,
			request: {
				fetch: createObsidianFetchAdapter()
			}
		});

		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
		this.deviceName = deviceName;

		// Headers to disable API caching
		this.headers = {
			"If-None-Match": ''
		};
	}

	// ===== Accessors =====

	getOwner(): string {
		return this.owner;
	}

	getRepo(): string {
		return this.repo;
	}

	getBranch(): string {
		return this.branch;
	}

	getGiteaUrl(): string {
		return this.giteaUrl;
	}

	// ===== Error Handling =====

	/**
	 * Wrap octokit errors and convert to VaultError for consistent error handling.
	 */
	private async wrapOctokitError(
		error: unknown,
		notFoundStrategy: 'repo' | 'repo-or-branch' | 'ignore'
	): Promise<never> {
		const errorObj = error as { status?: number | null; response?: unknown; message?: string };

		// No status or no response indicates network/connectivity issue
		if (errorObj.status === null || errorObj.status === undefined || !errorObj.response) {
			throw VaultError.network(
				errorObj.message || `Couldn't reach Gitea API at ${this.giteaUrl}`,
				{ originalError: error }
			);
		}

		// 404: Resource not found - handle based on strategy
		if (errorObj.status === 404 && notFoundStrategy !== 'ignore') {
			let detailMessage: string;

			if (notFoundStrategy === 'repo') {
				detailMessage = `Repository '${this.owner}/${this.repo}' not found on ${this.giteaUrl}`;
			} else {
				// repo-or-branch: Try to distinguish
				try {
					detailMessage = await this.checkRepoExists()
						? `Branch '${this.branch}' not found on repository '${this.owner}/${this.repo}'`
						: `Repository '${this.owner}/${this.repo}' not found on ${this.giteaUrl}`;
				} catch (_repoError) {
					// checkRepoExists failed (403, network, etc.) - use generic message
					detailMessage = `Repository '${this.owner}/${this.repo}' or branch '${this.branch}' not found on ${this.giteaUrl}`;
				}
			}

			throw VaultError.remoteNotFound(detailMessage, { originalError: error });
		}

		// 401/403: Authentication/authorization failures
		if (errorObj.status === 401 || errorObj.status === 403) {
			throw VaultError.authentication(
				errorObj.message || 'Authentication failed for Gitea',
				{ originalError: error }
			);
		}

		// Other errors: re-throw as-is
		throw error;
	}

	// ===== Read Operations =====

	/**
	 * Get reference SHA for the current branch.
	 */
	private async getRef(ref: string = `heads/${this.branch}`): Promise<CommitSha> {
		try {
			// Gitea API uses a different endpoint than GitHub for getting refs
			// Extract branch name from ref (e.g., "heads/main" -> "main")
			const branchName = ref.replace(/^heads\//, '');

			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/branches/{branch}`, {
					owner: this.owner,
					repo: this.repo,
					branch: branchName,
					headers: this.headers
				});

			const branchData = response as GiteaBranch;

			// Debug: Log the response structure to understand Gitea's format
			fitLogger.log('[getRef] Got response from Gitea branches endpoint', {
				branch: branchName,
				responseKeys: Object.keys(branchData),
				responseStructure: {
					commit: branchData.commit,
					commitSha: branchData.commit?.sha,
					latestCommit: branchData.latest_commit,
					latestCommitId: branchData.latest_commit?.id
				}
			});

			// Try multiple possible field paths for the commit SHA
			// Path 1: commit.id (Gitea format - THIS IS THE CORRECT ONE FOR GITEA)
			let commitSha = branchData.commit?.id;

			// Path 2: commit.sha (GitHub format)
			if (!commitSha) {
				commitSha = branchData.commit?.sha;
			}

			// Path 3: latest_commit.id (alternative Gitea format)
			if (!commitSha) {
				commitSha = branchData.latest_commit?.id;
			}

			// Path 4: latest_commit.sha (another variant)
			if (!commitSha) {
				commitSha = branchData.latest_commit?.sha;
			}

			// Path 5: commit_id (direct field)
			if (!commitSha) {
				commitSha = branchData.commit_id;
			}

			if (!commitSha) {
				fitLogger.log('[getRef] ERROR: Could not find commit SHA in response', {
					branch: branchName,
					fullResponse: response
				});
				throw new Error(`[getRef] Branch '${branchName}' exists but response has no commit SHA field`);
			}

			fitLogger.log('[getRef] Got commit SHA from Gitea branch endpoint', {
				branch: branchName,
				commitSha: String(commitSha).slice(0, 7)
			});

			return commitSha as CommitSha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Get the latest commit SHA from the current branch.
	 * Returns null if the branch doesn't exist yet (new branch case).
	 */
	private async getLatestCommitSha(): Promise<CommitSha | null> {
		try {
			return await this.getRef(`heads/${this.branch}`);
		} catch (error) {
			const errorObj = error as { status?: number };
			// 404 means the branch doesn't exist yet - this is normal for new branches
			if (errorObj.status === 404) {
				fitLogger.log(`[getLatestCommitSha] Branch '${this.branch}' doesn't exist yet, treating as new branch`);
				return null;
			}
			// Re-throw other errors
			throw error;
		}
	}

	/**
	 * Get full commit data from Gitea API
	 *
	 * Gitea uses GET /repos/{owner}/{repo}/git/commits/{ref} (with /git/ in path)
	 * This is different from GitHub's GET /repos/{owner}/{repo}/commits/{ref}
	 */
	private async getCommit(ref: string) {
		try {
			fitLogger.log('[getCommit] Fetching commit', { ref: ref.slice(0, 7) });

			// Use Gitea's git commits endpoint (with /git/ in the path)
			const {data: commit} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/commits/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					headers: this.headers
				});

			const commitData = commit as GiteaCommitResponse;
			fitLogger.log('[getCommit] Got commit data', {
				ref: ref.slice(0, 7),
				treeId: commitData.tree?.sha
			});

			return commit;
		} catch (error) {
			fitLogger.log('[getCommit] Error fetching commit', {
				ref: ref.slice(0, 7),
				error
			});
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Get tree SHA from a commit
	 *
	 * Handles both GitHub and Gitea response formats:
	 * - GitHub: commit.commit.tree.sha
	 * - Gitea: commit.tree.id or commit.tree.sha
	 */
	private async getCommitTreeSha(ref: CommitSha): Promise<TreeSha> {
		const commit = await this.getCommit(ref);
		const commitData = commit as GiteaCommitResponse;

		// Gitea format: commit.tree.sha
		if (commitData.tree?.sha) {
			return commitData.tree.sha as TreeSha;
		}

		fitLogger.log('[getCommitTreeSha] ERROR: Could not find tree SHA in commit', {
			ref: ref.slice(0, 7),
			commitKeys: Object.keys(commitData),
			commit: commitData
		});

		throw new Error(`[getCommitTreeSha] Could not extract tree SHA from commit ${ref}`);
	}

	/**
	 * Get the git tree for a given tree SHA
	 */
	private async getTree(tree_sha: TreeSha): Promise<GiteaTreeNode[]> {
		try {
			const { data: tree } = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
					owner: this.owner,
					repo: this.repo,
					tree_sha,
					recursive: 'true',
					headers: this.headers
				});
			return tree.tree as GiteaTreeNode[];
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Read file content from Gitea by path.
	 */
	async readFileContent(path: string): Promise<FileContent> {
		if (this.latestKnownState === null) {
			throw new Error(
				`Remote repository state not yet loaded. Cannot read file '${path}'. ` +
				`Sync operation should call readFromSource() first.`
			);
		}

		const blobSha = this.latestKnownState[path];
		if (!blobSha) {
			throw new Error(
				`File '${path}' does not exist in remote repository ` +
				`(commit ${this.latestKnownCommitSha || 'unknown'} on ${this.owner}/${this.repo}).`
			);
		}

		// Fetch blob content from Gitea
		try {
			const { data: blob } = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
					owner: this.owner,
					repo: this.repo,
					file_sha: blobSha,
					headers: this.headers
				});
			return FileContent.fromBase64(blob.content);
		} catch (error) {
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	// ===== Write Operations =====

	/**
	 * Create a blob on Gitea from content
	 */
	private async createBlob(content: string, encoding: string): Promise<BlobSha> {
		try {
			const {data: blob} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/blobs`, {
					owner: this.owner,
					repo: this.repo,
					content,
					encoding,
					headers: this.headers
				});
			return blob.sha as BlobSha;
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a tree node for a file change.
	 */
	private async createTreeNodeFromContent(
		path: string,
		content: FileContent | null,
		currentState: FileStates
	): Promise<GiteaTreeNode | null> {
		let rawContent: string | null = null;
		let encoding: 'base64' | 'utf-8' | undefined;
		if (content !== null) {
			const rawContentObj = content.toRaw();
			rawContent = rawContentObj.content;
			encoding = rawContentObj.encoding === 'base64' ? 'base64' : 'utf-8';
		}

		// Deletion case (content is null)
		if (rawContent === null) {
			if (!(path in currentState)) {
				return null;
			}
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			};
		}

		// Addition/modification case
		if (!encoding) {
			const filePath = FilePath.create(path);
			const extension = FilePath.getExtension(filePath);
			encoding = (extension && isBinaryExtension(extension)) ? "base64" : "utf-8";
		}
		const blobSha = await this.createBlob(rawContent, encoding);

		// Skip if file on remote is identical
		if (currentState[path] === blobSha) {
			return null;
		}

		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		};
	}

	/**
	 * Create a new tree from tree nodes
	 */
	private async createTree(
		treeNodes: GiteaTreeNode[],
		base_tree_sha: TreeSha
	): Promise<TreeSha> {
		try {
			const {data: newTree} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/trees`, {
					owner: this.owner,
					repo: this.repo,
					tree: treeNodes,
					base_tree: base_tree_sha,
					headers: this.headers
				}
			);
			return newTree.sha as TreeSha;
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a commit pointing to a tree
	 */
	private async createCommit(treeSha: TreeSha, parentSha: CommitSha): Promise<CommitSha> {
		const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
		try {
			const { data: createdCommit } = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/commits`, {
					owner: this.owner,
					repo: this.repo,
					message,
					tree: treeSha,
					parents: [parentSha],
					headers: this.headers
				});
			return createdCommit.sha as CommitSha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Update branch reference to point to new commit
	 */
	private async updateRef(sha: string, ref: string = `heads/${this.branch}`): Promise<string> {
		try {
			const { data: updatedRef } = await this.octokit.request(
				`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					sha,
					headers: this.headers
				});
			return updatedRef.object.sha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	// ===== Gitea Utility Operations (not part of IVault) =====

	/**
	 * Get authenticated user information
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /user`, {
					headers: this.headers
				});
			// Gitea uses 'login' field like GitHub
			return {owner: response.login, avatarUrl: response.avatar_url};
		} catch (error) {
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	/**
	 * Get list of repositories owned by authenticated user
	 */
	async getRepos(): Promise<string[]> {
		const allRepos: string[] = [];
		let page = 1;
		const perPage = 100;

		let hasMorePages = true;
		while (hasMorePages) {
			try {
				const { data: response } = await this.octokit.request(
					`GET /user/repos`, {
						headers: this.headers,
						limit: perPage,
						page: page
					}
				);
				allRepos.push(...response.map((r: { name: string }) => r.name));
				if (response.length < perPage) {
					hasMorePages = false;
				}
			} catch (error) {
				return await this.wrapOctokitError(error, 'ignore');
			}

			page++;
		}

		return allRepos;
	}

	/**
	 * Get list of branches for the repository.
	 * Returns empty array for new/empty repositories.
	 */
	async getBranches(): Promise<string[]> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/branches`,
				{
					owner: this.owner,
					repo: this.repo,
					headers: this.headers
				});

			// Debug logging
			fitLogger.log(`[getBranches] Response type: ${typeof response}, isArray: ${Array.isArray(response)}`, { response });

			// Handle case where response might not be an array
			if (!Array.isArray(response)) {
				fitLogger.log(`[getBranches] Response is not an array, returning empty`);
				return [];
			}

			return response.map((r: { name: string }) => r.name);
		} catch (error: unknown) {
			const errorObj = error as { status?: number };

			// 404 on branches usually means the repository is empty (no commits yet)
			// This is normal for a newly created repository
			if (errorObj.status === 404) {
				fitLogger.log('[getBranches] Repository is empty (no branches/commits yet), returning empty array');
				return [];
			}

			// Debug: Log the actual error for other cases
			fitLogger.log('[getBranches] Error caught', {
				error,
				message: error instanceof Error ? error.message : String(error),
				errorType: typeof error
			});
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a new branch
	 *
	 * This method handles two cases:
	 * 1. **Empty repository**: Must create an initial commit first (using CreateFile API),
	 *    then create additional branches via repoCreateBranch.
	 * 2. **Non-empty repository**: Can directly call repoCreateBranch.
	 *
	 * Control flow:
	 * - Check if repo is empty via isRepositoryEmpty()
	 * - If empty and requesting "main" or default branch: create initial commit only
	 * - If empty and requesting another branch: create initial commit first, then branch off from it
	 * - If not empty: use repoCreateBranch directly
	 *
	 * Used when user wants to create a new branch from the settings UI.
	 */
	async createBranch(branchName: string): Promise<void> {
		let defaultBranchName = 'main'; // fallback
		try {
			// Get the default branch to base the new branch on
			defaultBranchName = await this.getDefaultBranch();

			fitLogger.log('[createBranch] Starting branch creation', {
				newBranch: branchName,
				defaultBranch: defaultBranchName
			});

			// Check if repository is empty
			const isEmpty = await this.isRepositoryEmpty();

			if (isEmpty) {
				fitLogger.log('[createBranch] Repository is empty, need to initialize', {
					isEmpty: true,
					newBranch: branchName,
					defaultBranch: defaultBranchName
				});

				// For an empty repo, we need to create an initial commit first
				// Use the default branch (usually "main") for the initial commit
				await this.createInitialCommit(defaultBranchName);

				// If user requested a different branch, create it now (repo is no longer empty)
				if (branchName !== defaultBranchName) {
					fitLogger.log('[createBranch] Creating feature branch from initialized default branch', {
						featureBranch: branchName,
						baseBranch: defaultBranchName
					});

					await this.octokit.request(
						`POST /repos/{owner}/{repo}/branches`,
						{
							owner: this.owner,
							repo: this.repo,
							new_branch_name: branchName,
							old_branch_name: defaultBranchName,
							headers: this.headers
						}
					);

					fitLogger.log(`[createBranch] Successfully created feature branch '${branchName}'`);
				} else {
					fitLogger.log(`[createBranch] Initial commit created on default branch '${defaultBranchName}'`);
				}
			} else {
				// Repository is not empty, use standard repoCreateBranch
				fitLogger.log('[createBranch] Repository is initialized, creating branch directly', {
					newBranch: branchName,
					baseBranch: defaultBranchName
				});

				await this.octokit.request(
					`POST /repos/{owner}/{repo}/branches`,
					{
						owner: this.owner,
						repo: this.repo,
						new_branch_name: branchName,
						old_branch_name: defaultBranchName,
						headers: this.headers
					}
				);

				fitLogger.log(`[createBranch] Successfully created branch '${branchName}'`);
			}
		} catch (error: unknown) {
			const errorObj = error as { status?: number, message?: string };
			fitLogger.log('[createBranch] Error caught', {
				error,
				errorStatus: errorObj.status,
				errorMessage: errorObj.message,
				errorString: String(error)
			});

			if (errorObj.status === 422) {
				// Branch already exists
				fitLogger.log(`[createBranch] Branch '${branchName}' already exists`);
				return;
			}

			if (errorObj.status === 404) {
				// Not found - could be base branch doesn't exist or repo is empty
				const errorMsg = String(errorObj.message).toLowerCase();
				if (errorMsg.includes('empty') || errorMsg.includes('repository')) {
					fitLogger.log('[createBranch] Got 404 with "empty repository" message, will retry with initialization', { error });
					// Retry: assume repo is empty and needs initialization
					try {
						await this.createInitialCommit(defaultBranchName);
						if (branchName !== defaultBranchName) {
							await this.octokit.request(
								`POST /repos/{owner}/{repo}/branches`,
								{
									owner: this.owner,
									repo: this.repo,
									new_branch_name: branchName,
									old_branch_name: defaultBranchName,
									headers: this.headers
								}
							);
						}
						fitLogger.log(`[createBranch] Successfully created branch '${branchName}' after initialization`);
						return;
					} catch (retryError) {
						fitLogger.log('[createBranch] Retry after initialization failed', { retryError });
						throw retryError;
					}
				} else {
					fitLogger.log(`[createBranch] Base branch '${defaultBranchName}' not found`, { error });
					throw new Error(`Cannot create branch: base branch '${defaultBranchName}' not found`);
				}
			}

			throw error;
		}
	}

	/**
	 * Check if repository exists and is accessible
	 */
	private async checkRepoExists(): Promise<boolean> {
		if (this.repoExistsCache !== null) {
			return this.repoExistsCache;
		}

		try {
			await this.octokit.request(`GET /repos/{owner}/{repo}`, {
				owner: this.owner,
				repo: this.repo,
				headers: this.headers
			});
			this.repoExistsCache = true;
			return true;
		} catch (error) {
			const errorObj = error as { status?: number };
			if (errorObj.status === 404) {
				this.repoExistsCache = false;
				return false;
			}
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	/**
	 * Test connection to Gitea server
	 */
	async testConnection(): Promise<{ success: boolean; message: string }> {
		try {
			await this.getUser();
			return { success: true, message: `Successfully connected to ${this.giteaUrl}` };
		} catch (error) {
			if (error instanceof VaultError) {
				return { success: false, message: error.message };
			}
			return { success: false, message: `Failed to connect to ${this.giteaUrl}` };
		}
	}

	/**
	 * Check if repository is empty (has no commits)
	 *
	 * For Gitea 1.25+:
	 * - Checks the `has_code` flag from GET /repos/{owner}/{repo}
	 *
	 * Fallback:
	 * - Tries GET /repos/{owner}/{repo}/branches
	 * - If it returns 404 or empty array, repo is empty
	 * - If it returns a branch with a commit SHA, repo is initialized
	 */
	private async isRepositoryEmpty(): Promise<boolean> {
		try {
			// First, try to get repo metadata which includes has_code (Gitea 1.25+)
			const {data: repoMetadata} = await this.octokit.request(
				`GET /repos/{owner}/{repo}`,
				{
					owner: this.owner,
					repo: this.repo,
					headers: this.headers
				}
			);

			const repoMeta = repoMetadata as GiteaRepository;
			fitLogger.log('[isRepositoryEmpty] Got repo metadata', {
				isEmpty: repoMeta.empty,
				defaultBranch: repoMeta.default_branch
			});

			// Use empty property from Gitea repository
			if (typeof repoMeta.empty === 'boolean') {
				return repoMeta.empty;
			}

			// If neither flag is available, try to get branches as a fallback
			fitLogger.log('[isRepositoryEmpty] Neither has_code nor is_empty available, checking branches');
			try {
				const {data: branches} = await this.octokit.request(
					`GET /repos/{owner}/{repo}/branches`,
					{
						owner: this.owner,
						repo: this.repo,
						headers: this.headers
					}
				);

				if (!Array.isArray(branches) || branches.length === 0) {
					return true;
				}

				// Check if any branch has a commit
				const hasBranchWithCommit = branches.some((b: GiteaBranch) => b.commit && b.commit.sha);
				return !hasBranchWithCommit;
			} catch (branchError) {
				// 404 from branches endpoint usually means empty repo
				const branchErrorObj = branchError as { status?: number };
				if (branchErrorObj.status === 404) {
					return true;
				}
				throw branchError;
			}
		} catch (error) {
			fitLogger.log('[isRepositoryEmpty] Error checking if repo is empty', { error });
			throw error;
		}
	}

	/**
	 * Get default branch name for the repository
	 * Returns the default branch configured on the Gitea server
	 * Most Gitea instances default to "main", some older ones to "master"
	 */
	async getDefaultBranch(): Promise<string> {
		try {
			// Try to get repo info which includes default_branch
			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}`,
				{
					owner: this.owner,
					repo: this.repo,
					headers: this.headers
				});
			const repoData = response as GiteaRepository;
			if (repoData.default_branch) {
				fitLogger.log(`[getDefaultBranch] Got default branch: ${repoData.default_branch}`);
				return repoData.default_branch;
			}
			return 'main'; // Fallback to common default
		} catch (error) {
			fitLogger.log('[getDefaultBranch] Error getting default branch, using fallback', { error });
			// If repo is empty or other error, return common defaults
			return 'main';
		}
	}

	/**
	 * Create an initial commit in an empty repository
	 *
	 * Gitea's repoCreateBranch endpoint cannot work on an empty repo (no base commit).
	 * Instead, we use the CreateFile API which:
	 * - Creates a file in the specified branch
	 * - Implicitly creates that branch (usually "main") if it doesn't exist
	 * - Commits the file as the first commit in the repo
	 *
	 * Endpoint: POST /repos/{owner}/{repo}/contents/{filepath}
	 * Request body:
	 * {
	 *   "content": "<base64-encoded file content>",
	 *   "message": "<commit message>",
	 *   "branch": "main"  // optional, but specify to be explicit
	 * }
	 */
	private async createInitialCommit(branchName: string = 'main'): Promise<void> {
		try {
			fitLogger.log('[createInitialCommit] Starting initial commit', {
				branch: branchName
			});

			// Create a minimal .gitkeep or .obsidian placeholder file
			// Content: "# Initial Obsidian vault commit\n"
			const fileContent = '# Initial Obsidian vault commit\n';
			// Browser-compatible base64 encoding
			const utf8Bytes = new TextEncoder().encode(fileContent);
			const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
			const base64Content = btoa(binaryString);

			// Use the CreateFile API to create the initial file/commit
			// This implicitly creates the branch if it doesn't exist
			const {data: response} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/contents/{filepath}`,
				{
					owner: this.owner,
					repo: this.repo,
					filepath: '.obsidian-init',
					message: 'Initial commit: Initialize Obsidian vault',
					content: base64Content,
					branch: branchName,
					headers: this.headers
				}
			);

			fitLogger.log('[createInitialCommit] Successfully created initial commit', {
				branch: branchName,
				responseKeys: Object.keys(response),
				fullResponse: response
			});
		} catch (error: unknown) {
			const errorObj = error as { status?: number, message?: string };
			fitLogger.log('[createInitialCommit] Error creating initial commit', {
				error,
				errorStatus: errorObj.status,
				errorMessage: errorObj.message
			});
			throw error;
		}
	}

	// ===== IVault Implementation =====

	/**
	 * Apply a batch of changes to remote (creates commit and pushes)
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<ApplyChangesResult<"remote">> {
		const { state: currentState, commitSha: parentCommitSha } = await this.readFromSource();
		const parentTreeSha = await this.getCommitTreeSha(parentCommitSha);

		/**
		 * Gitea-specific implementation: Use CreateFile API for all writes
		 *
		 * Unlike GitHub which supports blob/tree/commit endpoints, Gitea requires
		 * using the CreateFile/UpdateFile API (POST /repos/{owner}/{repo}/contents/{filepath})
		 * for all file operations. This:
		 * - Automatically creates commits
		 * - Supports binary and text files
		 * - Handles both file creation and updates with the same endpoint
		 *
		 * Strategy:
		 * 1. Process all write operations (add/modify files)
		 * 2. Process all delete operations
		 * 3. Track changes and compute SHAs locally
		 */

		const changes: FileChange[] = [];
		const newState: FileStates = { ...currentState };
		const commitMessage = `Sync from ${this.deviceName} on ${new Date().toLocaleString()}`;

		// Process file writes (additions and modifications)
		for (const { path, content } of filesToWrite) {
			try {
				const rawContentObj = content.toRaw();
				const fileContent = rawContentObj.content;
				const encoding = rawContentObj.encoding === 'base64' ? 'base64' : 'utf-8';

				fitLogger.log(`[applyChanges] Writing file: ${path}`, { encoding });

				// Gitea CreateFile API always expects base64-encoded content
				// If content is already base64, use it; otherwise encode it (browser-compatible)
				let base64Content: string;
				if (encoding === 'base64') {
					base64Content = fileContent;
				} else {
					const utf8Bytes = new TextEncoder().encode(fileContent);
					const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
					base64Content = btoa(binaryString);
				}

				// Check if file exists on remote - if so, we need its SHA for update
				const fileExistsOnRemote = path in currentState;
				const requestBody: {
					owner: string;
					repo: string;
					filepath: string;
					message: string;
					content: string;
					branch: string;
					headers: { [k: string]: string };
					sha?: BlobSha;
				} = {
					owner: this.owner,
					repo: this.repo,
					filepath: path,
					message: commitMessage,
					content: base64Content,
					branch: this.branch,
					headers: this.headers
				};

				// If file exists on remote, include SHA for update operation
				if (fileExistsOnRemote) {
					requestBody.sha = currentState[path];
					fitLogger.log(`[applyChanges] File exists on remote, using SHA for update: ${path}`, { sha: currentState[path] });
				}

				// Use CreateFile/UpdateFile API to write file
				// Gitea requires SHA parameter for updates, omit for new files
				// Retry with fresh SHA if concurrent modification detected
				const MAX_RETRIES = 3;
				let retryCount = 0;
				let writeSuccessful = false;

				while (!writeSuccessful && retryCount < MAX_RETRIES) {
					try {
						// Fetch fresh SHA immediately before write to avoid stale state
						if (fileExistsOnRemote && retryCount > 0) {
							fitLogger.log(`[applyChanges] Retry ${retryCount}: Fetching fresh SHA before write: ${path}`);
							try {
								const { data: freshFileInfo } = await this.octokit.request(
									`GET /repos/{owner}/{repo}/contents/{filepath}`,
									{
										owner: this.owner,
										repo: this.repo,
										filepath: path,
										ref: this.branch,
										headers: this.headers
									}
								);
								requestBody.sha = freshFileInfo.sha;
								fitLogger.log(`[applyChanges] Updated to fresh SHA: ${freshFileInfo.sha}`);
							} catch (_fetchError) {
								fitLogger.log(`[applyChanges] Failed to fetch fresh SHA, using existing: ${path}`);
							}
						}

						await this.octokit.request(
							`POST /repos/{owner}/{repo}/contents/{filepath}`,
							requestBody
						);
						writeSuccessful = true;
					} catch (error: unknown) {
						const errorObj = error as { message?: string; status?: number; [key: string]: unknown };
						// Log full error structure for debugging
						fitLogger.log(`[applyChanges] Error writing file (attempt ${retryCount + 1}): ${path}`, {
							errorMessage: errorObj.message,
							errorString: String(error),
							errorStatus: errorObj.status,
							errorKeys: Object.keys(errorObj || {})
						});

						// Handle the case where file exists but we don't have its SHA
						// This happens when another device modified the file since our last fetch
						// Perform 3-way merge to resolve the conflict automatically
						const errorString = String(error).toLowerCase();
						const errorMessage = (error.message || '').toLowerCase();
						const isFileExistsError = error.status === 422 &&
							(errorString.includes('file already exists') ||
							 errorString.includes('repository file already exists') ||
							 errorMessage.includes('file already exists') ||
							 errorMessage.includes('repository file already exists'));

						if (isFileExistsError) {
							fitLogger.log(`[applyChanges] CONFLICT DETECTED: Attempting 3-way merge for: ${path}`, {
								errorStatus: error.status,
								attempt: retryCount + 1
							});

							try {
								// Fetch current remote version with FRESH state (not cached)
								const { data: remoteFileInfo } = await this.octokit.request(
									`GET /repos/{owner}/{repo}/contents/{filepath}`,
									{
										owner: this.owner,
										repo: this.repo,
										filepath: path,
										ref: this.branch,
										headers: this.headers
									}
								);

								fitLogger.log(`[applyChanges] Fetched remote file info for merge: ${path}`, {
									remoteSha: remoteFileInfo.sha,
									oldSha: requestBody.sha
								});

								// Fetch base version using the old SHA we had in our state
								// This represents the common ancestor between local and remote
								let baseContent = '';
								try {
									if (requestBody.sha) {
										// Use Git blob API to fetch content by SHA directly
										const { data: baseBlob } = await this.octokit.request(
											`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`,
											{
												owner: this.owner,
												repo: this.repo,
												file_sha: requestBody.sha,
												headers: this.headers
											}
										);
										// Blob content is always base64-encoded
										baseContent = atob(baseBlob.content || '');
										fitLogger.log(`[applyChanges] Fetched base content using blob SHA: ${requestBody.sha}`);
									} else {
										// File didn't exist in our state - use empty base
										fitLogger.log(`[applyChanges] No old SHA available, using empty base: ${path}`);
										baseContent = '';
									}
								} catch (baseError: unknown) {
									const baseErrorObj = baseError as { message?: string };
									// File didn't exist in base or fetch failed - use empty string
									fitLogger.log(`[applyChanges] Failed to fetch base content, using empty base: ${path}`, {
										error: baseErrorObj.message
									});
									baseContent = '';
								}

								// Decode remote and local content
								const remoteContent = atob(remoteFileInfo.content || '');
								const localContent = encoding === 'base64' ? atob(fileContent) : fileContent;

								fitLogger.log(`[applyChanges] Content comparison for merge: ${path}`, {
									remoteLength: remoteContent.length,
									localLength: localContent.length,
									baseLength: baseContent.length,
									remotePreview: remoteContent.substring(0, 100),
									localPreview: localContent.substring(0, 100),
									identical: remoteContent === localContent
								});

								// If remote and local are identical, no merge needed - just skip
								if (remoteContent === localContent) {
									fitLogger.log(`[applyChanges] Remote and local content identical, skipping merge: ${path}`);
									writeSuccessful = true;
									break; // Exit retry loop - nothing to do
								}

								// Check if file is binary - skip merge for binary files
								const extension = path.split('.').pop() || '';
								if (isBinaryExtension(extension)) {
									fitLogger.log(`[applyChanges] Binary file conflict - cannot auto-merge: ${path}`);
									const conflictError: Error & { status?: number; path?: string } = new Error(
										`Binary file conflict: "${path}" was modified on both devices. Cannot auto-merge binary files.`
									);
									conflictError.status = 409;
									conflictError.path = path;
									throw conflictError;
								}

								// Perform 3-way merge
								const mergeResult = merge3Way(baseContent, localContent, remoteContent);

								fitLogger.log(`[applyChanges] 3-way merge result for ${path}:`, {
									success: mergeResult.success,
									conflictCount: mergeResult.conflictCount
								});

								// Encode merged content back to base64
								const mergedUtf8Bytes = new TextEncoder().encode(mergeResult.content);
								const mergedBinaryString = Array.from(mergedUtf8Bytes, byte => String.fromCharCode(byte)).join('');
								const mergedBase64 = btoa(mergedBinaryString);

								// Update the file with merged content, using FRESH remote SHA
								requestBody.sha = remoteFileInfo.sha;
								requestBody.content = mergedBase64;

								if (!mergeResult.success) {
									requestBody.message = `${commitMessage} [AUTO-MERGED WITH CONFLICTS - ${mergeResult.conflictCount} conflict(s)]`;
								} else {
									requestBody.message = `${commitMessage} [AUTO-MERGED]`;
								}

								fitLogger.log(`[applyChanges] Pushing merged content for: ${path}`, {
									hadConflicts: !mergeResult.success,
									conflictCount: mergeResult.conflictCount,
									usingSha: requestBody.sha,
									contentLength: mergedBase64.length
								});

								// Push merged content directly (use PUT for updates, not POST)
								await this.octokit.request(
									`PUT /repos/{owner}/{repo}/contents/{filepath}`,
									requestBody
								);

								fitLogger.log(`[applyChanges] Successfully pushed merged file: ${path}`, {
									autoMerged: true,
									hadConflicts: !mergeResult.success
								});

								writeSuccessful = true;
								break; // Exit the retry loop - merge was successful

							} catch (mergeError) {
								fitLogger.log(`[applyChanges] Failed to perform 3-way merge: ${path}`, { error: mergeError });
								throw mergeError;
							}
						} else {
							// Not a file exists error - throw it
							throw error;
						}
					}
				}

				if (!writeSuccessful) {
					throw new Error(`Failed to write ${path} after ${MAX_RETRIES} attempts due to concurrent modifications`);
				}

				// Compute SHA locally for state tracking
				const sha = await computeSha1(fileContent) as BlobSha;

				// Skip if identical to remote state
				if (currentState[path] !== sha) {
					if (path in currentState) {
						changes.push({ path, type: "MODIFIED" });
					} else {
						changes.push({ path, type: "ADDED" });
					}
					newState[path] = sha;
				}

				fitLogger.log(`[applyChanges] Successfully wrote: ${path}`, { sha });
			} catch (error) {
				fitLogger.log(`[applyChanges] Error writing file: ${path}`, { error });
				throw error;
			}
		}

		// Process file deletions
		for (const path of filesToDelete) {
			try {
				if (!(path in currentState)) {
					continue; // File doesn't exist on remote, skip
				}

				const fileSha = currentState[path];
				fitLogger.log(`[applyChanges] Deleting file: ${path}`, { sha: fileSha });

				// Gitea requires the file's SHA to delete it
				await this.octokit.request(
					`DELETE /repos/{owner}/{repo}/contents/{filepath}`,
					{
						owner: this.owner,
						repo: this.repo,
						filepath: path,
						message: commitMessage,
						sha: fileSha,
						branch: this.branch,
						headers: this.headers
					}
				);

				changes.push({ path, type: "REMOVED" });
				delete newState[path];

				fitLogger.log(`[applyChanges] Successfully deleted: ${path}`);
			} catch (error) {
				fitLogger.log(`[applyChanges] Error deleting file: ${path}`, { error });
				throw error;
			}
		}

		// If no changes were made, return early
		if (changes.length === 0) {
			return {
				changes: [],
				commitSha: parentCommitSha,
				treeSha: parentTreeSha,
				newState: currentState
			};
		}

		// Get the updated commit SHA after changes
		const newCommitSha = await this.getLatestCommitSha();
		if (newCommitSha === null) {
			throw new Error('Failed to get commit SHA after applying changes');
		}

		const newTreeSha = await this.getCommitTreeSha(newCommitSha);

		// Update internal cache
		this.latestKnownCommitSha = newCommitSha;
		this.latestKnownState = newState;

		fitLogger.log(`[applyChanges] Completed`, {
			changesCount: changes.length,
			newCommitSha: newCommitSha.slice(0, 7),
			newTreeSha: newTreeSha.slice(0, 7)
		});

		return {
			changes,
			commitSha: newCommitSha,
			treeSha: newTreeSha,
			newState
		};
	}

	// ===== Metadata =====

	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Fetch tree from Gitea at the latest commit and return it with commit SHA.
	 */
	async readFromSource(): Promise<VaultReadResult<"remote">> {
		const commitSha = await this.getLatestCommitSha();

		// Handle new branch case - branch doesn't exist yet
		if (commitSha === null) {
			fitLogger.log(`.... 📦 [RemoteGiteaVault] New branch '${this.branch}' - treating as empty state`);
			// For new branches, return an empty state with a fake SHA
			// This allows the first sync to push initial content
			return { state: {}, commitSha: '0000000000000000000000000000000000000000' as CommitSha };
		}

		if (commitSha === this.latestKnownCommitSha && this.latestKnownState !== null) {
			fitLogger.log(`.... 📦 [RemoteGiteaVault] Using cached state (${commitSha.slice(0, 7)})`);
			return { state: { ...this.latestKnownState }, commitSha };
		}

		if (this.latestKnownCommitSha === null) {
			fitLogger.log(`.... ⬇️ [RemoteGiteaVault] Fetching initial state from Gitea (${commitSha.slice(0, 7)})...`);
		} else {
			fitLogger.log(`.... ⬇️ [RemoteGiteaVault] New commit detected (${commitSha.slice(0, 7)}), fetching tree...`);
		}

		const treeSha = await this.getCommitTreeSha(commitSha);
		const newState = await withSlowOperationMonitoring(
			this.buildStateFromTree(treeSha),
			`Remote vault tree fetch from Gitea`,
			{ warnAfterMs: 10000 }
		);

		detectNormalizationIssues(Object.keys(newState), `remote (Gitea at ${this.giteaUrl})`);

		this.latestKnownCommitSha = commitSha;
		this.latestKnownState = newState;

		return { state: { ...newState }, commitSha };
	}

	/**
	 * Build FileStates from a tree SHA.
	 */
	private async buildStateFromTree(treeSha: TreeSha): Promise<FileStates> {
		const remoteTree: GiteaTreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		const state: FileStates = {};
		for (const node of remoteTree) {
			if (node.type === "blob" && node.path && node.sha) {
				state[node.path] = node.sha;
			}
		}
		return state;
	}
}
