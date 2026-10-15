import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// src/editor.js and the vendored CodeMirror load in Node: everything but createEditor works on
// editor states alone. They are imported before the stand-in page below exists, as in the app
// (where workspace-ui.js imports them only once the page is there).
const editor = await import('../src/editor.js');
const cm = await import('../src/vendor/codemirror.js');
const { diffLines } = createRequire(import.meta.url)('../lib/line-diff.cjs');
const {
  createTabState, textOf, savedDoc, unchanged, reloadSpec, location, languageSupport, reviewSpec, reviewChanges,
  undoChangeSpec, undoAllSpec, keepChangeSpec,
} = editor;
const { EditorSelection, undo, redo, undoDepth } = cm;

const VENDOR = new URL('../src/vendor/codemirror.js', import.meta.url);

// Runs a command (undo, redo) on a state as a view would.
function run(command, state) {
  let next = state;
  command({ state, dispatch: (transaction) => { next = transaction.state; } });
  return next;
}
const type = (state, at, insert) => state.update({ changes: { from: at, insert }, userEvent: 'input.type' }).state;

test('the vendored bundle is one self-contained module, with the CSP change to style-mod', () => {
  const source = readFileSync(VENDOR, 'utf8');
  assert.match(source, /^\/\*\n \* CodeMirror 6 for the ScaleMax IDE/);
  assert.match(source, /Regenerate: node build\/vendor-codemirror\.cjs/);
  assert.match(source, /@codemirror\/view 6\.\d+\.\d+/);
  // Importing it above already proved it has no bare imports left (nothing here could resolve them).
  assert.doesNotMatch(source, /\bfrom\s*["']@?[\w-]+\//, 'no package imports');
  // Rules go into a constructed stylesheet in documents too, never a <style> the CSP refuses.
  assert.match(source, /\w+\.adoptedStyleSheets&&\w+\.CSSStyleSheet/);
  assert.doesNotMatch(source, /!\w+\.head&&\w+\.adoptedStyleSheets/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML\s*=/);
  const licenses = readFileSync(new URL('../src/vendor/codemirror.LICENSE.txt', import.meta.url), 'utf8');
  for (const name of ['@codemirror/view', '@codemirror/merge', '@lezer/common', 'style-mod']) assert.ok(licenses.includes(`${name} `), name);
});

test('every language the Workspace knows has CodeMirror support, picked by the file name', async () => {
  const { languageIds } = await import('../src/workspace-ui.js');
  for (const id of languageIds()) assert.ok(languageSupport(id), id);
  assert.equal(languageSupport('plain'), null);
  assert.equal(languageSupport('toString'), null);
  assert.equal(languageSupport('typescript'), languageSupport('typescript'), 'built once, then shared');
  const name = (path) => createTabState('x', { path }).facet(cm.language)?.name;
  assert.equal(name('src/app.ts'), 'typescript');
  assert.equal(name('src/App.tsx'), 'typescript');
  assert.notEqual(languageSupport('tsx'), languageSupport('typescript'), 'TSX is TypeScript with JSX');
  assert.equal(name('lib/state.cjs'), 'javascript');
  assert.equal(name('tool.py'), 'python');
  assert.equal(name('README.md'), 'markdown');
  assert.equal(name('run.sh'), 'shell');
  assert.equal(name('Cargo.toml'), 'toml');
  assert.equal(name('LICENSE'), undefined);
  assert.equal(createTabState('', { path: 'a.ts', readOnly: true }).facet(cm.language), null, 'the empty editor has none');
});

test('a tab\'s text comes back exactly as it was read: line breaks, a final break, stray carriage returns', () => {
  const samples = ['', '\n', 'a', 'a\n', 'a\r\nb\r\n', 'a\r\nb', 'a\rb\r', 'mixed\r\nends\nhere\r', 'a\r\r\nb', 'tab\there\n'];
  for (const text of samples) assert.equal(textOf(createTabState(text, { path: 'x.txt' })), text, JSON.stringify(text));
  const alphabet = ['a', 'b', ' ', '\n', '\r', '\r\n', '\t', 'é'];
  let seed = 3;
  for (let round = 0; round < 300; round += 1) {
    let text = '';
    const length = (round * 7) % 40;
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      text += alphabet[seed % alphabet.length];
    }
    const state = createTabState(text, { path: 'x.js' });
    assert.equal(textOf(state), text);
    assert.ok(unchanged(state, savedDoc(state, text)));
  }
});

test('each tab keeps its own text, selection and undo history while another is edited', () => {
  // What workspace-ui does on a tab switch: the state on screen is kept, the other one shown.
  let first = createTabState('const a = 1;\n', { path: 'a.js' });
  let second = createTabState('b = 2\n', { path: 'b.py' });
  first = type(first, 13, 'const b = 2;\n');
  first = first.update({ selection: EditorSelection.cursor(5) }).state;
  second = type(second, 0, '# note\n');
  assert.equal(textOf(first), 'const a = 1;\nconst b = 2;\n');
  assert.equal(textOf(second), '# note\nb = 2\n');
  assert.equal(first.selection.main.head, 5);
  assert.equal(undoDepth(first), 1);
  assert.equal(textOf(run(undo, first)), 'const a = 1;\n');
  assert.equal(textOf(run(undo, second)), 'b = 2\n');
  assert.equal(first.facet(cm.indentUnit), '  ');
  assert.equal(second.facet(cm.indentUnit), '    ');
});

test('dirty means different from what is on disk, so undoing back to it is clean again', () => {
  const saved = 'one\r\ntwo\r\n';
  let state = createTabState(saved, { path: 'notes.txt' });
  const doc = savedDoc(state, saved);
  assert.ok(unchanged(state, doc));
  state = type(state, 3, '!');
  assert.ok(!unchanged(state, doc));
  assert.equal(textOf(state), 'one!\r\ntwo\r\n');
  state = run(undo, state);
  assert.ok(unchanged(state, doc));
});

test('a file changed on disk loads as one change: the cursor stays and Undo brings the old text back', () => {
  let state = createTabState('alpha\nbeta\ngamma\n', { path: 'a.txt' });
  state = state.update({ selection: EditorSelection.cursor(14) }).state; // in "gamma"
  const spec = reloadSpec(state, 'alpha\nBETA, longer\ngamma\n');
  assert.deepEqual(spec.changes.from, 6);
  const reloaded = state.update(spec).state;
  assert.equal(textOf(reloaded), 'alpha\nBETA, longer\ngamma\n');
  assert.equal(reloaded.selection.main.head, 22, 'still in "gamma"');
  assert.equal(textOf(run(undo, reloaded)), 'alpha\nbeta\ngamma\n');
  assert.equal(textOf(run(redo, run(undo, reloaded))), 'alpha\nBETA, longer\ngamma\n');
  // CRLF stays CRLF; the same text changes nothing; other line breaks need a fresh state.
  const crlf = createTabState('a\r\nb\r\n', { path: 'a.txt' });
  assert.equal(textOf(crlf.update(reloadSpec(crlf, 'a\r\nB\r\nc\r\n')).state), 'a\r\nB\r\nc\r\n');
  assert.deepEqual(reloadSpec(crlf, 'a\r\nb\r\n'), {});
  assert.equal(reloadSpec(crlf, 'a\nb\n'), null);
});

test('the location is 1-based and counts the selection and the cursors', () => {
  let state = createTabState('first\nsecond line\n', { path: 'a.txt' });
  state = state.update({ selection: EditorSelection.cursor(9) }).state;
  assert.deepEqual(location(state), { line: 2, column: 4, selected: 0, cursors: 1 });
  state = state.update({ selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(6, 12)], 1) }).state;
  assert.deepEqual(location(state), { line: 2, column: 7, selected: 11, cursors: 2 });
});

test('a review marks each change against the earlier text; Undo restores it, Keep unmarks it', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
  const after = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n';
  let state = createTabState(after, { path: 'count.txt', review: before });
  assert.deepEqual(reviewChanges(state).length, 2);
  assert.equal(reviewChanges(createTabState(after, { path: 'count.txt' })), null, 'no review, no changes');
  // Undo of the first change (cursor on it): its line is back, the other change stays marked.
  state = state.update({ selection: EditorSelection.cursor(5) }).state;
  const undoFirst = undoChangeSpec(state);
  assert.equal(undoFirst.userEvent, 'revert');
  state = state.update(undoFirst).state;
  assert.equal(textOf(state), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n');
  assert.equal(reviewChanges(state).length, 1);
  // Keep of the last one: the text stays, nothing is marked any more.
  const [[from]] = reviewChanges(state);
  state = state.update(keepChangeSpec(state, from)).state;
  assert.equal(textOf(state), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n');
  assert.deepEqual(reviewChanges(state), []);
  assert.equal(undoChangeSpec(state), null);
  assert.equal(undoAllSpec(state), null);
  // Ending the review removes the marks altogether.
  assert.equal(reviewChanges(state.update(reviewSpec(state, null)).state), null);
});

test('Undo all gives back exactly the earlier text, CRLF files included', () => {
  const next = (() => { let seed = 5; return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; }; })();
  const pick = (items) => items[Math.floor(next() * items.length)];
  for (let round = 0; round < 150; round += 1) {
    const lineBreak = round % 3 === 0 ? '\r\n' : '\n';
    const base = Array.from({ length: 1 + Math.floor(next() * 20) }, () => pick(['a', 'b', 'c', '', 'x = 1;']));
    const edited = base.filter(() => next() > 0.25).flatMap((line) => (next() < 0.2 ? [line, pick(['new', 'q'])] : [line]));
    const before = base.join(lineBreak) + lineBreak;
    const after = (edited.length ? edited.join(lineBreak) : 'empty') + lineBreak;
    const state = createTabState(after, { path: 'f.js', review: before });
    const spec = undoAllSpec(state);
    if (before === after) { assert.equal(spec, null); continue; }
    const undone = state.update(spec).state;
    assert.equal(textOf(undone), before, `round ${round}`);
    assert.deepEqual(reviewChanges(undone), []);
    // And one change at a time, the last one first, gets there too. (Where CodeMirror rounds a
    // run of blank lines short, what is left stays marked and takes one more Undo.)
    let stepwise = state;
    let steps = 0;
    for (let left = reviewChanges(stepwise); left.length && steps < 50; left = reviewChanges(stepwise), steps += 1) {
      stepwise = stepwise.update(undoChangeSpec(stepwise, left[left.length - 1][0])).state;
    }
    assert.equal(textOf(stepwise), before, `round ${round}, one at a time`);
  }
});

test('the review of a real reply diff: rebuilt earlier text, marked, undone', async () => {
  const { originalFromHunks } = await import('../src/workspace-ui.js');
  const before = 'export function convert(f) {\n  return ((f + 32) * 5) / 9;\n}\n';
  const after = 'export function convert(f) {\n  return ((f - 32) * 5) / 9;\n}\n';
  const original = originalFromHunks(after, diffLines(before, after));
  assert.equal(original, before);
  const state = createTabState(after, { path: 'src/convert.js', review: original });
  assert.equal(reviewChanges(state).length, 1);
  assert.equal(textOf(state.update(undoAllSpec(state)).state), before);
});

// ---- The Workspace editor with CodeMirror states --------------------------------------------
// src/workspace-ui.js against a stand-in page and a stand-in view that holds real editor states
// (createEditor needs a browser; everything it does with states is the same).

function fakeElement() {
  return {
    value: '', hidden: false, disabled: false, readOnly: false, textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    selectionStart: 0, selectionEnd: 0, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {},
    setSelectionRange() {}, focus() {}, querySelector() { return null; },
  };
}
const nodes = Object.fromEntries(['#editor-input', '#editor-tabs', '#editor-status', '#editor-location', '#editor-review', '#editor-review-label']
  .map((selector) => [selector, fakeElement()]));
globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {},
  querySelector: (selector) => nodes[selector] || null,
  querySelectorAll: () => [],
  createElement: () => fakeElement(),
  createTextNode: () => fakeElement(),
  activeElement: null,
};
const workspace = await import('../src/workspace-ui.js');

function fakeView(onUpdate) {
  const view = { state: createTabState('', { readOnly: true }) };
  return {
    view,
    shown: [],
    show(state, scroll = null) {
      view.state = state || createTabState('', { readOnly: true });
      this.shown.push(textOf(view.state));
    },
    snapshot() { return { state: view.state, scroll: null }; },
    dispatch(spec) {
      const transaction = spec instanceof cm.Transaction ? spec : view.state.update(spec);
      view.state = transaction.state;
      onUpdate({ docChanged: transaction.docChanged, selectionSet: Boolean(transaction.selection), transactions: [transaction] });
    },
    focus() {},
    nextChange() { return false; },
    // A command as a key binding runs it.
    run(command) { return command({ state: view.state, dispatch: (transaction) => this.dispatch(transaction) }); },
  };
}

const ROOT = '/Users/you/project';
const app = { workspace: { root: ROOT }, tasks: [], toasts: [], showToast(message) { this.toasts.push(message); } };
const disk = {};
const writes = [];
let writing = null;
window.scalemaxAPI = {
  workspace: {
    read: async (path) => (path in disk ? { ok: true, data: { path, content: disk[path], revision: `r:${disk[path]}` } } : { ok: false, error: { code: 'ENOENT' } }),
    write: async ({ path, content, revision }) => {
      if (writing) await writing();
      if (revision !== `r:${disk[path]}`) return { ok: false, error: { code: 'CONFLICT', message: 'The file changed; reload it before saving.' } };
      disk[path] = content;
      writes.push({ path, content });
      return { ok: true, data: { path, revision: `r:${content}` } };
    },
  },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
let view;
workspace.useEditor(app, editor, (onUpdate) => { view = fakeView(onUpdate); return view; });

test('switching tabs keeps each tab\'s edits and undo history; dirty follows the text', async () => {
  workspace.resetTabs(app);
  Object.assign(disk, { 'a.js': 'let a = 1;\n', 'b.md': '# B\r\n' });
  assert.equal(nodes['#editor-input'].hidden, true, 'CodeMirror replaced the textarea');
  assert.equal(await workspace.openFileInTab(app, 'a.js'), true);
  view.dispatch({ changes: { from: 10, insert: ' // one' }, selection: { anchor: 17 }, userEvent: 'input.type' });
  assert.deepEqual(app.workspace.tabs, [{ path: 'a.js', dirty: true }]);
  assert.equal(nodes['#editor-status'].textContent, 'Unsaved changes.');
  assert.equal(nodes['#editor-location'].textContent, 'Ln 1, Col 18');
  assert.equal(await workspace.openFileInTab(app, 'b.md'), true);
  assert.equal(textOf(view.view.state), '# B\r\n');
  view.dispatch({ changes: { from: 3, insert: 'ee' } });
  assert.equal(workspace.activeTabContent(), '# Bee\r\n');
  await workspace.openFileInTab(app, 'a.js');
  assert.equal(workspace.activeTabContent(), 'let a = 1; // one\n');
  assert.equal(undoDepth(view.view.state), 1, 'a.js still has its history');
  assert.equal(view.view.state.selection.main.head, 17, 'and its cursor');
  // Undo back to the text on disk: the tab is clean again.
  assert.equal(view.run(undo), true);
  assert.equal(workspace.activeTabContent(), 'let a = 1;\n');
  assert.deepEqual(app.workspace.tabs, [{ path: 'a.js', dirty: false }, { path: 'b.md', dirty: true }]);
  workspace.resetTabs(app);
});

test('saving writes the file\'s own line breaks; edits made meanwhile, or a second save, are not lost', async () => {
  workspace.resetTabs(app);
  writes.length = 0;
  disk['c.txt'] = 'one\r\ntwo\r\n';
  await workspace.openFileInTab(app, 'c.txt');
  view.dispatch({ changes: { from: 3, insert: '!' } });
  // Save, and while it is on its way type more and save again: the second waits for the first.
  writing = async () => {
    writing = null;
    view.dispatch({ changes: { from: 0, insert: '>' } });
  };
  const first = workspace.saveActiveTab(app);
  const second = workspace.saveActiveTab(app);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(writes.map((item) => item.content), ['one!\r\ntwo\r\n', '>one!\r\ntwo\r\n']);
  assert.equal(disk['c.txt'], '>one!\r\ntwo\r\n');
  assert.deepEqual(app.workspace.tabs, [{ path: 'c.txt', dirty: false }]);
  workspace.resetTabs(app);
});

test('a reply\'s change to an open file loads into its tab and is reviewed there: Undo saves the earlier text', async () => {
  workspace.resetTabs(app);
  writes.length = 0;
  const before = 'function f(x) {\n  return x + 1;\n}\n\nexport default f;\n';
  disk['f.js'] = before;
  await workspace.openFileInTab(app, 'f.js');
  // The reply rewrites f.js on disk; checkpoints.diff answers with its hunks.
  const after = 'function f(x) {\n  return x - 1;\n}\n\nexport default f;\n// done\n';
  disk['f.js'] = after;
  window.scalemaxAPI.checkpoints = {
    diff: async ({ id, path }) => ({ ok: true, data: { path, current: 'same', ...diffLines(before, after), id } }),
  };
  const changes = { id: 'chat-7', files: [{ path: 'f.js', kind: 'modified', status: 'changed' }] };
  await workspace.reloadTabs(app, ['f.js'], { review: changes });
  assert.equal(workspace.activeTabContent(), after);
  assert.deepEqual(app.workspace.tabs, [{ path: 'f.js', dirty: false }]);
  assert.equal(reviewChanges(view.view.state).length, 2);
  assert.equal(nodes['#editor-review'].hidden, false);
  assert.equal(nodes['#editor-review-label'].textContent, '2 changes from the reply');
  // Undo the first change (the "- 1"): the earlier line is back and saved straight away.
  const [[from]] = reviewChanges(view.view.state);
  view.dispatch(undoChangeSpec(view.view.state, from));
  await settle();
  await settle();
  assert.equal(disk['f.js'], 'function f(x) {\n  return x + 1;\n}\n\nexport default f;\n// done\n');
  assert.deepEqual(app.workspace.tabs, [{ path: 'f.js', dirty: false }]);
  assert.equal(nodes['#editor-review-label'].textContent, '1 change from the reply');
  // Keep the other: the review ends and the bar goes.
  const [[last]] = reviewChanges(view.view.state);
  view.dispatch(keepChangeSpec(view.view.state, last));
  await settle();
  assert.equal(reviewChanges(view.view.state), null);
  assert.equal(nodes['#editor-review'].hidden, true);
  assert.equal(disk['f.js'], 'function f(x) {\n  return x + 1;\n}\n\nexport default f;\n// done\n');
  delete window.scalemaxAPI.checkpoints;
  workspace.resetTabs(app);
});

test('a file the reply changed again, or one with unsaved edits, is not reviewed against the wrong text', async () => {
  workspace.resetTabs(app);
  const before = 'a\nb\n';
  const after = 'a\nB\n';
  disk['g.txt'] = 'a\nb, edited by hand\n';
  window.scalemaxAPI.checkpoints = { diff: async () => ({ ok: true, data: { current: 'same', ...diffLines(before, after) } }) };
  await workspace.openFileInTab(app, 'g.txt');
  await workspace.reviewReplyChanges(app, { id: 'chat-8', files: [{ path: 'g.txt', status: 'changed' }] });
  assert.equal(reviewChanges(view.view.state), null, 'the text is not what the reply left');
  view.dispatch({ changes: { from: 0, insert: 'typed ' } });
  disk['g.txt'] = after;
  await workspace.reviewReplyChanges(app, { id: 'chat-8', files: [{ path: 'g.txt', status: 'changed' }] });
  assert.equal(reviewChanges(view.view.state), null, 'unsaved edits are never reviewed over');
  assert.equal(workspace.activeTabContent(), 'typed a\nb, edited by hand\n');
  delete window.scalemaxAPI.checkpoints;
  workspace.resetTabs(app);
});
