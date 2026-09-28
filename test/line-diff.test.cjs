'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, countChanges } = require('../lib/line-diff.cjs');

const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const text = (items) => `${items.join('\n')}\n`;
const signs = (hunk) => hunk.lines.map((line) => `${line.type}${line.text}`);

test('one changed line shows with three lines of context and both line numbers', () => {
  const before = lines(10);
  const after = [...before];
  after[4] = 'line five';
  const result = diffLines(text(before), text(after));
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.approximate, false);
  assert.equal(result.hunks.length, 1);
  const [hunk] = result.hunks;
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [2, 7, 2, 7]);
  assert.deepEqual(signs(hunk), [' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8']);
  assert.deepEqual(hunk.lines[3], { type: '-', text: 'line 5', oldLine: 5 });
  assert.deepEqual(hunk.lines[4], { type: '+', text: 'line five', newLine: 5 });
  assert.deepEqual(hunk.lines[5], { type: ' ', text: 'line 6', oldLine: 6, newLine: 6 });
});

test('changes close together share a hunk; far apart they do not', () => {
  const before = lines(40);
  const near = [...before];
  near[5] = 'x';
  near[11] = 'y';
  assert.equal(diffLines(text(before), text(near)).hunks.length, 1);
  const far = [...before];
  far[5] = 'x';
  far[30] = 'y';
  const result = diffLines(text(before), text(far));
  assert.equal(result.hunks.length, 2);
  assert.equal(result.hunks[1].oldStart, 28);
});

test('insertions and deletions at the start and end, new and emptied files', () => {
  const base = lines(5);
  assert.deepEqual(signs(diffLines(text(base), text(['first', ...base])).hunks[0]).slice(0, 2), ['+first', ' line 1']);
  assert.deepEqual(signs(diffLines(text(base), text(base.slice(0, 4))).hunks[0]).slice(-1), ['-line 5']);
  const created = diffLines('', 'a\nb\n');
  assert.deepEqual([created.added, created.removed], [2, 0]);
  assert.deepEqual([created.hunks[0].oldStart, created.hunks[0].oldLines, created.hunks[0].newStart], [0, 0, 1]);
  assert.deepEqual(countChanges('a\nb\n', ''), { added: 0, removed: 2, approximate: false });
  assert.deepEqual(diffLines('same\n', 'same\n'), { hunks: [], added: 0, removed: 0, approximate: false, truncated: false });
});

test('a missing final line break shows as its own marked line', () => {
  const result = diffLines('a\nb\n', 'a\nb');
  assert.deepEqual([result.added, result.removed], [0, 0]);
  const marker = result.hunks[0].lines.find((line) => line.noNewline);
  assert.ok(marker, 'the marker line is there');
  assert.equal(marker.type, '+');
  assert.equal(marker.text, '');
});

test('many scattered edits are found exactly; beyond the limit the middle is replaced whole', () => {
  const before = lines(3000);
  const after = before.map((line, index) => (index % 10 === 3 ? `${line} changed` : line));
  const exact = diffLines(text(before), text(after));
  assert.equal(exact.approximate, false);
  assert.deepEqual([exact.added, exact.removed], [300, 300]);
  const rough = diffLines(text(before), text(after), { maxEdits: 50 });
  assert.equal(rough.approximate, true);
  // Everything between the first and the last change counts as replaced.
  assert.deepEqual([rough.added, rough.removed], [2991, 2991]);
  const cut = diffLines(text(before), text(after), { maxShown: 100 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.hunks.reduce((total, hunk) => total + hunk.lines.length, 0), 100);
});

test('a large file with a small edit diffs quickly', () => {
  const before = lines(30000, 'row');
  const after = [...before.slice(0, 15000), 'inserted', ...before.slice(15000)];
  const started = Date.now();
  const result = diffLines(text(before), text(after));
  assert.ok(Date.now() - started < 1500, 'within 1.5 s');
  assert.deepEqual([result.added, result.removed, result.hunks.length], [1, 0, 1]);
  assert.equal(result.hunks[0].newStart, 14998);
});

test('the no-line-break marker has no line number and is not counted in the hunk', () => {
  const result = diffLines('a\nb\n', 'a\nb');
  const [hunk] = result.hunks;
  assert.deepEqual([hunk.oldLines, hunk.newLines], [2, 2]);
  const marker = hunk.lines.find((line) => line.noNewline);
  assert.equal(marker.oldLine, undefined);
  assert.equal(marker.newLine, undefined);
});

test('repetitive large files never take long: the edit budget shrinks with the size', () => {
  const before = Array.from({ length: 200000 }, (_, index) => (index % 2 ? 'x' : 'y'));
  const after = Array.from({ length: 200000 }, (_, index) => (index % 3 ? 'x' : 'y'));
  const started = Date.now();
  const result = countChanges(`${before.join('\n')}\n`, `${after.join('\n')}\n`);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(typeof result.approximate, 'boolean');
});
