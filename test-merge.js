// Quick test of the 3-way merge algorithm
// Run with: node test-merge.js

// Simulate the merge scenario from the user's case

const base = `---
tags:
  - priority/medium
  - status/draft
topics: "[[topic 1]]"
Created at: 2024-01-01
---

# second post

Some content here

References:
1. Link 1
2. Link 2`;

const local = `---
tags:
  - priority/medium
  - status/draft
topics: "[[topic 1]]"
Created at: 2024-01-02
Updated at: 2024-01-02
---

# second post

Some content here

References:
1. Link 1
2. Link 2`;

const remote = `---
tags:
  - priority/medium
  - status/draft
topics: "[[topic 1]]"
Created at: 2024-01-01
---

# second post

Some content here

References:
1. Link 1
2. Link 2
3. Link 3
4. Link 4`;

function splitLines(text) {
	if (text === '') return [];
	return text.split(/\r?\n/);
}

function arraysEqual(a, b) {
	if (a.length !== b.length) return false;
	return a.every((val, idx) => val === b[idx]);
}

function computeDiff(base, changed) {
	const changes = [];
	let i = 0;
	let j = 0;

	while (i < base.length || j < changed.length) {
		let bestMatchBaseStart = -1;
		let bestMatchChangedStart = -1;
		let bestMatchLength = 0;

		for (let lookI = i; lookI < base.length; lookI++) {
			for (let lookJ = j; lookJ < changed.length; lookJ++) {
				if (base[lookI] === changed[lookJ]) {
					let len = 0;
					while (
						lookI + len < base.length &&
                        lookJ + len < changed.length &&
                        base[lookI + len] === changed[lookJ + len]
					) {
						len++;
					}
					if (len > bestMatchLength) {
						bestMatchBaseStart = lookI;
						bestMatchChangedStart = lookJ;
						bestMatchLength = len;
					}
				}
			}
		}

		if (bestMatchLength > 0 && bestMatchBaseStart !== -1 && bestMatchChangedStart !== -1) {
			if (i < bestMatchBaseStart || j < bestMatchChangedStart) {
				changes.push({
					baseStart: i,
					baseEnd: bestMatchBaseStart,
					newStart: j,
					newEnd: bestMatchChangedStart,
					type: i === bestMatchBaseStart ? 'add' : (j === bestMatchChangedStart ? 'delete' : 'modify')
				});
			}
			i = bestMatchBaseStart + bestMatchLength;
			j = bestMatchChangedStart + bestMatchLength;
		} else {
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

function findChangeAtLine(changes, baseLine) {
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

function applyChange(result, change, lines) {
	console.log('applyChange:', change, 'lines.length:', lines.length);
	const start = Math.max(0, Math.min(change.newStart, lines.length));
	const end = Math.max(0, Math.min(change.newEnd, lines.length));
	for (let i = start; i < end; i++) {
		if (i < lines.length) {
			result.push(lines[i]);
		}
	}
}

function getLinesFromChange(change, lines) {
	return lines.slice(change.newStart, change.newEnd);
}

function merge3Way(base, local, remote) {
	const baseLines = splitLines(base);
	const localLines = splitLines(local);
	const remoteLines = splitLines(remote);

	const localDiff = computeDiff(baseLines, localLines);
	const remoteDiff = computeDiff(baseLines, remoteLines);

	console.log('Local changes:', localDiff);
	console.log('Remote changes:', remoteDiff);

	const result = [];
	const conflicts = [];
	let baseIndex = 0;

	// Process until we've covered all changes, which may extend beyond base length
	const maxBaseIndex = Math.max(
		baseLines.length,
		...localDiff.map(c => c.baseEnd),
		...remoteDiff.map(c => c.baseEnd)
	);

	console.log('maxBaseIndex:', maxBaseIndex, 'baseLines.length:', baseLines.length);

	while (baseIndex <= maxBaseIndex) {
		const localChange = findChangeAtLine(localDiff, baseIndex);
		const remoteChange = findChangeAtLine(remoteDiff, baseIndex);

		if (!localChange && !remoteChange) {
			if (baseIndex < baseLines.length) {
				result.push(baseLines[baseIndex]);
			}
			baseIndex++;
		} else if (localChange && !remoteChange) {
			applyChange(result, localChange, localLines);
			baseIndex = localChange.baseEnd;
			// If it's an insertion and baseEnd == baseIndex, we need to process the base line too
			if (localChange.baseStart === localChange.baseEnd && baseIndex < baseLines.length) {
				result.push(baseLines[baseIndex]);
				baseIndex++;
			}
		} else if (remoteChange && !localChange) {
			applyChange(result, remoteChange, remoteLines);
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

			console.log(`At baseIndex ${baseIndex}:`);
			console.log('  Local change:', localChange);
			console.log('  Remote change:', remoteChange);
			console.log('  Overlap?', changesOverlap);

			if (changesOverlap) {
				// Overlapping changes - check if identical
				const localContent = getLinesFromChange(localChange, localLines);
				const remoteContent = getLinesFromChange(remoteChange, remoteLines);

				if (arraysEqual(localContent, remoteContent)) {
					applyChange(result, localChange, localLines);
				} else {
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

// Test the merge
console.log('=== Testing 3-way merge ===\n');
console.log('BASE (original):');
console.log(base);
console.log('\n\nLOCAL (updated timestamp):');
console.log(local);
console.log('\n\nREMOTE (added links):');
console.log(remote);

console.log('\n\nBase line count:', splitLines(base).length);
console.log('Local line count:', splitLines(local).length);
console.log('Remote line count:', splitLines(remote).length);
console.log('\nLast 3 lines of base:', splitLines(base).slice(-3));
console.log('Last 3 lines of remote:', splitLines(remote).slice(-3));

const mergeResult = merge3Way(base, local, remote);

console.log('\n\n=== MERGE RESULT ===');
console.log('Success:', mergeResult.success);
console.log('Conflicts:', mergeResult.conflictCount);
console.log('\nMerged content:');
console.log(mergeResult.content);
