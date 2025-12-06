/**
 * Obsidian Fetch Adapter
 *
 * Wraps Obsidian's requestUrl API to work as a fetch adapter for Octokit.
 * This bypasses CORS restrictions entirely, allowing communication with
 * self-hosted Gitea/GitHub instances from the app://obsidian.md origin.
 *
 * Usage:
 *   import { createObsidianFetchAdapter } from './util/obsidianFetchAdapter';
 *
 *   const OctokitWithRetry = Octokit.plugin(retry);
 *   const octokit = new OctokitWithRetry({
 *       auth: `token ${token}`,
 *       baseUrl: `${url}/api/v1`,
 *       request: {
 *           fetch: createObsidianFetchAdapter()
 *       }
 *   });
 */

import { requestUrl } from 'obsidian';

export interface FetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | null;
	[key: string]: unknown;
}

export interface FetchResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: Headers;
	json(): Promise<unknown>;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	blob(): Promise<Blob>;
}

/**
 * Creates a fetch adapter compatible with Octokit's request.fetch option.
 * Uses Obsidian's requestUrl API which bypasses CORS entirely.
 */
export function createObsidianFetchAdapter() {
	return async (url: string, options: FetchOptions): Promise<FetchResponse> => {
		try {
			const response = await requestUrl({
				url: url,
				method: options.method || 'GET',
				headers: options.headers || {},
				body: options.body || undefined,
				throw: false // We handle errors manually
			});

			// Debug: Log response structure for troubleshooting
			if (!response) {
				throw new Error(`requestUrl returned null/undefined for ${url}`);
			}

			// Create a Headers object from the response headers
			const headers = new Headers();
			if (response.headers && typeof response.headers === 'object') {
				for (const [key, value] of Object.entries(response.headers)) {
					if (typeof value === 'string') {
						headers.append(key, value);
					}
				}
			}

			// Determine if response is ok (2xx status)
			const ok = response.status >= 200 && response.status < 300;

			// Handle response.text which might be a property or the whole response could be the text
			// Obsidian's requestUrl returns { status, text, headers } structure
			let textContent = '';
			if (typeof response.text === 'string') {
				textContent = response.text;
			} else if (typeof response.text === 'object' && response.text !== null) {
				// Sometimes response.text might be parsed JSON already
				textContent = JSON.stringify(response.text);
			}

			// Create the response object that matches the fetch API
			return {
				ok: ok,
				status: response.status,
				statusText: response.status >= 200 && response.status < 300 ? 'OK' : 'Error',
				headers: headers,

				// Parse response as JSON
				json: async () => {
					// Handle empty responses - return empty array for array endpoints, empty object for others
					if (!textContent) {
						// Check if this looks like an array endpoint (branches, repos, etc.)
						if (url.includes('/branches') || url.includes('/repos') ||
							url.includes('/user/repos') || url.includes('?page=')) {
							return [];
						}
						return {};
					}
					try {
						return JSON.parse(textContent);
					} catch (_e) {
						// If JSON parsing fails, log the error but don't throw
						// This helps Octokit handle malformed responses gracefully
						console.error(`Failed to parse JSON response from ${url}: ${textContent}`);
						if (url.includes('/branches') || url.includes('/repos') ||
							url.includes('/user/repos')) {
							return [];
						}
						return {};
					}
				},

				// Return response as text
				text: async () => textContent,

				// Return response as ArrayBuffer
				arrayBuffer: async () => {
					if (!textContent) {
						return new ArrayBuffer(0);
					}
					// Convert string to ArrayBuffer
					const encoder = new TextEncoder();
					return encoder.encode(textContent).buffer;
				},

				// Return response as Blob
				blob: async () => {
					return new Blob([textContent], { type: response.headers?.['content-type'] || 'application/octet-stream' });
				}
			};
		} catch (error) {
			// Network or other errors
			const errorMessage = error instanceof Error ? error.message : String(error);
			throw new Error(`Obsidian requestUrl failed: ${errorMessage}`);
		}
	};
}
