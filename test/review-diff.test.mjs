import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The diff in the review dialog (src/changes-ui.js diffView): the words that changed inside a
// changed line are marked and the code is coloured by its language with the editor's own
// highlighter (src/editor.js highlightLines), within size limits.
const { diffLines } = createRequire(import.meta.url)('../lib/line-diff.cjs');
// CodeMirror loads before the stand-in page exists, as in the other editor tests.
const { highlightLines } = await import('../src/editor.js');
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
const { wordDiff, diffView, SYNTAX_LIMIT } = await import('../src/changes-ui.js');

const slices = (text, ranges) => ranges.map(([from, to]) => text.slice(from, to));

test('word marks: only what changed inside a line, word by word', () => {
  const before = '  const month = pad(date.getMonth());';
  const after = '  const month = pad(date.getMonth() + 1);';
  const words = wordDiff(before, after);
  assert.deepEqual(slices(before, words.removed), []);
  assert.deepEqual(slices(after, words.added), [' + 1']);
  const two = wordDiff('call(alpha, beta);', 'call(gamma, beta, delta);');
  assert.deepEqual(slices('call(alpha, beta);', two.removed), ['alpha']);
  assert.deepEqual(slices('call(gamma, beta, delta);', two.added), ['gamma', ', delta']);
  // Words apart by spaces only read as one change.
  const joined = wordDiff('return one two three;', 'return uno dos three;');
  assert.deepEqual(slices('return uno dos three;', joined.added), ['uno dos']);
  assert.equal(wordDiff('return a;', "throw new Error('nope');"), null, 'a replaced line gets no marks');
  assert.equal(wordDiff('', '   '), null);
});

test('word marks on very long lines fall back to the changed middle', () => {
  const words = Array.from({ length: 500 }, (_, index) => `w${index}`);
  const before = words.join(' ');
  const after = words.map((word, index) => (index === 250 ? 'CHANGED' : word)).join(' ');
  const result = wordDiff(before, after);
  assert.deepEqual(slices(after, result.added), ['CHANGED']);
  assert.equal(result.cells, before.length + after.length, 'linear work, no table');
  // The same with a budget used up elsewhere in the diff.
  const small = wordDiff('a b c', 'a x c', { budget: 1 });
  assert.deepEqual(slices('a x c', small.added), ['x']);
});

const BEFORE = [
  "const { pad } = require('./pad');",
  '',
  'function formatDate(date) {',
  '  const year = date.getFullYear();',
  '  const month = pad(date.getMonth());',
  '  const day = pad(date.getDate());',
  '  return `${year}-${month}-${day}`;',
  '}',
  '',
].join('\n');
const AFTER = BEFORE.replace('pad(date.getMonth())', 'pad(date.getMonth() + 1)');

test('the dialog diff: hunk heading, numbers, syntax colours and the changed words', () => {
  const data = diffLines(BEFORE, AFTER);
  const items = diffView(data, { highlight: highlightLines, path: 'src/format-date.js' });
  assert.deepEqual(items[0], { kind: 'hunk', text: 'Lines 2–8' });
  const del = items.find((item) => item.type === 'del');
  const add = items.find((item) => item.type === 'add');
  assert.deepEqual([del.oldLine, del.newLine, add.oldLine, add.newLine], [5, 0, 0, 5]);
  const text = (item) => item.pieces.map((piece) => piece.text).join('');
  assert.equal(text(add), '  const month = pad(date.getMonth() + 1);');
  assert.deepEqual(add.pieces.filter((piece) => piece.changed).map((piece) => piece.text), [' + ', '1'], 'the inserted words, split only by colour');
  assert.ok(add.pieces.some((piece) => piece.changed && piece.token === 'tok-number'), 'a marked word keeps its colour');
  assert.ok(add.pieces.some((piece) => piece.text === 'const' && piece.token === 'tok-keyword'));
  assert.equal(del.pieces.filter((piece) => piece.changed).length, 0, 'nothing was taken out of the old line');
  assert.ok(del.pieces.some((piece) => piece.text === 'getMonth' && piece.token === 'tok-function'), 'the old line is coloured too');
  const context = items.find((item) => item.type === 'same' && item.pieces.some((piece) => piece.text === 'function'));
  assert.equal(context.pieces.find((piece) => piece.text === 'function').token, 'tok-keyword');
});

test('without the highlighter, past the size limit or for a replaced file: plain or unmarked', () => {
  const data = diffLines(BEFORE, AFTER);
  const plain = diffView(data, { highlight: null, path: 'a.js' });
  const add = plain.find((item) => item.type === 'add');
  assert.ok(add.pieces.every((piece) => piece.token === ''), 'no colours');
  assert.ok(add.pieces.some((piece) => piece.changed), 'the changed words still show');
  // A diff past the limit is not coloured (the highlighter is never asked).
  let asked = 0;
  const big = { hunks: [{ newStart: 1, newLines: 1, lines: [{ type: '+', text: 'x'.repeat(SYNTAX_LIMIT + 1), newLine: 1 }] }] };
  diffView(big, { highlight: (...args) => { asked += 1; return highlightLines(...args); }, path: 'a.js' });
  assert.equal(asked, 0);
  // Shown as replaced: removed and added lines are not paired up.
  const approximate = diffView({ ...data, approximate: true }, { highlight: null, path: 'a.js' });
  assert.ok(approximate.every((item) => item.kind === 'hunk' || item.pieces.every((piece) => !piece.changed)));
  // The no-line-break marker line has no text pieces.
  const marker = diffView(diffLines('a\n', 'a'), { highlight: highlightLines, path: 'a.txt' });
  assert.ok(marker.some((item) => item.noNewline && item.pieces.length === 0));
});
