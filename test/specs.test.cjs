'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace.cjs');
const {
  createSpecStore, createSpecTools, slugify, parseTasks, withTaskState, progressOf, docPath, DOCS,
} = require('../lib/specs.cjs');

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-specs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function open(t) {
  const root = project(t);
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const changes = [];
  const store = createSpecStore({ getWorkspace: () => workspace, onChange: (change) => changes.push(change) });
  const tools = createSpecTools({ getWorkspace: () => workspace, onChange: (change) => changes.push(change) });
  return { root, workspace, store, tools, changes };
}

test('a feature name becomes a safe slug, and unusable names are refused', () => {
  assert.equal(slugify('Offline Sync!'), 'offline-sync');
  assert.equal(slugify('  --Weird__Name--  '), 'weird-name');
  assert.equal(slugify('../escape'), 'escape');
  assert.equal(slugify('...'), '');
  // Nothing is truncated: two long names must not collapse into one spec and overwrite each other.
  assert.equal(slugify('a'.repeat(80)), '');
  assert.equal(slugify('a'.repeat(48)).length, 48);
  assert.throws(() => docPath('a'.repeat(80), 'tasks'), { code: 'INVALID_SPEC', message: /at most 48 characters/ });
  assert.equal(docPath('Offline Sync', 'tasks'), '.scalemax/specs/offline-sync/tasks.md');
});

test('task checkboxes are numbered, counted and ticked without touching the rest of the file', () => {
  const content = '# Tasks\n\n- [ ] First step\n  - [x] A subtask\n* [ ] Second step\nnot a task\n';
  const tasks = parseTasks(content);
  assert.deepEqual(tasks.map((task) => [task.number, task.done, task.depth, task.text]), [
    [1, false, 0, 'First step'], [2, true, 1, 'A subtask'], [3, false, 0, 'Second step'],
  ]);
  assert.deepEqual(progressOf(content), { total: 3, done: 1 });
  const next = withTaskState(content, 1, true);
  assert.equal(next.content, '# Tasks\n\n- [x] First step\n  - [x] A subtask\n* [ ] Second step\nnot a task\n');
  assert.equal(next.task.done, true);
  assert.equal(withTaskState(content, 2, true), null, 'a task that is already done changes nothing');
  assert.equal(withTaskState(content, 9, true), null);
});

test('Windows line endings and fenced examples do not break the task list', () => {
  // A file saved on Windows: splitting on \n leaves a \r, which must not hide every task.
  const crlf = '# Tasks\r\n\r\n- [ ] One\r\n- [x] Two\r\n';
  assert.deepEqual(parseTasks(crlf).map((task) => [task.number, task.done, task.text]), [[1, false, 'One'], [2, true, 'Two']]);
  assert.deepEqual(progressOf(crlf), { total: 2, done: 1 });
  // The endings survive the tick, so the whole file does not look rewritten in Git.
  assert.equal(withTaskState(crlf, 1, true).content, '# Tasks\r\n\r\n- [x] One\r\n- [x] Two\r\n');
  // A checklist inside a code block is an example of the format, not a task of this spec.
  const fenced = '- [ ] Real one\n\n```md\n- [ ] Example\n- [x] Example done\n```\n\n- [ ] Real two\n';
  assert.deepEqual(parseTasks(fenced).map((task) => task.text), ['Real one', 'Real two']);
  assert.equal(withTaskState(fenced, 2, true).content,
    '- [ ] Real one\n\n```md\n- [ ] Example\n- [x] Example done\n```\n\n- [x] Real two\n', 'the example is left alone');
  assert.deepEqual(parseTasks('~~~\n- [ ] Example\n~~~\n').map((task) => task.text), []);
  // A numbered list is not a checkbox list, and nothing pretends otherwise.
  assert.deepEqual(parseTasks('1. [ ] Add the queue\n'), []);
});

test('the store writes the three documents, reads them back and records them for undo', async (t) => {
  const { root, store, changes } = await open(t);
  assert.deepEqual(await store.list(), []);
  const created = await store.write('Offline Sync', 'requirements', '# Requirements\n\n1. It works offline.');
  assert.equal(created.path, '.scalemax/specs/offline-sync/requirements.md');
  assert.equal(created.created, true);
  assert.equal(fs.readFileSync(path.join(root, created.path), 'utf8'), '# Requirements\n\n1. It works offline.\n');
  assert.equal(changes.at(-1).before, null, 'a new document is recorded as created');
  await store.write('offline-sync', 'design', '# Design\n');
  await store.write('offline-sync', 'tasks', '- [ ] Cache reads\n- [ ] Queue writes\n');
  const listed = await store.list();
  assert.deepEqual(listed, [{ slug: 'offline-sync', docs: { requirements: true, design: true, tasks: true }, progress: { total: 2, done: 0 } }]);
  const spec = await store.read('offline-sync');
  assert.deepEqual(Object.keys(spec.docs), DOCS);
  assert.equal(spec.tasks.length, 2);
  // Replacing a document keeps the earlier text for review and undo.
  const replaced = await store.write('offline-sync', 'design', '# Design\n\nUse a write-through cache.\n');
  assert.equal(replaced.created, false);
  assert.match(changes.at(-1).before, /^# Design/);
  assert.equal((await store.write('offline-sync', 'design', '# Design\n\nUse a write-through cache.\n')).unchanged, true);
  await assert.rejects(store.read('nothing-here'), { code: 'NO_SPEC' });
  await assert.rejects(store.write('offline-sync', 'notes', 'x'), { code: 'INVALID_DOC' });
  await assert.rejects(store.write('offline-sync', 'design', '   '), { code: 'INVALID_CONTENT' });
});

test('ticking a task off updates only that line and reports the progress', async (t) => {
  const { root, store } = await open(t);
  await store.write('ship-it', 'tasks', '- [ ] One\n- [ ] Two\n');
  const done = await store.setTask('ship-it', 2, true);
  assert.equal(done.task.text, 'Two');
  assert.deepEqual(done.progress, { total: 2, done: 1 });
  assert.equal(fs.readFileSync(path.join(root, '.scalemax/specs/ship-it/tasks.md'), 'utf8'), '- [ ] One\n- [x] Two\n');
  assert.equal((await store.setTask('ship-it', 2, true)).unchanged, true);
  assert.deepEqual((await store.setTask('ship-it', 2, false)).progress, { total: 2, done: 0 });
  await assert.rejects(store.setTask('ship-it', 9, true), { code: 'INVALID_TASK' });
  await assert.rejects(store.setTask('no-spec-here', 1, true), { code: 'NO_SPEC' });
});

test('a task list that changed since it was read is not ticked by number', async (t) => {
  const { root, store } = await open(t);
  await store.write('ship-it', 'tasks', '- [ ] One\n- [ ] Two\n');
  const read = await store.read('ship-it');
  assert.match(read.tasksRevision, /^[a-f0-9]{64}$/);
  // The user inserts a step by hand, so task 2 is no longer the "Two" the window is showing.
  const file = path.join(root, '.scalemax/specs/ship-it/tasks.md');
  fs.writeFileSync(file, '- [ ] Zero\n- [ ] One\n- [ ] Two\n');
  await assert.rejects(store.setTask('ship-it', 2, true, { revision: read.tasksRevision }), { code: 'SPEC_CHANGED' });
  assert.equal(fs.readFileSync(file, 'utf8'), '- [ ] Zero\n- [ ] One\n- [ ] Two\n', 'nothing was ticked');
  // With the revision of what is on disk now, the same tick goes through.
  const fresh = await store.read('ship-it');
  assert.deepEqual((await store.setTask('ship-it', 2, true, { revision: fresh.tasksRevision })).task.text, 'One');
});

test('the model ticks against the task list it read: an edit in between is refused, not mis-ticked', async (t) => {
  const { root, tools } = await open(t);
  await tools.call('spec_write', { spec: 'ship-it', doc: 'tasks', content: '- [ ] One\n- [ ] Two\n' });
  await tools.call('spec_read', { spec: 'ship-it' });
  // The user inserts a step by hand: the model's "task 2" was "Two", which is now task 3.
  const file = path.join(root, '.scalemax/specs/ship-it/tasks.md');
  fs.writeFileSync(file, '- [ ] Zero\n- [ ] One\n- [ ] Two\n');
  await assert.rejects(tools.call('spec_task', { spec: 'ship-it', task: 2 }), { code: 'SPEC_CHANGED' });
  assert.equal(fs.readFileSync(file, 'utf8'), '- [ ] Zero\n- [ ] One\n- [ ] Two\n', 'nothing was ticked');
  // After reading again the numbers are current, and ticks in a row keep working.
  await tools.call('spec_read', { spec: 'ship-it' });
  assert.match((await tools.call('spec_task', { spec: 'ship-it', task: 3 })).text, /is now done: Two/);
  assert.match((await tools.call('spec_task', { spec: 'ship-it', task: 1 })).text, /is now done: Zero/);
  assert.equal(fs.readFileSync(file, 'utf8'), '- [x] Zero\n- [ ] One\n- [x] Two\n');
});

test('one unreadable document does not hide the other specs of the folder', async (t) => {
  const { root, store } = await open(t);
  await store.write('good-one', 'requirements', '# Fine\n');
  await store.write('big-one', 'tasks', '- [ ] Something\n');
  // Bigger than the workspace read limit, so reading it rejects.
  fs.writeFileSync(path.join(root, '.scalemax/specs/big-one/tasks.md'), 'x'.repeat(1024 * 1024 + 10));
  const listed = await store.list();
  assert.deepEqual(listed.map((spec) => [spec.slug, spec.docs.tasks, spec.progress.total]), [['big-one', true, 0], ['good-one', false, 0]]);
});

test('a task list with no checkbox line is written but called out', async (t) => {
  const { tools } = await open(t);
  const written = await tools.call('spec_write', { spec: 'no-boxes', doc: 'tasks', content: '1. Add the queue\n2. Flush it\n' });
  assert.match(written.text, /no "- \[ \] step" lines/);
  const read = await tools.call('spec_read', { spec: 'no-boxes' });
  assert.doesNotMatch(read.text, /tasks by number/, 'there are no numbered tasks to show');
});

test('the model gets four spec tools that walk it through the three documents', async (t) => {
  const { tools } = await open(t);
  const names = tools.definitions().map((definition) => definition.function.name);
  assert.deepEqual(names, ['spec_list', 'spec_read', 'spec_write', 'spec_task']);
  for (const definition of tools.definitions()) assert.ok(definition.function.description.length <= 1024, definition.function.name);
  assert.deepEqual(tools.resolve('spec_read'), { serverId: 'Specs', toolName: 'spec_read', readOnly: true });
  assert.equal(tools.resolve('spec_write').readOnly, false);
  assert.equal(tools.resolve('spec_task').readOnly, false);
  assert.equal(tools.resolve('nope'), null);
  assert.match((await tools.call('spec_list', {})).text, /no specs yet/);
  const written = await tools.call('spec_write', { spec: 'Offline Sync', doc: 'requirements', content: '1. Works offline.' });
  assert.match(written.text, /Created \.scalemax\/specs\/offline-sync\/requirements\.md/);
  assert.match(written.text, /before you write design/, 'the reply is told to get the requirements approved first');
  await tools.call('spec_write', { spec: 'offline-sync', doc: 'tasks', content: '- [ ] Cache reads\n' });
  assert.match((await tools.call('spec_list', {})).text, /offline-sync · 0\/1 tasks done · missing: design/);
  const read = await tools.call('spec_read', { spec: 'offline-sync' });
  assert.match(read.text, /--- requirements\.md ---/);
  // The numbers spec_task takes, without showing a checkbox style parseTasks would refuse back.
  assert.match(read.text, /1: Cache reads — open/);
  assert.match(read.text, /Not written yet: design/);
  const ticked = await tools.call('spec_task', { spec: 'offline-sync', task: 1 });
  assert.match(ticked.text, /is now done: Cache reads \(1\/1 tasks done\)/);
  assert.equal(tools.describeCall('spec_write', { spec: 'offline-sync', doc: 'design' }), 'Wrote design of offline-sync');
  assert.equal(tools.describeCall('spec_task', { spec: 'offline-sync', task: 2 }), 'Ticked task 2 of offline-sync');
});

test('without an open folder there are no spec tools', async () => {
  const workspace = createWorkspace({ approve: async () => true });
  const tools = createSpecTools({ getWorkspace: () => workspace });
  assert.deepEqual(tools.definitions(), []);
  assert.equal(tools.resolve('spec_list'), null);
  await assert.rejects(tools.call('spec_list', {}), { code: 'NO_WORKSPACE' });
  workspace.dispose();
});
