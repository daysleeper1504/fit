/**
 * Type definitions for Gitea API responses
 *
 * These types are based on Gitea API v1 documentation:
 * https://try.gitea.io/api/swagger
 */

import { BlobSha, CommitSha, TreeSha } from "../util/hashing";

/**
 * Gitea user object from /user endpoint
 */
export interface GiteaUser {
	id: number;
	login: string;
	full_name?: string;
	email?: string;
	avatar_url: string;
	username: string;
	[key: string]: unknown; // Allow additional fields
}

/**
 * Gitea repository object
 */
export interface GiteaRepository {
	id: number;
	name: string;
	full_name: string;
	owner: GiteaUser;
	private: boolean;
	description?: string;
	empty: boolean;
	fork: boolean;
	default_branch: string;
	[key: string]: unknown;
}

/**
 * Gitea commit object (used in branch responses)
 */
export interface GiteaCommit {
	id: CommitSha;
	sha?: CommitSha; // Some endpoints use 'sha' instead of 'id'
	url?: string;
	[key: string]: unknown;
}

/**
 * Gitea branch object from /repos/{owner}/{repo}/branches/{branch}
 */
export interface GiteaBranch {
	name: string;
	commit: GiteaCommit;
	latest_commit?: GiteaCommit; // Alternative field name in some Gitea versions
	commit_id?: CommitSha; // Direct commit SHA field in some versions
	protected: boolean;
	[key: string]: unknown;
}

/**
 * Gitea tree node (blob, tree, or commit)
 */
export interface GiteaTreeEntry {
	path: string;
	mode: "100644" | "100755" | "040000" | "160000" | "120000";
	type: "blob" | "tree" | "commit";
	sha: BlobSha | TreeSha | CommitSha;
	size?: number;
	url?: string;
}

/**
 * Gitea tree response from /repos/{owner}/{repo}/git/trees/{sha}
 */
export interface GiteaTree {
	sha: TreeSha;
	url: string;
	tree: GiteaTreeEntry[];
	truncated: boolean;
	page?: number;
	total_count?: number;
}

/**
 * Gitea blob response from /repos/{owner}/{repo}/git/blobs/{sha}
 */
export interface GiteaBlob {
	content: string;
	encoding: "base64" | "utf-8";
	url?: string;
	sha: BlobSha;
	size: number;
}

/**
 * Gitea file content response from /repos/{owner}/{repo}/contents/{filepath}
 */
export interface GiteaFileContent {
	type: "file" | "dir" | "symlink" | "submodule";
	encoding?: "base64";
	size: number;
	name: string;
	path: string;
	content?: string;
	sha: BlobSha;
	url?: string;
	git_url?: string;
	html_url?: string;
	download_url?: string;
	[key: string]: unknown;
}

/**
 * Request body for creating/updating files
 */
export interface GiteaFileUpdateRequest {
	owner: string;
	repo: string;
	filepath: string;
	content: string;
	message: string;
	branch?: string;
	sha?: BlobSha; // Required for updates
	author?: {
		name: string;
		email: string;
	};
	committer?: {
		name: string;
		email: string;
	};
	dates?: {
		author?: string;
		committer?: string;
	};
	new_branch?: string;
	[key: string]: unknown;
}

/**
 * Request body for deleting files
 */
export interface GiteaFileDeleteRequest {
	owner: string;
	repo: string;
	filepath: string;
	message: string;
	sha: BlobSha;
	branch?: string;
	author?: {
		name: string;
		email: string;
	};
	committer?: {
		name: string;
		email: string;
	};
	dates?: {
		author?: string;
		committer?: string;
	};
	[key: string]: unknown;
}

/**
 * Request body for creating a tree
 */
export interface GiteaCreateTreeRequest {
	owner: string;
	repo: string;
	tree: Array<{
		path: string;
		mode: "100644" | "100755" | "040000" | "160000" | "120000";
		type: "blob" | "tree" | "commit";
		sha?: BlobSha | TreeSha;
		content?: string;
	}>;
	base_tree?: TreeSha;
	[key: string]: unknown;
}

/**
 * Request body for creating a commit
 */
export interface GiteaCreateCommitRequest {
	owner: string;
	repo: string;
	message: string;
	tree: TreeSha;
	parents?: CommitSha[];
	author?: {
		name: string;
		email: string;
		date?: string;
	};
	committer?: {
		name: string;
		email: string;
		date?: string;
	};
	signature?: {
		signature: string;
		payload: string;
	};
	[key: string]: unknown;
}

/**
 * Gitea commit creation response
 */
export interface GiteaCommitResponse {
	sha: CommitSha;
	url: string;
	author?: {
		name: string;
		email: string;
		date: string;
	};
	committer?: {
		name: string;
		email: string;
		date: string;
	};
	message: string;
	tree: {
		sha: TreeSha;
		url: string;
	};
	parents?: Array<{
		sha: CommitSha;
		url: string;
	}>;
	[key: string]: unknown;
}

/**
 * Request body for updating a reference (branch)
 */
export interface GiteaUpdateRefRequest {
	owner: string;
	repo: string;
	ref: string;
	sha: CommitSha;
	force?: boolean;
	[key: string]: unknown;
}

/**
 * Gitea reference object
 */
export interface GiteaReference {
	ref: string;
	url: string;
	object: {
		type: string;
		sha: CommitSha;
		url: string;
	};
	[key: string]: unknown;
}

/**
 * Gitea blob creation request
 */
export interface GiteaCreateBlobRequest {
	owner: string;
	repo: string;
	content: string;
	encoding?: "base64" | "utf-8";
	[key: string]: unknown;
}

/**
 * Gitea blob creation response
 */
export interface GiteaBlobResponse {
	sha: BlobSha;
	url: string;
}
