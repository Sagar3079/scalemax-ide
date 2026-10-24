import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The editor's inline review of a reply's changes, end to end in Node: src/workspace-ui.js and
// src/changes-ui.js on a stand-in page, with real editor states (src/editor.js), a real project
// folder (lib/workspace.cjs), replies recorded by the real workspace tools into real checkpoints
// (lib/checkpoints.cjs), and a bridge that answers like main's checkpoint:* channels.
const require = createRequire(import.meta.url);
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools } = require('../lib/workspace-tools.cjs');
const { createCheckpoints } = require('../lib/checkpoints.cjs');
const editor = await import('../src/editor.js');
const cm = await import('../src/vendor/codemirror.js');
const { createTabState, textOf, reviewChanges, undoChangeSpec } = editor;

function fakeElement() {
  const classes = new Set();
  return {
    value: '', hidden: false, disabled: false, readOnly: false, textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
    selectionStart: 0, selectionEnd: 0, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {},
    setSelectionRange() {}, focus() {}, querySelector() { return null; }, contains() { return false; },
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
const workspaceUi = await import('../src/workspace-ui.js');
const changesUi = await import('../src/changes-ui.js');
const { normalizeChanges, changesSummary, historyMessages } = await import('../src/domain.mjs');

// A stand-in for createEditor's view over real states; it counts focus and moves between changes
// with CodeMirror's own commands, as the real one does.
function fakeView(onUpdate) {
  const view = { state: createTabState('', { readOnly: true }) };
  const fake = {
    view,
    focused: 0,
    show(state) { view.state = state || createTabState('', { readOnly: true }); },
    snapshot() { return { state: view.state, scroll: null }; },
    dispatch(spec) {
      const transaction = spec instanceof cm.Transaction ? spec : view.state.update(spec);
      view.state = transaction.state;
      onUpdate({ docChanged: transaction.docChanged, selectionSet: Boolean(transaction.selection), transactions: [transaction] });
    },
    focus() { fake.focused += 1; },
    nextChange(direction = 1) {
      const command = direction < 0 ? cm.goToPreviousChunk : cm.goToNextChunk;
      return command({ state: view.state, dispatch: (transaction) => fake.dispatch(transaction) });
    },
  };
  return fake;
}

const FILE = 'src/format-date.js';
const BEFORE = [
  "const { pad } = require('./pad');",
  '',
  '/**',
  ' * Formats a Date as YYYY-MM-DD in local time.',
  ' */',
  'function formatDate(date) {',
  '  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;',
  '}',
  '',
  '/**',
  ' * Formats a Date as HH:MM in local time.',
  ' */',
  'function formatTime(date) {',
  '  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;',
  '}',
  '',
  '/** Returns a new Date `days` after `date`. */',
  'function addDays(date, days) {',
  '  const next = new Date(date.getTime());',
  '  next.setDate(next.getDate() + days);',
  '  return next;',
  '}',
  '',
  'module.exports = { formatDate, formatTime, addDays };',
  '',
].join('\n');

let view;
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
// Saves and the checkpoint's bookkeeping touch the real disk: wait until `ready()` holds.
async function until(ready, what) {
  const end = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settle();
}
const envelope = async (run) => {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: { code: error?.code || 'ERROR', message: error?.message || 'failed' } };
  }
};

// A project with format-date.js, a workspace session on it (the bridge and the replies share it),
// a checkpoint store, a task, and the file open in the editor.
async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inline-project-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inline-store-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, FILE), BEFORE);
  const ws = createWorkspace({ approve: async () => true });
  await ws.select(root);
  const checkpoints = createCheckpoints({ dir: store });
  const calls = [];
  window.scalemaxAPI = {
    workspace: {
      read: (file) => envelope(() => ws.read(file)),
      write: (request) => envelope(() => ws.write(request)),
    },
    // Like main's checkpoint:* channels (main.js checkpointChannels).
    checkpoints: {
      diff: ({ id, path: file }) => envelope(() => checkpoints.diff(id, file, { workspace: ws })),
      undo: ({ id, paths, part }) => {
        calls.push({ undo: part ? 'part' : 'files', id, paths, part });
        return envelope(() => (part ? checkpoints.editorUndo(id, part.path, part, { workspace: ws }) : checkpoints.undo(id, paths ?? null, { workspace: ws })));
      },
      keep: ({ id, paths }) => {
        calls.push({ keep: true, id, paths });
        return envelope(() => checkpoints.keep(id, paths ?? null));
      },
    },
  };
  const task = { id: 'task-1', folder: { path: root, name: path.basename(root) }, messages: [] };
  const app = {
    workspace: { root }, tasks: [task], currentTaskId: 'task-1', toasts: [],
    showToast(message) { this.toasts.push(message); },
    persist: async () => {}, renderChat() {}, refreshWorkspace: async () => {},
  };
  workspaceUi.useEditor(app, editor, (onUpdate) => { view = fakeView(onUpdate); return view; });
  workspaceUi.resetTabs(app);
  assert.equal(await workspaceUi.openFileInTab(app, FILE), true);
  t.after(() => {
    workspaceUi.resetTabs(app);
    ws.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });
  const disk = () => fs.readFileSync(path.join(root, FILE), 'utf8');
  // A reply that edits the file with the workspace tools, recorded as main records it, then shown
  // the way app.showReplyChanges shows it (open tabs read again, its changes reviewed).
  let count = 0;
  async function reply(edits) {
    const id = `chat-task-1-${count += 1}`;
    const recorder = checkpoints.recorder({ requestId: id, folder: ws.current() });
    const tools = createWorkspaceTools({ getWorkspace: () => ws, onChange: (change) => recorder.record(change) });
    for (const [oldText, newText] of edits) {
      const result = await tools.call('edit_file', { path: FILE, old_text: oldText, new_text: newText });
      assert.notEqual(result?.isError, true, JSON.stringify(result));
    }
    const message = { role: 'assistant', text: `Done (${id}).`, changes: normalizeChanges(recorder.summary()) };
    task.messages.push({ role: 'user', text: 'Please change it.' }, message);
    await workspaceUi.reloadTabs(app, [FILE], { review: message.changes });
    await settle();
    return message;
  }
  const marked = () => reviewChanges(view.view.state);
  const original = () => cm.getOriginalDoc(view.view.state).toString();
  const fileOf = (message) => message.changes.files.find((file) => file.path === FILE);
  // Puts the cursor in the n-th marked change.
  const cursorTo = (index) => view.dispatch({ selection: { anchor: marked()[index][0] } });
  return { root, ws, checkpoints, app, task, calls, disk, reply, marked, original, fileOf, cursorTo };
}

test('two replies in a row: the review shows only the newest reply\'s change, and Undo touches only it', async (t) => {
  const { app, disk, reply, marked, original, fileOf, cursorTo } = await setup(t);
  const alpha = await reply([['function addDays(date, days) {', '// NOTE: alpha\nfunction addDays(date, days) {']]);
  const afterAlpha = disk();
  assert.equal(marked().length, 1);
  assert.equal(original(), BEFORE);
  const beta = await reply([['function addDays(date, days) {', '// NOTE: beta\nfunction addDays(date, days) {']]);
  // Marked against the text from before the second reply, exactly like its review dialog.
  assert.equal(original(), afterAlpha, 'the earlier text is the one from just before this reply');
  assert.equal(marked().length, 1);
  assert.equal(nodes['#editor-review-label'].textContent, '1 change from the reply');
  const [[from, to]] = marked();
  assert.equal(view.view.state.sliceDoc(from, to).trim(), '// NOTE: beta');
  // Undo it from the bar: only beta goes; alpha stays on disk and in its reply's card.
  cursorTo(0);
  await workspaceUi.reviewAction(app, 'undo');
  await until(() => fileOf(beta).status === 'undone', 'the undo to be saved and recorded');
  assert.equal(disk(), afterAlpha);
  assert.match(disk(), /\/\/ NOTE: alpha\nfunction addDays/);
  assert.equal(fileOf(beta).status, 'undone', 'every change of the second reply undone: its card says Undone');
  assert.equal(fileOf(alpha).status, 'changed', 'the first reply is untouched');
  assert.equal(marked(), null, 'nothing of the second reply is left to review');
  // The model hears about it like a card undo.
  const notes = historyMessages(app.tasks[0].messages).filter((turn) => turn.content.startsWith('[Note from ScaleMax'));
  assert.deepEqual(notes.map((turn) => turn.content), [
    `[Note from ScaleMax, the app: after that reply the user undid its changes to ${FILE}, so this file is back as it was before it.]`,
  ]);
});

test('Undo on one change is recorded: the card shows what is left, the review dialog can still undo it, the model is told', async (t) => {
  const { app, checkpoints, ws, calls, disk, reply, marked, fileOf, cursorTo } = await setup(t);
  const tidy = await reply([
    [' * Formats a Date as YYYY-MM-DD in local time.', ' * Formats a Date as YYYY-MM-DD in the local time zone.'],
    [' * Formats a Date as HH:MM in local time.', ' * Formats a Date as HH:MM (24-hour) in the local time zone.'],
  ]);
  assert.equal(marked().length, 2);
  assert.deepEqual({ added: fileOf(tidy).added, removed: fileOf(tidy).removed }, { added: 2, removed: 2 });
  // Undo the second change from the bar.
  cursorTo(1);
  const focused = view.focused;
  await workspaceUi.reviewAction(app, 'undo');
  await until(() => fileOf(tidy).partly, 'the undo to be saved and recorded');
  assert.match(disk(), / \* Formats a Date as HH:MM in local time\./);
  assert.match(disk(), / \* Formats a Date as YYYY-MM-DD in the local time zone\./);
  assert.deepEqual(calls.filter((call) => call.undo).map((call) => [call.undo, call.part?.changes, call.part?.lines]), [['part', 1, [11]]]);
  const file = fileOf(tidy);
  assert.equal(file.status, 'changed');
  assert.deepEqual({ added: file.added, removed: file.removed, partly: file.partly }, { added: 1, removed: 1, partly: { changes: 1, lines: [11] } });
  assert.equal(changesSummary(tidy.changes), '1 file changed · +1 −1 · 1 partly undone');
  // The review dialog's diff is what is left, and the file is "as the reply left it" for undo.
  const diff = await checkpoints.diff(tidy.changes.id, FILE, { workspace: ws });
  assert.equal(diff.current, 'same');
  assert.deepEqual(diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type !== ' ').map((line) => line.type + line.text), [
    '- * Formats a Date as YYYY-MM-DD in local time.',
    '+ * Formats a Date as YYYY-MM-DD in the local time zone.',
  ]);
  // The next request tells the model which part the user undid.
  const notes = historyMessages(app.tasks[0].messages).filter((turn) => turn.content.startsWith('[Note from ScaleMax'));
  assert.deepEqual(notes.map((turn) => turn.content), [
    `[Note from ScaleMax, the app: after that reply the user undid some of its changes in the editor: 1 change to ${FILE} (at line 11). Those parts are back as they were before that reply; its other changes are still there.]`,
  ]);
  // Keyboard focus is back in the text, on the change that is left (F7 goes on from there).
  assert.ok(view.focused > focused);
  assert.equal(marked().length, 1);
  const [[from, to]] = marked();
  const head = view.view.state.selection.main.head;
  assert.ok(head >= from && head <= to, 'the cursor is on the remaining change');
  // Keep the last one: the review is over and the card says Kept.
  await workspaceUi.reviewAction(app, 'keep');
  await until(() => fileOf(tidy).status === 'kept', 'the file to be kept');
  assert.equal(marked(), null);
  assert.equal(fileOf(tidy).status, 'kept');
  assert.deepEqual(fileOf(tidy).partly, { changes: 1, lines: [11] });
});

test('Undo all in the editor is the card\'s Undo: the file goes back byte for byte, also after a partial undo', async (t) => {
  const { app, calls, disk, reply, marked, fileOf, cursorTo } = await setup(t);
  const tidy = await reply([
    [' * Formats a Date as YYYY-MM-DD in local time.', ' * Formats a Date as YYYY-MM-DD in the local time zone.'],
    [' * Formats a Date as HH:MM in local time.', ' * Formats a Date as HH:MM (24-hour) in the local time zone.'],
  ]);
  cursorTo(0);
  await workspaceUi.reviewAction(app, 'undo');
  await until(() => fileOf(tidy).partly, 'the undo to be saved and recorded');
  assert.deepEqual(fileOf(tidy).partly, { changes: 1, lines: [4] });
  await workspaceUi.reviewAction(app, 'undo-all');
  await until(() => fileOf(tidy).status === 'undone' && workspaceUi.activeTabContent() === BEFORE, 'the undo and the tab to read the file again');
  assert.equal(disk(), BEFORE);
  assert.equal(fileOf(tidy).status, 'undone');
  assert.equal(calls.at(-1).undo, 'files', 'through the checkpoint\'s undo, not an editor save');
  assert.equal(marked(), null, 'the review ended with the file read again');
  assert.equal(workspaceUi.activeTabContent(), BEFORE);
});

test('Keep all in the editor is the card\'s Keep; a Keep on the card ends the editor\'s review', async (t) => {
  const { app, task, disk, reply, marked, fileOf } = await setup(t);
  const first = await reply([[' * Formats a Date as HH:MM in local time.', ' * Formats a Date as HH:MM (24-hour) in the local time zone.']]);
  const after = disk();
  await workspaceUi.reviewAction(app, 'keep-all');
  await settle();
  assert.equal(fileOf(first).status, 'kept');
  assert.equal(marked(), null);
  assert.equal(disk(), after);
  const second = await reply([['/** Returns a new Date `days` after `date`. */', '/** Returns a new Date `days` after `date` (negative goes back). */']]);
  assert.equal(marked().length, 1);
  await changesUi.keepFiles(app, task.id, second.changes.id, [FILE]);
  await settle();
  assert.equal(fileOf(second).status, 'kept');
  assert.equal(marked(), null, 'the card and the editor agree');
});

test('an Undo in the review of a tab with typed edits is saved but not recorded, and a whole undo then leaves the file alone', async (t) => {
  const { app, checkpoints, ws, calls, disk, reply, marked, fileOf, cursorTo } = await setup(t);
  const tidy = await reply([
    [' * Formats a Date as YYYY-MM-DD in local time.', ' * Formats a Date as YYYY-MM-DD in the local time zone.'],
    [' * Formats a Date as HH:MM in local time.', ' * Formats a Date as HH:MM (24-hour) in the local time zone.'],
  ]);
  // Typed by hand at the top, then one change undone: the save carries both.
  view.dispatch({ changes: { from: 0, insert: '// mine\n' }, userEvent: 'input.type' });
  cursorTo(1);
  view.dispatch(undoChangeSpec(view.view.state));
  await until(() => /^\/\/ mine\n/.test(disk()), 'the save');
  assert.match(disk(), /^\/\/ mine\n/);
  assert.equal(calls.filter((call) => call.undo === 'part').length, 0, 'not taken for the reply\'s own version');
  assert.equal(fileOf(tidy).status, 'changed');
  assert.equal(fileOf(tidy).partly, undefined);
  assert.equal((await checkpoints.diff(tidy.changes.id, FILE, { workspace: ws })).current, 'changed');
  // Undo all is refused by the record, so the hand edit stays (the typed line shows as a change too).
  assert.equal(marked().length, 2);
  await workspaceUi.reviewAction(app, 'undo-all');
  await settle();
  assert.match(disk(), /^\/\/ mine\n/);
  assert.match(app.toasts.at(-1), /changed since this reply/);
});

test('a file opened from the explorer gets keyboard focus in its text', async (t) => {
  const { app, root } = await setup(t);
  fs.writeFileSync(path.join(root, 'src', 'pad.js'), 'module.exports = {};\n');
  const focused = view.focused;
  assert.equal(await workspaceUi.openFileInTab(app, 'src/pad.js'), true);
  assert.equal(view.focused, focused + 1);
  assert.equal(textOf(view.view.state), 'module.exports = {};\n');
});

test('two changes undone in quick succession are both recorded, one save after the other', async (t) => {
  const { disk, reply, marked, fileOf } = await setup(t);
  const tidy = await reply([
    [' * Formats a Date as YYYY-MM-DD in local time.', ' * Formats a Date as YYYY-MM-DD in the local time zone.'],
    [' * Formats a Date as HH:MM in local time.', ' * Formats a Date as HH:MM (24-hour) in the local time zone.'],
    ['/** Returns a new Date `days` after `date`. */', '/** Returns a new Date `days` after `date` (negative goes back). */'],
  ]);
  assert.equal(marked().length, 3);
  // The second Undo comes while the first one's save is still on its way.
  view.dispatch(undoChangeSpec(view.view.state, marked()[0][0]));
  await new Promise((resolve) => setImmediate(resolve));
  view.dispatch(undoChangeSpec(view.view.state, marked()[1][0]));
  await until(() => fileOf(tidy).partly?.changes === 2, 'both undos to be recorded');
  assert.deepEqual(fileOf(tidy).partly, { changes: 2, lines: [4, 17] });
  assert.equal(fileOf(tidy).status, 'changed');
  assert.deepEqual([fileOf(tidy).added, fileOf(tidy).removed], [1, 1]);
  assert.match(disk(), /HH:MM \(24-hour\) in the local time zone/);
  assert.doesNotMatch(disk(), /negative goes back|YYYY-MM-DD in the local/);
  assert.equal(marked().length, 1);
});
