import test from 'node:test';
import assert from 'node:assert/strict';

// src/app.js is the renderer singleton: it needs a document to load. This stand-in has only the
// elements these tests touch (the message box, the picture button, the editor); every other
// lookup finds nothing, which the app handles like a view that is not shown.
function fakeElement(extra = {}) {
  const listeners = {};
  return {
    value: '', disabled: false, hidden: false, readOnly: false, dataset: {}, style: { setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, parentElement: null, listeners,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, append() {},
    replaceChildren() {}, setSelectionRange() {}, querySelector() { return null; },
    ...extra,
  };
}
const nodes = {
  '#chat-input': fakeElement(),
  '#image-btn': fakeElement(),
  '#editor-input': fakeElement(),
  '#editor-tabs': fakeElement(),
};
globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {},
  querySelector: (selector) => nodes[selector] || null,
  querySelectorAll: () => [],
  createElement: () => fakeElement(),
  // SVG (the sidebar's mini mascots, src/mascot.js).
  createElementNS: () => fakeElement({ appendChild: (child) => child }),
  createTextNode: () => fakeElement(),
  activeElement: null,
};

const { default: app } = await import('../src/app.js');
const { bindComposerContext } = await import('../src/context-ui.js');
const { applyProgress } = await import('../src/reply-ui.js');
const { openFileInTab, saveActiveTab, resetTabs } = await import('../src/workspace-ui.js');

const input = nodes['#chat-input'];
const ROOT = '/Users/you/project';

// Fresh app state and a bridge whose provider answers at once (or as `send` says).
function setup({ send } = {}) {
  const sent = [];
  const saved = [];
  const toasts = [];
  window.scalemaxAPI = {
    provider: {
      send: async (payload) => {
        sent.push(payload);
        return send ? send(payload) : { ok: true, data: { text: `reply ${sent.length}` } };
      },
    },
    store: { set: async (key, value) => { saved.push({ key, value }); return true; } },
    media: { pickImage: async () => ({ ok: true, data: { id: 'm-0123456789abcdef', name: 'shot.png' } }) },
  };
  const task = { id: 'task-1', title: 'New Task', messages: [], createdAt: 0, updatedAt: 0, folder: { name: 'project', path: ROOT } };
  Object.assign(app, {
    tasks: [task], currentTaskId: task.id, replies: new Map(), compactingTasks: new Set(),
    provider: { configured: true, model: 'model-a' }, providerCatalog: [], demoBusy: false, attachment: null,
    leaving: false, saveVersions: {}, savedNow: {}, saveQueue: Promise.resolve(),
    workspace: { root: ROOT, files: [], recent: [], openPath: '', revision: '', dirty: false, tree: {}, expanded: new Set() },
    settings: { ...app.settings, composerMode: 'chat', autoCompact: false, permission: 'basic' },
  });
  for (const name of ['renderChat', 'renderFolder', 'renderTasks', 'renderReplyState', 'updateSendEnabled', 'refreshGit']) app[name] = () => {};
  app.showToast = (message) => toasts.push(message);
  return { task, sent, saved, toasts };
}

test('a task deleted while older context is compacted gets no hidden reply', async () => {
  const { task, sent } = setup();
  const compactIfNeeded = app.compactIfNeeded;
  app.compactIfNeeded = async () => {
    // The user deletes the task while the compaction request runs.
    app.tasks = app.tasks.filter((item) => item !== task);
    return true;
  };
  input.value = 'Fix the bug';
  try {
    assert.equal(await app.handleSend(), false);
  } finally {
    app.compactIfNeeded = compactIfNeeded;
  }
  assert.equal(sent.length, 0, 'nothing was sent');
  assert.equal(app.replies.size, 0, 'no reply started for a task that is gone');
  assert.equal(task.messages.length, 0);
  assert.equal(input.value, 'Fix the bug', 'the draft stays in the message box');
});

test('a send goes out and resolves to true once the message is in the task', async () => {
  const { task, sent } = setup();
  input.value = 'Hello';
  assert.equal(await app.handleSend(), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(task.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(input.value, '');
  assert.equal(app.appendMessage('user', 'x', 'no-such-task'), false, 'a message for a missing task is refused');
});

test('an app-written send leaves the pictures waiting in the message box for the user', async () => {
  const { task } = setup();
  bindComposerContext(app);
  // The user picks a picture for the message they are writing.
  for (const listener of nodes['#image-btn'].listeners.click) listener();
  await new Promise((resolve) => setImmediate(resolve));
  input.value = '/init';
  assert.equal(await app.handleSend({ internal: true }), true);
  assert.equal(task.messages[0].text, '/init');
  assert.equal(task.messages[0].images, undefined, '/init does not take the picture');
  input.value = 'What is in this screenshot?';
  assert.equal(await app.handleSend(), true);
  assert.deepEqual(task.messages[2].images, [{ id: 'm-0123456789abcdef', name: 'shot.png' }]);
});

test('closing the window mid-reply keeps the reply in its task, marked as cut off', async () => {
  let finish;
  const { task, saved } = setup({ send: () => new Promise((resolve) => { finish = resolve; }) });
  // The first save is still on its way when the window goes away, so later ones wait behind it.
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  window.scalemaxAPI.store.set = async (key, value) => {
    saved.push({ key, value });
    if (saved.length === 1) await blocked;
    return true;
  };
  input.value = 'Write the report';
  const sending = app.handleSend();
  await new Promise((resolve) => setImmediate(resolve));
  const reply = app.replies.get(task.id);
  assert.ok(reply, 'the reply is running');
  reply.items.push({ type: 'text', text: 'The report starts' });
  // An older snapshot (without the cut-off reply) is queued behind the blocked save.
  void app.persist('tasks');
  const before = saved.length;
  app.keepRunningReplies();
  // Written at once, not behind the save queue.
  assert.equal(saved.length, before + 1);
  const written = saved[saved.length - 1].value.find((item) => item.id === task.id);
  const last = written.messages[written.messages.length - 1];
  assert.equal(last.interrupted, 'closed');
  assert.equal(last.text, 'The report starts');
  assert.match(last.notice, /closed or reloaded/);
  assert.equal(app.replies.size, 0);
  // main's answer arriving late adds nothing more.
  finish({ ok: false, error: { code: 'CANCELLED', message: 'Provider request was cancelled.' } });
  assert.equal(await sending, true);
  assert.equal(task.messages.length, 2);
  // Queued older snapshots of the tasks never land after the one written at once.
  unblock();
  await app.saveQueue;
  const writes = saved.filter((entry) => entry.key === 'tasks').map((entry) => entry.value.find((item) => item.id === task.id).messages.length);
  assert.deepEqual(writes.slice(writes.indexOf(2)), [2], 'nothing older is written after it');
});

test('an automation made without a folder does not tie its task to the open folder', () => {
  setup();
  const output = { id: 'task-2', title: 'Automation · Digest', messages: [], createdAt: 0, updatedAt: 0, automationId: 'a1' };
  const chat = { id: 'task-3', title: 'Old chat', messages: [], createdAt: 0, updatedAt: 0 };
  app.tasks.push(output, chat);
  app.appendMessage('user', 'Summarize', output.id, { bindFolder: false });
  assert.equal(output.folder, undefined);
  app.appendMessage('user', 'Hello', chat.id);
  assert.deepEqual(chat.folder, { name: 'project', path: ROOT }, 'a chat is still fixed to the open folder');
});

test('a refresh keeps open folders open with their contents read again', async () => {
  setup();
  const listings = {
    '': [{ name: 'src', path: 'src', type: 'directory' }],
    src: [{ name: 'new.js', path: 'src/new.js', type: 'file' }],
  };
  window.scalemaxAPI.workspace = {
    list: async (path = '') => (listings[path] ? { ok: true, data: { root: ROOT, files: listings[path] } } : { ok: false, error: { code: 'ENOENT' } }),
  };
  app.workspace.expanded = new Set(['src', 'gone']);
  app.workspace.tree = { src: [{ name: 'old.js', path: 'src/old.js', type: 'file' }], gone: [], closed: [] };
  await app.refreshWorkspace();
  assert.deepEqual([...app.workspace.expanded], ['src']);
  assert.deepEqual(app.workspace.tree, { src: listings.src });
});

test('open editor tabs follow a reply\'s changes, and edits made during a save keep the tab dirty', async () => {
  setup();
  const disk = { 'a.txt': 'one', 'b.txt': 'other' };
  let writing = null;
  window.scalemaxAPI.workspace = {
    list: async () => ({ ok: true, data: { root: ROOT, files: [] } }),
    read: async (path) => (path in disk ? { ok: true, data: { path, content: disk[path], revision: `r-${disk[path]}` } } : { ok: false, error: { code: 'ENOENT' } }),
    write: async ({ path, content }) => {
      if (writing) await writing();
      disk[path] = content;
      return { ok: true, data: { path, revision: `r-${content}` } };
    },
  };
  resetTabs(app);
  assert.equal(await openFileInTab(app, 'a.txt'), true);
  // The reply edits a.txt on disk; its open, clean tab shows the new text afterwards.
  disk['a.txt'] = 'two';
  app.showReplyChanges(ROOT, { changes: { id: 'chat-1', files: [{ path: 'a.txt', kind: 'modified' }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes['#editor-input'].value, 'two');
  // A reply in another folder leaves the tabs alone.
  disk['a.txt'] = 'three';
  app.showReplyChanges('/Users/you/elsewhere', { changes: { id: 'chat-2', files: [{ path: 'a.txt', kind: 'modified' }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes['#editor-input'].value, 'two');
  // Save a.txt, and while the write runs, type more and switch to another tab.
  nodes['#editor-input'].value = 'two, saved';
  writing = async () => {
    writing = null;
    nodes['#editor-input'].value = 'two, saved, and more';
    await openFileInTab(app, 'b.txt');
  };
  assert.equal(await saveActiveTab(app), true);
  const tab = app.workspace.tabs.find((item) => item.path === 'a.txt');
  assert.equal(tab.dirty, true, 'edits typed during the save are still unsaved');
  resetTabs(app);
});

test('in the browser preview a folder opens and a message gets the demo reply', async () => {
  const { task } = setup();
  // No Electron bridge: the preview's stand-in installs itself (src/web-shim.js).
  delete window.scalemaxAPI;
  const info = console.info;
  console.info = () => {};
  window.localStorage = { getItem: () => null, setItem() {} };
  await import('../src/web-shim.js');
  console.info = info;
  delete task.folder;
  Object.assign(app, { provider: { configured: false }, workspace: { root: '', files: [], recent: [], tree: {}, expanded: new Set() } });
  await app.restoreWorkspace();
  input.value = 'hello';
  assert.equal(await app.handleSend(), false, 'no folder yet');
  const opened = await app.openWorkspace();
  assert.equal(opened?.ok, true);
  assert.equal(app.workspace.root, '/preview/demo-project');
  assert.equal(await app.handleSend(), true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(task.messages.map((message) => message.role), ['user', 'assistant']);
  assert.match(task.messages[1].text, /Local demo response/);
  assert.equal(task.folder.path, '/preview/demo-project');
});

test('slash commands: the app\'s own act and send nothing; a custom command sends the prompt main made', async () => {
  const { task, sent, toasts } = setup();
  const expanded = [];
  window.scalemaxAPI.slash = {
    list: async () => ({ ok: true, data: { commands: [] } }),
    expand: async (request) => {
      expanded.push(request);
      if (request.name === 'fix') return { ok: true, data: { name: 'fix', source: 'project', prompt: `Fix issue ${request.arguments} carefully.` } };
      return { ok: false, error: { code: 'NO_COMMAND', message: 'There is no such command.' } };
    },
  };
  input.value = '/cost';
  assert.equal(await app.handleSend(), false);
  assert.equal(sent.length, 0);
  assert.equal(input.value, '', 'an app command empties the box like a sent message');
  assert.match(toasts.at(-1), /No usage recorded for this task yet/);

  const created = [];
  const newTask = app.newTask;
  app.newTask = (options) => { created.push(options); return { id: 'task-2' }; };
  input.value = '/clear';
  try {
    assert.equal(await app.handleSend(), false);
  } finally {
    app.newTask = newTask;
  }
  assert.deepEqual(created, [{ folder: { name: 'project', path: ROOT } }], 'a fresh task in the same folder');
  assert.match(toasts.at(-1), /New task in project/);

  input.value = '/plan';
  assert.equal(await app.handleSend(), false);
  assert.equal(app.settings.permission, 'plan');
  assert.equal(app.settings.prePlanPermission, 'basic');
  app.settings.permission = 'basic';

  input.value = '/fix 42';
  assert.equal(await app.handleSend(), true);
  assert.deepEqual(expanded, [{ folder: ROOT, name: 'fix', arguments: '42' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, 'fix', 'main is told which command, to apply its front matter');
  assert.equal(task.messages[0].text, 'Fix issue 42 carefully.');
  assert.equal(sent[0].messages.at(-1).content, 'Fix issue 42 carefully.');
  assert.equal(input.value, '');

  // Not a command of ours: sent as typed. /review goes to main as typed too (it reviews there).
  input.value = '/tmp is full';
  assert.equal(await app.handleSend(), true);
  assert.equal(sent[1].command, undefined);
  assert.equal(task.messages[2].text, '/tmp is full');
  input.value = '/review naming';
  assert.equal(await app.handleSend(), true);
  assert.equal(task.messages[4].text, '/review naming');
  assert.equal(expanded.length, 2, '/review is never expanded in the window');

  // A command that cannot be made says why and keeps what was typed.
  window.scalemaxAPI.slash.expand = async () => ({ ok: false, error: { code: 'COMMAND_TOO_LARGE', message: '/big grew larger than 512 KiB.' } });
  input.value = '/big x';
  assert.equal(await app.handleSend(), false);
  assert.equal(input.value, '/big x');
  assert.match(toasts.at(-1), /512 KiB/);
});

test('@ names a folder, a web page or a background command: main resolves them; files go along as before', async () => {
  const { sent, toasts } = setup();
  const asked = [];
  window.scalemaxAPI.workspace = {
    read: async (path) => (path === 'src/app.js' ? { ok: true, data: { path, content: 'console.log(1);\n' } } : { ok: false, error: { code: 'ENOENT' } }),
  };
  window.scalemaxAPI.mentions = {
    resolve: async (request) => {
      asked.push(request);
      if (request.kind === 'job') return { ok: false, error: { message: 'There is no background command "j9" in this folder.' } };
      return { ok: true, data: { kind: request.kind, label: request.kind === 'folder' ? 'src/' : request.value, text: `${request.kind} contents` } };
    },
  };
  input.value = 'Look at @src/ and @src/app.js, then read @https://example.com/docs. Also @job:j9 or mail me@example.com';
  assert.equal(await app.handleSend(), true);
  assert.deepEqual(asked, [
    { folder: ROOT, kind: 'folder', value: 'src/' },
    { folder: ROOT, kind: 'url', value: 'https://example.com/docs' },
    { folder: ROOT, kind: 'job', value: 'j9' },
  ]);
  const content = sent[0].messages.at(-1).content;
  assert.match(content, /Folder src\/ \(named by the user with @; [^\n]*\n```\nfolder contents\n```/);
  assert.match(content, /File src\/app\.js \(named by the user with @\):\n```\nconsole\.log\(1\);/);
  assert.match(content, /Web page https:\/\/example\.com\/docs \(named by the user with @; [^\n]*\n```\nurl contents\n```/);
  assert.ok(!content.includes('Background command'), 'what could not be read does not go along');
  assert.match(toasts.at(-1), /^@job:j9 did not go along: There is no background command "j9"/);
});

test('a project\'s own hooks are asked about before a message; allowed by their hash, or sent without them', async () => {
  const { sent, toasts } = setup();
  const hash = 'a'.repeat(64);
  const lists = [];
  const approved = [];
  let pending = true;
  window.scalemaxAPI.hooks = {
    list: async (request) => {
      lists.push(request);
      return { ok: true, data: { folder: { name: 'project', path: ROOT }, scopes: [
        { scope: 'project', pending, approved: !pending, hash, exists: true, errors: [], hooks: [{ id: '0123456789abcdef', event: 'Stop', matcher: '', command: 'say done', timeout: 30, enabled: true }] },
      ] } };
    },
    approve: async (request) => { approved.push(request); pending = false; return { ok: true, data: {} }; },
  };
  // No dialog on screen (it cannot be shown): "Not now", and not asked again for these hooks.
  input.value = 'first';
  assert.equal(await app.handleSend(), true);
  assert.equal(sent.length, 1, 'the message goes out without the hooks');
  assert.match(toasts.at(-1), /hooks will not run/);
  const count = toasts.length;
  input.value = 'second';
  assert.equal(await app.handleSend(), true);
  assert.equal(toasts.length, count, 'not asked again');
  assert.deepEqual(lists.map((request) => request.folder), [ROOT, ROOT]);
  assert.deepEqual(approved, []);

  // With the dialog: "Allow these hooks" allows exactly the hooks shown, by their hash.
  const dialogNodes = ['#hooks-dialog', '#hooks-dialog-allow', '#hooks-dialog-deny', '#hooks-dialog-folder', '#hooks-dialog-list'];
  for (const selector of dialogNodes) nodes[selector] = fakeElement();
  nodes['#hooks-dialog'].showModal = () => setTimeout(() => { for (const listener of nodes['#hooks-dialog-allow'].listeners.click) listener(); });
  nodes['#hooks-dialog'].close = () => {};
  const { sent: sentAgain } = setup();
  window.scalemaxAPI.hooks = {
    list: async () => ({ ok: true, data: { folder: { name: 'project', path: ROOT }, scopes: [
      { scope: 'project', pending: true, hash: 'b'.repeat(64), hooks: [{ id: '0123456789abcdef', event: 'Stop', matcher: '', command: 'say done', timeout: 30 }] },
    ] } }),
    approve: async (request) => { approved.push(request); return { ok: true, data: {} }; },
  };
  input.value = 'third';
  try {
    assert.equal(await app.handleSend(), true);
  } finally {
    for (const selector of dialogNodes) delete nodes[selector];
  }
  assert.deepEqual(approved, [{ folder: ROOT, hash: 'b'.repeat(64) }]);
  assert.equal(sentAgain.length, 1);
});

test('a finished reply keeps how long it took and the time each of its steps ran', async () => {
  const { task } = setup({
    send: ({ requestId }) => {
      // Progress as main streams it, at known times: the read ran 420 ms.
      const reply = app.replyFor(requestId);
      applyProgress(reply, { requestId, phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' }, 1000);
      applyProgress(reply, { requestId, phase: 'tool-done', callId: 'step-1', ok: true }, 1420);
      return { ok: true, data: { text: 'Read it.', steps: [{ type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file' }] } };
    },
  });
  input.value = 'Read a.js';
  assert.equal(await app.handleSend(), true);
  const [, answer] = task.messages;
  assert.equal(answer.steps[0].durationMs, 420);
  assert.ok(Number.isSafeInteger(answer.elapsedMs) && answer.elapsedMs >= 0, 'the reply\'s own time');
  // The companion's moment belongs to this message, and the next reply starts a new one.
  assert.equal(app.companionMoments.get(task.id).message, answer);
  input.value = 'Again';
  assert.equal(await app.handleSend(), true);
  assert.equal(app.companionMoments.get(task.id).message, task.messages[3]);
  // A reply that ended without a message leaves nothing for an unrelated message to take.
  app.companionMoments.set(task.id, { at: Date.now() - 60_000, elapsedMs: 5, message: null });
  app.appendMessage('assistant', 'Local demo response', task.id);
  assert.equal(task.messages.at(-1).elapsedMs, undefined);
});

test('the sidebar row of a task shows its mini mascot state: working, waiting for you, done or failed', () => {
  const { task } = setup();
  const other = { id: 'task-2', title: 'Other', messages: [{ role: 'assistant', text: 'x', time: 0, interrupted: 'failed' }], createdAt: 0, updatedAt: 0 };
  app.tasks.push(other);
  const reply = app.beginReply(task.id, 'chat-task-1-1');
  app.renderTaskRow(task);
  assert.equal(app.taskMoods.get(task.id), 'thinking');
  applyProgress(reply, { phase: 'approval', callId: 'c', title: 'Ran ls', serverId: 'Workspace', toolName: 'run_command' });
  app.updateTaskMood(reply);
  assert.equal(app.taskMoods.get(task.id), 'waiting', 'an approval pending in that task');
  app.endReply(task.id, 'chat-task-1-1', { quiet: true });
  app.unreadTasks.add(other.id);
  app.renderTaskRow(other);
  assert.equal(app.taskMoods.get(other.id), 'error', 'finished while away, and failed');
  app.unreadTasks.delete(other.id);
  app.renderTaskRow(other);
  assert.equal(app.taskMoods.has(other.id), false, 'idle tasks show nothing');
});

test('an active sidebar row prints its state tag and time under the title; idle rows keep one line', () => {
  const { task } = setup();
  const createElement = document.createElement;
  const escape = globalThis.CSS;
  // Elements that keep their children and classes, so the row's structure can be read back.
  document.createElement = (tag) => {
    const classes = new Set();
    const node = fakeElement({
      tag, children: [],
      append(...kids) { this.children.push(...kids); },
      classList: { add: (name) => classes.add(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    });
    return node;
  };
  globalThis.CSS = { escape: (value) => value };
  try {
    const other = { id: 'task-2', title: 'Other', messages: [{ role: 'assistant', text: 'x', time: 0, interrupted: 'failed' }], createdAt: 0, updatedAt: Date.now() - 5 * 60_000 };
    const idle = { id: 'task-3', title: 'Idle', messages: [{ role: 'user', text: 'x', time: 0 }], createdAt: 0, updatedAt: Date.now() - 2 * 60_000 };
    app.tasks.push(other, idle);
    const reply = app.beginReply(task.id, 'chat-task-1-2');
    const row = app.renderTaskRow(task);
    const [status, title, line] = row.children;
    assert.match(status.className, /\btask-status\b.*\bis-running\b.*\bhas-mascot\b/);
    assert.equal(title.className, 'task-title');
    assert.ok(row.classList.contains('has-state'));
    assert.equal(line.className, 'task-state-line');
    const [tag, time] = line.children;
    assert.equal(tag.className, 'sm-state-tag task-state-tag');
    assert.deepEqual([tag.dataset.state, tag.textContent], ['working', 'Working']);
    assert.match(time.className, /\btask-state-time\b/);
    assert.match(time.textContent, /^\d+s$/);
    assert.equal(time.dataset.startedAt, String(reply.startedAt));
    // An approval: the tag turns to the highlighter in place.
    nodes[`.task-item[data-task-id="${task.id}"]`] = fakeElement({
      querySelector: (selector) => (selector === '.task-status' ? status : selector === '.task-state-tag' ? tag : null),
    });
    applyProgress(reply, { phase: 'approval', callId: 'c', title: 'Ran ls', serverId: 'Workspace', toolName: 'run_command' });
    app.updateTaskMood(reply);
    assert.deepEqual([tag.dataset.state, tag.textContent], ['waiting', 'Waiting for you']);
    app.endReply(task.id, 'chat-task-1-2', { quiet: true });
    // Finished while away: DONE, or FAILED, with when it ended.
    app.unreadTasks.add(other.id);
    const failed = app.renderTaskRow(other).children[2].children;
    assert.deepEqual([failed[0].dataset.state, failed[0].textContent, failed[1].textContent], ['failed', 'Failed', '5m ago']);
    other.messages[0].interrupted = undefined;
    assert.deepEqual(app.renderTaskRow(other).children[2].children[0].dataset.state, 'done');
    app.unreadTasks.delete(other.id);
    // Idle: title and time, one line, no tag.
    const quiet = app.renderTaskRow(idle);
    assert.deepEqual(quiet.children.map((node) => node.className), ['task-title', 'task-time']);
    assert.equal(quiet.children[1].textContent, '2m ago');
    assert.equal(quiet.classList.contains('has-state'), false);
  } finally {
    document.createElement = createElement;
    delete nodes[`.task-item[data-task-id="task-1"]`];
    if (escape === undefined) delete globalThis.CSS;
    else globalThis.CSS = escape;
  }
});

test('the companion switch hides every mascot and is saved with the settings', () => {
  setup();
  const toggled = [];
  document.body = fakeElement({ classList: { toggle: (name, on) => toggled.push([name, on]) } });
  nodes['#companion-toggle'] = fakeElement({ type: 'checkbox', checked: true });
  try {
    app.settings.companion = false;
    app.renderCompanionToggle();
    assert.deepEqual(toggled.at(-1), ['companion-off', true]);
    assert.equal(nodes['#companion-toggle'].checked, false);
    app.settings.companion = true;
    app.renderCompanionToggle();
    assert.deepEqual(toggled.at(-1), ['companion-off', false]);
    assert.equal(nodes['#companion-toggle'].checked, true);
    // Without the switch on the page (not added yet), the body class still follows the setting.
    delete nodes['#companion-toggle'];
    app.settings.companion = false;
    app.renderCompanionToggle();
    assert.deepEqual(toggled.at(-1), ['companion-off', true]);
  } finally {
    delete nodes['#companion-toggle'];
    delete document.body;
    app.settings.companion = true;
  }
});
