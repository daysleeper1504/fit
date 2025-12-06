/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores, FitSettings } from "main";
import { FileChange, FileClash, FileStates, compareFileStates } from "./util/changeTracking";
import { Vault } from "obsidian";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { RemoteGiteaVault } from "./remoteGiteaVault";
import { IVault } from "./vault";
import { fitLogger } from "./logger";
import { CommitSha } from "./util/hashing";

/**
 * Coordinator for local vault and remote repository access with sync state management.
 *
 * Bridges two vault implementations:
 * - **LocalVault**: Obsidian vault file operations
 * - **RemoteGitHubVault** or **RemoteGiteaVault**: Remote repository operations
 *
 * Maintains sync state for efficient change detection.
 * All vault operations throw VaultError on failure (network, auth, remote not found).
 *
 * @see FitSync - The high-level orchestrator that coordinates sync operations
 * @see LocalVault - Local Obsidian vault file operations
 * @see RemoteGitHubVault - Remote GitHub repository operations
 * @see RemoteGiteaVault - Remote Gitea repository operations
 */
export class Fit {
	// TODO: Rename these for clarity: localFileShas, remoteCommitSha, remoteFileShas
	localSha: FileStates;                   // Cache of local file SHAs
	lastFetchedCommitSha: CommitSha | null; // Last synced commit SHA
	lastFetchedRemoteSha: FileStates;       // Cache of remote file SHAs
	localVault: LocalVault;                 // Local vault (tracks local file state)
	remoteVault: IVault<"remote">;          // Remote vault (GitHub or Gitea)


	constructor(setting: FitSettings, localStores: LocalStores, vault: Vault) {
		this.localVault = new LocalVault(vault);
		this.loadSettings(setting);  // NOTE: creates this.remoteVault
		this.loadLocalStore(localStores);
	}

	loadSettings(setting: FitSettings) {
		// Recreate remoteVault with new settings based on provider selection
		// This is called when user changes settings in UI
		if (setting.provider === "gitea") {
			this.remoteVault = new RemoteGiteaVault(
				setting.giteaUrl,
				setting.giteaToken,
				setting.giteaOwner,
				setting.giteaRepo,
				setting.giteaBranch,
				setting.deviceName,
				setting.giteaUseHttp
			);
		} else {
			// Default to GitHub
			this.remoteVault = new RemoteGitHubVault(
				setting.pat,
				setting.owner,
				setting.repo,
				setting.branch,
				setting.deviceName
			);
		}
	}

	loadLocalStore(localStore: LocalStores) {
		this.localSha = localStore.localSha;
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha;
		// Detect potentially corrupted/suspicious cache states
		const localCount = Object.keys(this.localSha).length;
		const remoteCount = Object.keys(this.lastFetchedRemoteSha).length;
		const warnings: string[] = [];

		// Warn if caches are empty but commit SHA exists (possible cache corruption)
		if (localCount === 0 && remoteCount === 0 && this.lastFetchedCommitSha) {
			warnings.push('Empty SHA caches but commit SHA exists - possible cache corruption or first sync after data loss');
		}

		// Warn if local cache is empty but remote cache has files (asymmetric state)
		if (localCount === 0 && remoteCount > 0) {
			warnings.push('Local SHA cache empty but remote cache has files - may incorrectly pull files as "new" that were deleted locally');
		}

		// Log SHA cache provenance for debugging
		fitLogger.log('[Fit] SHA caches loaded from storage', {
			source: 'plugin data.json',
			localShaCount: localCount,
			remoteShaCount: remoteCount,
			lastCommit: this.lastFetchedCommitSha,
			...(warnings.length > 0 && { warnings })
		});
	}

	/**
	 * Check if a file path should be included in sync operations.
	 *
	 * Excludes paths based on sync policy:
	 * - `_fit/`: Conflict resolution directory (written locally but not synced)
	 * - `.obsidian/`: Obsidian workspace settings and plugin code
	 * - `.obsidian-init`: Bootstrap file created during initial repo commit (Gitea-specific)
	 *
	 * Future: Will also respect .gitignore patterns when implemented.
	 *
	 * Note: This is sync policy, not a storage limitation. Both LocalVault and
	 * RemoteGitHubVault can read/write these paths - we choose not to sync them.
	 *
	 * @param path - File path to check
	 * @returns true if path should be included in sync
	 */
	shouldSyncPath(path: string): boolean {
		// Exclude _fit/ directory (conflict resolution area)
		if (path.startsWith("_fit/")) {
			return false;
		}

		// Exclude .obsidian/ directory (Obsidian workspace settings and plugins)
		if (path.startsWith(".obsidian/")) {
			return false;
		}

		// Exclude .obsidian-init file (bootstrap file created during initial repo commit)
		// This file is only needed to initialize empty Gitea repos and should not be synced
		if (path === ".obsidian-init") {
			return false;
		}

		return true;
	}

	/**
	 * Filter a FileState to include only paths that should be synced.
	 * Used when updating LocalStores to ensure excluded paths (like _fit/) aren't tracked.
	 *
	 * @param state - Complete file state from vault
	 * @returns Filtered state containing only synced paths
	 */
	filterSyncedState(state: FileStates): FileStates {
		const filtered: FileStates = {};
		for (const [path, sha] of Object.entries(state)) {
			if (this.shouldSyncPath(path)) {
				filtered[path] = sha;
			}
		}
		return filtered;
	}

	async getLocalChanges(): Promise<{changes: FileChange[], state: FileStates}> {
		const readResult = await this.localVault.readFromSource();
		const currentState = readResult.state;
		const changes = compareFileStates(currentState, this.localSha);
		return { changes, state: currentState };
	}

	/**
	 * Get remote changes since last sync.
	 *
	 * Uses remote vault's internal caching - vault will only fetch from remote
	 * if the latest commit SHA differs from its cached commit SHA.
	 *
	 * @returns Remote changes, current state, and the commit SHA of the fetched state
	 */
	async getRemoteChanges(): Promise<{changes: FileChange[], state: FileStates, commitSha: CommitSha}> {
		fitLogger.log('.. ☁️ [RemoteVault] Fetching from remote...');
		const { state, commitSha } = await this.remoteVault.readFromSource();
		if (!commitSha) {
			throw new Error("Expected remote vault to provide commitSha");
		}
		const allChanges = compareFileStates(state, this.lastFetchedRemoteSha);

		// Filter out changes to files that should not be synced
		// This excludes bootstrap files (_fit/, .obsidian/, .obsidian-init) and untrackable paths
		const changes = allChanges.filter(change => this.shouldSyncPath(change.path));

		// Diagnostic logging for tracking remote cache state
		if (allChanges.length > 0) {
			fitLogger.log('[Fit] Remote changes detected', {
				ADDED: allChanges.filter(c => c.type === 'ADDED').length,
				MODIFIED: allChanges.filter(c => c.type === 'MODIFIED').length,
				REMOVED: allChanges.filter(c => c.type === 'REMOVED').length,
				total: allChanges.length,
				...(changes.length < allChanges.length && {
					filtered: {
						excluded: allChanges.length - changes.length,
						ADDED: allChanges.filter(c => c.type === 'ADDED' && !this.shouldSyncPath(c.path)).length,
						MODIFIED: allChanges.filter(c => c.type === 'MODIFIED' && !this.shouldSyncPath(c.path)).length,
						REMOVED: allChanges.filter(c => c.type === 'REMOVED' && !this.shouldSyncPath(c.path)).length
					}
				})
			});
		}

		return { changes, state, commitSha };
	}

	getClashedChanges(localChanges: FileChange[], remoteChanges:FileChange[]): Array<FileClash> {
		const clashes: Array<FileClash> = [];

		// Step 1: Filter out remote changes to untracked/unsynced paths and treat as clashes.
		const trackedRemoteChanges: FileChange[] = [];

		for (const remoteChange of remoteChanges) {
			if (this.shouldSyncPath(remoteChange.path) && this.localVault.shouldTrackState(remoteChange.path)) {
				trackedRemoteChanges.push(remoteChange);
			} else {
				clashes.push({
					path: remoteChange.path,
					localState: 'untracked',
					remoteOp: remoteChange.type
				});
			}
		}

		// Step 2: Find tracked paths that changed on both sides
		const localChangesByPath = new Map(localChanges.map(lc => [lc.path, lc.type]));

		for (const remoteChange of trackedRemoteChanges) {
			const localState = localChangesByPath.get(remoteChange.path);
			if (localState !== undefined) {
				// Both sides changed this tracked path
				clashes.push({
					path: remoteChange.path,
					localState,
					remoteOp: remoteChange.type
				});
			}
		}

		return clashes;
	}

	/**
	 * Get authenticated user info from remote provider.
	 * Delegates to remote vault (throws VaultError on failure).
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		if (this.remoteVault instanceof RemoteGitHubVault || this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.getUser();
		}
		throw new Error("Remote vault doesn't support getUser()");
	}

	/**
	 * List repositories owned by authenticated user.
	 * Delegates to remote vault (throws VaultError on failure).
	 */
	async getRepos(): Promise<string[]> {
		if (this.remoteVault instanceof RemoteGitHubVault || this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.getRepos();
		}
		throw new Error("Remote vault doesn't support getRepos()");
	}

	/**
	 * List branches in repository.
	 * Delegates to remote vault (throws VaultError on failure).
	 */
	async getBranches(): Promise<string[]> {
		if (this.remoteVault instanceof RemoteGitHubVault || this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.getBranches();
		}
		throw new Error("Remote vault doesn't support getBranches()");
	}

	/**
	 * Get default branch name for the repository.
	 * Delegates to remote vault (throws VaultError on failure).
	 */
	async getDefaultBranch(): Promise<string> {
		if (this.remoteVault instanceof RemoteGitHubVault || this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.getDefaultBranch();
		}
		throw new Error("Remote vault doesn't support getDefaultBranch()");
	}

	/**
	 * Test connection to remote provider.
	 * Only available for Gitea provider.
	 */
	async testConnection(): Promise<{ success: boolean; message: string }> {
		if (this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.testConnection();
		}
		// GitHub doesn't have a dedicated test connection method, use getUser instead
		if (this.remoteVault instanceof RemoteGitHubVault) {
			try {
				await this.remoteVault.getUser();
				return { success: true, message: "Successfully connected to GitHub" };
			} catch (error) {
				return { success: false, message: error instanceof Error ? error.message : "Connection failed" };
			}
		}
		throw new Error("Remote vault doesn't support testConnection()");
	}

	/**
	 * Create a new branch on the remote
	 * Delegates to remote vault (throws VaultError on failure).
	 */
	async createBranch(branchName: string): Promise<void> {
		if (this.remoteVault instanceof RemoteGitHubVault || this.remoteVault instanceof RemoteGiteaVault) {
			return await this.remoteVault.createBranch(branchName);
		}
		throw new Error("Remote vault doesn't support createBranch()");
	}
}
