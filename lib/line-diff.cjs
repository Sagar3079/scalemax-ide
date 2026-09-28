'use strict';
// Line diffs of the files a reply changed (lib/checkpoints.cjs), shown in the window like
// `diff -u`: hunks with three lines of context, old and new line numbers. Myers' O(ND) algorithm
// runs on the lines between the common start and end, which is all that differs in a typical
// edit. Versions that differ in more than MAX_EDITS lines are shown with that middle part
// replaced whole (`approximate`), and long diffs are cut after MAX_SHOWN lines (`truncated`).

const CONTEXT = 3;
const MAX_EDITS = 1000;
const MAX_SHOWN = 4000;
// Myers' algorithm takes up to (lines × edits) steps: large files get a smaller edit budget, so
// no diff blocks the main process for long.
const MAX_WORK = 20_000_000;
// Marks the last line of a version without a final line break. Text files never contain NUL
// (lib/workspace.cjs refuses them), so no real line can look like this.
const NO_NEWLINE = '\u0000no-newline';

function splitLines(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return { lines: [], newline: true };
  const lines = value.split('\n');
  const newline = lines[lines.length - 1] === '';
  if (newline) lines.pop();
  return { lines, newline };
}

// Both versions as lines; when only one ends with a line break, the other gets the marker as an
// extra line, so the difference shows (like "\ No newline at end of file").
function versions(before, after) {
  const old = splitLines(before);
  const next = splitLines(after);
  if (old.lines.length && next.lines.length && old.newline !== next.newline) {
    if (!old.newline) old.lines.push(NO_NEWLINE);
    else next.lines.push(NO_NEWLINE);
  }
  return [old.lines, next.lines];
}

/**
 * The shortest edit script between two arrays of line ids (Myers 1986), as a list of
 * [type, oldIndex, newIndex] with type ' ' (same), '-' (only in a) or '+' (only in b).
 * Null when more than `maxEdits` lines differ.
 */
function editScript(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // For backtracking: the part of v each step started from (diagonals -d-1 .. d+1).
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const script = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const start = trace[d];
    const at = (k) => start[k + d + 1];
    const k = x - y;
    const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : at(previous);
    const py = px - previous;
    while (x > px && y > py) { x -= 1; y -= 1; script.push([' ', x, y]); }
    if (d > 0) {
      if (x === px) { y -= 1; script.push(['+', -1, y]); } else { x -= 1; script.push(['-', x, -1]); }
    }
  }
  return script.reverse();
}

/**
 * @returns {{ hunks: Array<{oldStart: number, oldLines: number, newStart: number, newLines: number,
 *   lines: Array<{type: ' '|'-'|'+', text: string, oldLine?: number, newLine?: number, noNewline?: boolean}>}>,
 *   added: number, removed: number, approximate: boolean, truncated: boolean }}
 */
function diffLines(before, after, { context = CONTEXT, maxEdits = MAX_EDITS, maxShown = MAX_SHOWN } = {}) {
  const [a, b] = versions(before, after);
  // Lines as numbers, so the algorithm compares integers.
  const ids = new Map();
  const id = (line) => {
    let value = ids.get(line);
    if (value === undefined) { value = ids.size; ids.set(line, value); }
    return value;
  };
  const ia = a.map(id);
  const ib = b.map(id);
  let prefix = 0;
  while (prefix < ia.length && prefix < ib.length && ia[prefix] === ib[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < ia.length - prefix && suffix < ib.length - prefix
    && ia[ia.length - 1 - suffix] === ib[ib.length - 1 - suffix]) suffix += 1;
  const midA = ia.slice(prefix, ia.length - suffix);
  const midB = ib.slice(prefix, ib.length - suffix);
  const budget = Math.max(1, Math.min(maxEdits, Math.floor(MAX_WORK / Math.max(1, midA.length + midB.length))));
  let middle = editScript(midA, midB, budget);
  const approximate = middle === null;
  if (approximate) {
    middle = [...midA.map((_, index) => ['-', index, -1]), ...midB.map((_, index) => ['+', -1, index])];
  }
  // The common start and end are the same on both sides: the counts come from the middle.
  let added = 0;
  let removed = 0;
  for (const [type, x, y] of middle) {
    if (type === '+' && b[y + prefix] !== NO_NEWLINE) added += 1;
    if (type === '-' && a[x + prefix] !== NO_NEWLINE) removed += 1;
  }
  if (maxShown <= 0) return { hunks: [], added, removed, approximate, truncated: false };
  // The script as [type, oldIndex, newIndex] over the full versions, with only the common lines
  // a hunk can show around the middle (the middle starts and ends with a change).
  const lead = Math.min(prefix, context);
  const trail = Math.min(suffix, context);
  const ops = [];
  for (let index = prefix - lead; index < prefix; index += 1) ops.push([' ', index, index]);
  for (const [type, x, y] of middle) ops.push([type, x < 0 ? -1 : x + prefix, y < 0 ? -1 : y + prefix]);
  for (let index = 0; index < trail; index += 1) ops.push([' ', a.length - suffix + index, b.length - suffix + index]);
  // Hunks: every change with `context` unchanged lines around it; close changes share a hunk.
  const hunks = [];
  let shown = 0;
  let truncated = false;
  let index = 0;
  while (index < ops.length && !truncated) {
    if (ops[index][0] === ' ') { index += 1; continue; }
    let start = Math.max(0, index - context);
    let end = index;
    // Extend while the next change is within 2 × context unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end][0] !== ' ') end += 1;
      let gap = end;
      while (gap < ops.length && ops[gap][0] === ' ' && gap - end < 2 * context + 1) gap += 1;
      if (gap < ops.length && ops[gap][0] !== ' ' && gap - end <= 2 * context) { end = gap; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const lines = [];
    for (let at = start; at < end; at += 1) {
      if (shown >= maxShown) { truncated = true; break; }
      const [type, x, y] = ops[at];
      const text = type === '+' ? b[y] : a[x];
      const line = { type, text: text === NO_NEWLINE ? '' : text };
      // The marker is not a line of the file: no number, not counted.
      if (text === NO_NEWLINE) line.noNewline = true;
      else {
        if (type !== '+') line.oldLine = x + 1;
        if (type !== '-') line.newLine = y + 1;
      }
      lines.push(line);
      shown += 1;
    }
    if (lines.length) {
      const first = ops[start];
      const oldLines = lines.filter((line) => line.oldLine).length;
      const newLines = lines.filter((line) => line.newLine).length;
      // The first line of each side in this hunk (for an empty side: the line before it).
      const oldStart = lines.find((line) => line.oldLine)?.oldLine ?? (first[1] >= 0 ? first[1] : 0);
      const newStart = lines.find((line) => line.newLine)?.newLine ?? (first[2] >= 0 ? first[2] : 0);
      hunks.push({ oldStart, oldLines, newStart, newLines, lines });
    }
    index = end;
  }
  return { hunks, added, removed, approximate, truncated };
}

/** Lines added and removed between two versions (`approximate` when counted as replaced whole). */
function countChanges(before, after) {
  const { added, removed, approximate } = diffLines(before, after, { maxShown: 0 });
  return { added, removed, approximate };
}

module.exports = { diffLines, countChanges, splitLines, CONTEXT, MAX_EDITS, MAX_SHOWN };
