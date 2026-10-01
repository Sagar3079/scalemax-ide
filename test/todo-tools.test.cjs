'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTodoTools, todoLines } = require('../lib/todo-tools.cjs');
const { createFileFinder, listFiles, rankFiles } = require('../lib/file-find.cjs');
const { createProgressForwarder } = require('../lib/progress.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');

test('the to-do tool keeps the whole list, says where it stands, and never runs side by side', async () => {
  const tools = createTodoTools({ initial: [{ content: 'Left from before', status: 'pending' }] });
  assert.deepEqual(tools.current(), [{ content: 'Left from before', status: 'pending' }]);
  assert.deepEqual(tools.definitions().map((definition) => definition.function.name), ['todo_write']);
  assert.deepEqual(tools.resolve('todo_write'), { serverId: 'Todos', toolName: 'todo_write', readOnly: true, exclusive: true });
  const todos = [{ content: 'Read  the\nparser', status: 'completed' }, { content: 'Add the test', status: 'in_progress' }, { content: 'Run it', status: 'bogus' }];
  const result = await tools.call('todo_write', { todos });
  assert.deepEqual(result.todos, [
    { content: 'Read the parser', status: 'completed' }, { content: 'Add the test', status: 'in_progress' }, { content: 'Run it', status: 'pending' },
  ]);
  assert.match(result.text, /1 of 3 done/);
  assert.equal(todoLines(result.todos), '1. [x] Read the parser\n2. [~] Add the test\n3. [ ] Run it');
  assert.equal(tools.describeCall('todo_write', { todos }), 'To-do: Add the test');
  // Two items in progress is allowed but called out; everything done says so.
  assert.match((await tools.call('todo_write', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] })).text, /Only one item/);
  assert.match((await tools.call('todo_write', { todos: [{ content: 'a', status: 'completed' }] })).text, /Every item is done/);
  await assert.rejects(tools.call('todo_write', {}), /whole list/);
  await assert.rejects(tools.call('todo_write', { todos: Array.from({ length: 31 }, (_, index) => ({ content: `${index}`, status: 'pending' })) }), /at most 30/);
  assert.equal((await tools.call('todo_write', { todos: [] })).text, 'To-do list cleared.');
});

test('@-mentions find files by name: name matches first, then path, then letters in order', () => {
  const files = ['src/parser.js', 'src/app.js', 'test/parser.test.js', 'docs/parsing-notes.md', 'lib/sparse.cjs', 'README.md'];
  assert.deepEqual(rankFiles(files, 'parser'), ['src/parser.js', 'test/parser.test.js']);
  assert.deepEqual(rankFiles(files, '@src/app'), ['src/app.js']);
  assert.equal(rankFiles(files, 'prs')[0], 'src/parser.js', 'letters in order');
  assert.deepEqual(rankFiles(files, 'zzz'), []);
  // An empty query lists the shallowest files first.
  assert.equal(rankFiles(files, '')[0], 'README.md');
});

test('the finder walks the open folder through the workspace guards and skips build folders', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-find-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['src/app.js', 'src/deep/util.js', 'node_modules/pkg/index.js', 'dist/app.js', '.env', 'README.md']) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x');
  }
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const listed = await listFiles(workspace);
  assert.deepEqual(listed.files.sort(), ['README.md', 'src/app.js', 'src/deep/util.js']);
  assert.equal(listed.complete, true);
  // Keys typed while the folder is still being walked wait for that one walk.
  let lists = 0;
  const counted = { current: () => workspace.current(), list: (folder) => { lists += 1; return workspace.list(folder); } };
  const finder = createFileFinder({ getWorkspace: () => counted });
  const [first, second] = await Promise.all([finder.find('app'), finder.find('util')]);
  assert.deepEqual(first.files, ['src/app.js']);
  assert.deepEqual(second.files, ['src/deep/util.js']);
  const walked = lists;
  assert.deepEqual((await finder.find('read')).files, ['README.md']);
  assert.equal(lists, walked, 'one walk for all three');
  // No folder open: nothing.
  const empty = createWorkspace({ approve: async () => true });
  t.after(() => empty.dispose());
  assert.deepEqual((await createFileFinder({ getWorkspace: () => empty }).find('app')).files, []);
});

test('a retry resets what the round showed, then says so', () => {
  const sent = [];
  const forward = createProgressForwarder({ send: (event) => sent.push(event), setTimer: () => 1, clearTimer: () => {} });
  forward.push({ requestId: 'r', phase: 'thinking', round: 0 });
  forward.push({ requestId: 'r', phase: 'delta', kind: 'text', text: 'Half an ans' });
  forward.flush();
  forward.push({ requestId: 'r', phase: 'retry', attempt: 1 });
  forward.push({ requestId: 'r', phase: 'delta', kind: 'text', text: 'Whole answer.' });
  forward.flush();
  assert.deepEqual(sent.map((event) => [event.phase, event.text ?? '']), [
    ['thinking', ''], ['delta', 'Half an ans'], ['text-set', ''], ['retry', ''], ['delta', 'Whole answer.'],
  ]);
});
