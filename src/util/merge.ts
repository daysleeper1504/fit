/**
 * 3-Way Merge Utility
 *
 * Implements Git-like 3-way merge algorithm for automatic conflict resolution.
 *
 * Algorithm:
 * 1. Split all three versions (base, local, remote) into lines
 * 2. For each line, compare base→local and base→remote changes
 * 3. If only one side changed: auto-merge that change
 * 4. If both sides changed differently: mark as conflict
 * 5. If both sides changed identically: use the change
 */

export type MergeResult = {
	/** True if merge was successful without conflicts */
	success: boolean;
	/** Merged content (may contain conflict markers if !success) */
	content: string;
	/** Number of conflicts found */
	conflictCount: number;
	/** Paths of conflicting sections (for logging) */
	conflicts: Array<{ lineStart: number; lineEnd: number }>;
};

/**
 * Perform a 3-way merge on text content
 *
 * @param base - Common ancestor content
 * @param local - Local version (current device)
 * @param remote - Remote version (other device)
 * @returns Merge result with merged content and conflict information
 */
export function merge3Way(base: string, local: string, remote: string): MergeResult {
	const baseLines = splitLines(base);
	const localLines = splitLines(local);
	const remoteLines = splitLines(remote);

	// Use Myers diff algorithm (simplified version)
	const localDiff = computeDiff(baseLines, localLines);
	const remoteDiff = computeDiff(baseLines, remoteLines);

	const result: string[] = [];
	const conflicts: Array<{ lineStart: number; lineEnd: number }> = [];
	let baseIndex = 0;

	// Merge changes from both sides
	// Process until we've covered all changes, which may extend beyond base length
	// For insertions at the end, baseEnd equals baseLines.length, so we need to process that index too
	const maxBaseIndex = Math.max(
		baseLines.length,
		...localDiff.map(c => c.baseEnd),
		...remoteDiff.map(c => c.baseEnd)
	);

	while (baseIndex <= maxBaseIndex) {
		const localChange = findChangeAtLine(localDiff, baseIndex);
		const remoteChange = findChangeAtLine(remoteDiff, baseIndex);

		if (!localChange && !remoteChange) {
			// No changes on either side - keep base (if it exists)
			if (baseIndex < baseLines.length) {
				result.push(baseLines[baseIndex]);
			}
			baseIndex++;
		} else if (localChange && !remoteChange) {
			// Only local changed - use local
			applyChange(result, localChange, localLines);
			baseIndex = localChange.baseEnd;
			// If it's an insertion and baseEnd == baseIndex, we need to process the base line too
			if (localChange.baseStart === localChange.baseEnd && baseIndex < baseLines.length) {
				result.push(baseLines[baseIndex]);
				baseIndex++;
			}
		} else if (remoteChange && !localChange) {
			// Only remote changed - use remote
			applyChange(result, remoteChange, remoteLines);
			// For insertions (baseStart == baseEnd), don't advance baseIndex
			// This allows the next iteration to process the base line at this position
			baseIndex = remoteChange.baseEnd;
			// If it's an insertion and baseEnd == baseIndex, we need to process the base line too
			if (remoteChange.baseStart === remoteChange.baseEnd && baseIndex < baseLines.length) {
				result.push(baseLines[baseIndex]);
				baseIndex++;
			}
		} else if (localChange && remoteChange) {
			// Both have changes at this position
			// Check if changes overlap or are separate
			const changesOverlap = !(localChange.baseEnd <= remoteChange.baseStart ||
			                          remoteChange.baseEnd <= localChange.baseStart);

			if (changesOverlap) {
				// Overlapping changes - check if identical
				const localContent = getLinesFromChange(localChange, localLines);
				const remoteContent = getLinesFromChange(remoteChange, remoteLines);

				if (arraysEqual(localContent, remoteContent)) {
					// Both made the same change - use it
					applyChange(result, localChange, localLines);
				} else {
					// Different changes - CONFLICT
					const conflictStart = result.length;
					result.push('<<<<<<< LOCAL');
					applyChange(result, localChange, localLines);
					result.push('=======');
					applyChange(result, remoteChange, remoteLines);
					result.push('>>>>>>> REMOTE');
					conflicts.push({ lineStart: conflictStart, lineEnd: result.length });
				}
				baseIndex = Math.max(localChange.baseEnd, remoteChange.baseEnd);
			} else {
				// Non-overlapping changes - apply the earlier one first
				if (localChange.baseStart < remoteChange.baseStart) {
					applyChange(result, localChange, localLines);
					baseIndex = localChange.baseEnd;
				} else {
					applyChange(result, remoteChange, remoteLines);
					baseIndex = remoteChange.baseEnd;
				}
			}
		}
	}

	return {
		success: conflicts.length === 0,
		content: result.join('\n'),
		conflictCount: conflicts.length,
		conflicts
	};
}

// ===== Helper Types and Functions =====

type DiffChange = {
	/** Starting line in base (inclusive) */
	baseStart: number;
	/** Ending line in base (exclusive) */
	baseEnd: number;
	/** Starting line in changed version */
	newStart: number;
	/** Ending line in changed version */
	newEnd: number;
	/** Type of change */
	type: 'add' | 'delete' | 'modify';
};

function splitLines(text: string): string[] {
	if (text === '') return [];
	return text.split(/\r?\n/);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((val, idx) => val === b[idx]);
}

/**
 * Simplified diff algorithm (LCS-based)
 * Returns ranges of changes between base and new version
 */
function computeDiff(base: string[], changed: string[]): DiffChange[] {
	const changes: DiffChange[] = [];
	let i = 0; // base index
	let j = 0; // changed index

	while (i < base.length || j < changed.length) {
		// Find matching segment starting from current positions
		let bestMatchBaseStart = -1;
		let bestMatchChangedStart = -1;
		let bestMatchLength = 0;

		// Look ahead for matching lines (greedy approach - find longest match)
		for (let lookI = i; lookI < base.length; lookI++) {
			for (let lookJ = j; lookJ < changed.length; lookJ++) {
				if (base[lookI] === changed[lookJ]) {
					// Found a match - count consecutive matches
					let len = 0;
					while (
						lookI + len < base.length &&
						lookJ + len < changed.length &&
						base[lookI + len] === changed[lookJ + len]
					) {
						len++;
					}
					// Prefer longer matches, or earlier matches if same length
					if (len > bestMatchLength) {
						bestMatchBaseStart = lookI;
						bestMatchChangedStart = lookJ;
						bestMatchLength = len;
					}
				}
			}
		}

		if (bestMatchLength > 0 && bestMatchBaseStart !== -1 && bestMatchChangedStart !== -1) {
			// Found matching segment - record change before it (if any)
			if (i < bestMatchBaseStart || j < bestMatchChangedStart) {
				changes.push({
					baseStart: i,
					baseEnd: bestMatchBaseStart,
					newStart: j,
					newEnd: bestMatchChangedStart,
					type: i === bestMatchBaseStart ? 'add' : (j === bestMatchChangedStart ? 'delete' : 'modify')
				});
			}
			// Skip past matching segment
			i = bestMatchBaseStart + bestMatchLength;
			j = bestMatchChangedStart + bestMatchLength;
		} else {
			// No more matches - rest is all changed
			if (i < base.length || j < changed.length) {
				changes.push({
					baseStart: i,
					baseEnd: base.length,
					newStart: j,
					newEnd: changed.length,
					type: i === base.length ? 'add' : (j === changed.length ? 'delete' : 'modify')
				});
			}
			break;
		}
	}

	return changes;
}

function findChangeAtLine(changes: DiffChange[], baseLine: number): DiffChange | null {
	for (const change of changes) {
		// For insertions (baseStart == baseEnd), match when baseLine == baseStart
		// For deletions/modifications, match when baseLine is in [baseStart, baseEnd)
		if (change.baseStart === change.baseEnd) {
			// Insertion: match at the insertion point
			if (baseLine === change.baseStart) {
				return change;
			}
		} else {
			// Deletion or modification
			if (baseLine >= change.baseStart && baseLine < change.baseEnd) {
				return change;
			}
		}
	}
	return null;
}

function applyChange(result: string[], change: DiffChange, lines: string[]): void {
	// Bounds check to prevent invalid array access
	const start = Math.max(0, Math.min(change.newStart, lines.length));
	const end = Math.max(0, Math.min(change.newEnd, lines.length));
	for (let i = start; i < end; i++) {
		if (i < lines.length) {
			result.push(lines[i]);
		}
	}
}

function getLinesFromChange(change: DiffChange, lines: string[]): string[] {
	return lines.slice(change.newStart, change.newEnd);
}
