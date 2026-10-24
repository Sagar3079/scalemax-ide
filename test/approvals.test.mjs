import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_KEY_GUARD_MS, blocksApprovalKey, approvalPlace, pickApproval, approvalTitle, approvalContext, approvalPreview,
  approvalNoticeText, lineDiff, looseString, menuKeyIndex, bindApprovals, syncApprovalPrompt,
} from '../src/composer-ui.js';

// ---- The pure parts ---------------------------------------------------------------------

test('Enter and Space cannot answer a prompt that just appeared, or with a key pressed before it', () => {
  const shownAt = 1000;
  for (const key of ['Enter', ' ', 'Spacebar']) {
    assert.equal(blocksApprovalKey({ key, at: shownAt + 100, shownAt, downAt: shownAt + 100 }), true, `${key} right after it appeared`);
    assert.equal(blocksApprovalKey({ key, at: shownAt + APPROVAL_KEY_GUARD_MS + 100, shownAt, downAt: shownAt + APPROVAL_KEY_GUARD_MS + 100 }), false, `${key} once the user had time to read`);
    assert.equal(blocksApprovalKey({ key, repeat: true, at: shownAt + 5000, shownAt, downAt: shownAt - 50 }), true, `${key} held down since before (auto-repeat)`);
    assert.equal(blocksApprovalKey({ key, at: shownAt + 5000, shownAt, downAt: shownAt - 1 }), true, `${key} pressed before it appeared, released later`);
    assert.equal(blocksApprovalKey({ key, at: shownAt + 5000, shownAt: Number.NaN }), true, 'no prompt time: blocked');
    assert.equal(blocksApprovalKey({ key, at: undefined, shownAt, downAt: undefined }), true, 'a keyup without its keydown');
  }
  for (const key of ['a', 'Tab', 'Escape', 'ArrowDown']) {
    assert.equal(blocksApprovalKey({ key, at: shownAt + 1, shownAt, downAt: shownAt - 5 }), false, `${key} always passes`);
  }
});

test('a prompt of another task or an automation waits; the task on screen and ownerless requests ask at once', () => {
  const app = { currentTaskId: 'api', replyFor: (id) => ({ 'r-api': { taskId: 'api' }, 'r-web': { taskId: 'web' } })[id] || null };
  assert.equal(approvalPlace(app, { requestId: 'r-api' }), 'here');
  assert.equal(approvalPlace(app, { requestId: 'r-web' }), 'background');
  assert.equal(approvalPlace(app, { requestId: 'smoke-approve' }), 'here', 'no reply owns it (the smoke harness)');
  assert.equal(approvalPlace(app, { requestId: 'automation-stamp-1' }), 'background');
  assert.equal(approvalPlace(app, { requestId: 'r-api', automation: 'Stamp changelog' }), 'background');
  const queue = [{ id: 1, place: 'background' }, { id: 2, place: 'here' }];
  assert.equal(pickApproval(queue, (item) => item.place, false).id, 2);
  assert.equal(pickApproval([queue[0]], (item) => item.place, false), null, 'background prompts wait for Review');
  assert.equal(pickApproval([queue[0]], (item) => item.place, true).id, 1);
});

const json = (value) => JSON.stringify(value, null, 2);
const workspace = (toolName, args, extra = {}) => ({ kind: 'workspace', serverId: 'Workspace', serverName: 'Workspace', toolName, arguments: json(args), ...extra });

test('titles say what the call does in words', () => {
  assert.equal(approvalTitle(workspace('edit_file', { path: 'src/format-date.js', old_text: 'a', new_text: 'b' })), 'Edit src/format-date.js?');
  assert.equal(approvalTitle(workspace('write_file', { path: 'SUMMARY.md', content: '# Hi' })), 'Write SUMMARY.md?');
  assert.equal(approvalTitle(workspace('run_command', { command: 'npm test' })), 'Run a command?');
  assert.equal(approvalTitle(workspace('run_command', { command: 'npm run dev', background: true })), 'Start a background command?');
  assert.equal(approvalTitle({ kind: 'mcp', serverId: 'fake-tools', serverName: 'fake-tools', toolName: 'echo', arguments: json({ text: 'hi' }) }), 'Use echo on fake-tools?');
  assert.equal(approvalTitle({ kind: 'mcp', serverId: 'MCP', serverName: 'MCP', toolName: 'read_resource', arguments: json({ server: 'fake-tools', uri: 'memo://notes/1' }) }), 'Read a resource from fake-tools?');
  // The exact strings the smoke check compares stay.
  assert.equal(approvalTitle(workspace('run_command', { command: 'cat ~/.ssh/id' }, { reason: 'unsandboxed' })), 'Run this command outside the sandbox?');
  assert.equal(approvalTitle({ kind: 'web', serverName: 'Web', toolName: 'open_page', reason: 'egress', host: 'collect.invalid', arguments: '{}' }), 'Open an address on collect.invalid?');
  assert.equal(approvalTitle({ kind: 'agents', toolName: 'agent_task', arguments: '{}' }), 'Hand this to a subagent?');
  // A long path keeps its end (the file name), on one line.
  const long = `${'deeply/nested/'.repeat(10)}component.tsx`;
  const title = approvalTitle(workspace('edit_file', { path: long, old_text: 'a', new_text: 'b' }));
  assert.match(title, /^Edit ….*component\.tsx\?$/);
  assert.equal(title.length, 'Edit '.length + 80 + 1);
  assert.equal(approvalTitle(workspace('write_file', { path: 'a\nb.md', content: '' })), 'Write a b.md?');
});

test('the context line names the other task, the automation and the subagent', () => {
  assert.equal(approvalContext({ requestId: 'r' }), 'Tool call');
  assert.equal(approvalContext({ requestId: 'r' }, 'Add a Card component'), 'Tool call · Add a Card component');
  assert.equal(approvalContext({ requestId: 'automation-x-1', automation: 'Stamp changelog' }, 'ignored'), 'Tool call · Automation: Stamp changelog');
  assert.equal(approvalContext({ requestId: 'automation-x-1' }), 'Tool call · Automation');
  assert.equal(approvalContext({ requestId: 'r', subagent: 'Find the tests' }), 'Tool call · Subagent: Find the tests');
});

test('an edit shows as a line diff of real lines, never JSON escapes', () => {
  const preview = approvalPreview(workspace('edit_file', {
    path: 'src/format-date.js',
    old_text: 'module.exports = { formatDate, formatTime, addDays };',
    new_text: '/** Formats a Date. */\nfunction formatDateTime(date) {\n  return `${formatDate(date)} ${formatTime(date)}`;\n}\n\nmodule.exports = { formatDate, formatTime, formatDateTime, addDays };',
  }));
  assert.equal(preview.kind, 'diff');
  assert.equal(preview.path, 'src/format-date.js');
  assert.deepEqual(preview.lines.map((row) => row.type), ['del', 'add', 'add', 'add', 'add', 'add', 'add']);
  assert.equal(preview.lines[0].text, 'module.exports = { formatDate, formatTime, addDays };');
  assert.equal(preview.lines[3].text, '  return `${formatDate(date)} ${formatTime(date)}`;');
  assert.ok(preview.lines.every((row) => !row.text.includes('\\n') && !row.text.includes('\n')));
  assert.equal(preview.note, '');
  assert.match(approvalPreview(workspace('edit_file', { path: 'a', old_text: 'x', new_text: 'y', replace_all: true })).note, /Every occurrence/);
});

test('the line diff keeps three lines of context and folds the rest', () => {
  assert.deepEqual(lineDiff('same\ntext', 'same\ntext'), []);
  const before = Array.from({ length: 20 }, (_line, index) => `line ${index}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const rows = lineDiff(before, after);
  assert.deepEqual(rows.map((row) => row.type), ['gap', 'same', 'same', 'same', 'del', 'add', 'same', 'same', 'same', 'gap']);
  assert.equal(rows[0].count, 7);
  assert.equal(rows.at(-1).count, 6);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc').map((row) => `${row.type}:${row.text}`), ['same:a', 'del:b', 'same:c']);
  // A huge edit is cut at 200 rows, the rest counted.
  const big = lineDiff('', Array.from({ length: 500 }, (_line, index) => `n${index}`).join('\n'));
  assert.equal(big.length, 200);
  assert.deepEqual(big.at(-1), { type: 'gap', count: 301, more: true });
});

test('a new file shows its first 20 lines; a command shows as typed with where it runs', () => {
  const content = Array.from({ length: 30 }, (_line, index) => `line ${index + 1}`).join('\n') + '\n';
  const file = approvalPreview(workspace('write_file', { path: 'SUMMARY.md', content }));
  assert.equal(file.kind, 'file');
  assert.equal(file.path, 'SUMMARY.md');
  assert.equal(file.lines.length, 20);
  assert.equal(file.lines[19], 'line 20');
  assert.equal(file.more, 10);
  assert.equal(approvalPreview(workspace('write_file', { path: 'empty.txt', content: '' })).note, 'The file is empty.');
  const command = approvalPreview(workspace('run_command', { command: 'npm test -- --watch=false', timeout_seconds: 300 }, { folderName: 'api', sandbox: 'offline' }));
  assert.equal(command.kind, 'command');
  assert.equal(command.text, 'npm test -- --watch=false');
  assert.deepEqual(command.notes, ['In the folder "api"', 'In the sandbox, without network', 'Time limit 300 s']);
  const outside = approvalPreview(workspace('run_command', { command: 'ls ~', sandbox: false }, { reason: 'unsandboxed', sandbox: 'on' }));
  assert.ok(outside.notes.includes('Outside the sandbox'));
  const other = approvalPreview({ kind: 'mcp', serverId: 'fake-tools', toolName: 'echo', arguments: '{"text":"a\\nb","n":1}' });
  assert.equal(other.kind, 'json');
  assert.equal(other.text, '{\n  "text": "a\\nb",\n  "n": 1\n}');
});

test('arguments cut at 4 KB are still read: a truncated write shows its path and first lines', () => {
  const full = json({ path: 'a.md', content: 'line\n'.repeat(2000) });
  const cut = `${full.slice(0, 4000)}\n[truncated]`;
  const request = workspace('write_file', {}, { arguments: cut });
  const preview = approvalPreview(request);
  assert.equal(preview.kind, 'file');
  assert.equal(preview.path, 'a.md');
  assert.equal(preview.lines.length, 20);
  assert.ok(preview.lines.every((line) => line === 'line'));
  assert.ok(preview.more > 100);
  assert.equal(preview.atLeast, true);
  assert.match(preview.note, /4 KB/);
  assert.equal(approvalTitle(request), 'Write a.md?');
  // A cut inside an escape drops the half escape.
  assert.equal(looseString('{\n  "text": "a\\nb\\', 'text'), 'a\nb');
  assert.equal(looseString('{\n  "text": "caf\\u00e9 \\u00', 'text'), 'café ');
  assert.equal(looseString('{ "other": "x" }', 'text'), null);
  // Not JSON at all and nothing to read: the text as main sent it (on its own lines).
  const unknown = approvalPreview({ kind: 'mcp', serverId: 's', toolName: 't', arguments: '{\n  "a": [1,\n[truncated]' });
  assert.equal(unknown.kind, 'text');
  assert.ok(unknown.text.includes('\n'));
});

test('the notice bar says who waits and how many calls', () => {
  const who = (item) => item.who;
  assert.equal(approvalNoticeText([], who), '');
  assert.equal(approvalNoticeText([{ who: '"Add a Card component"' }], who), '"Add a Card component" is waiting for your approval');
  assert.equal(approvalNoticeText([{ who: 'A task' }, { who: 'B' }], who), 'A task is waiting for your approval · 2 tool calls waiting');
});

test('menu keys: arrows wrap, Home and End jump, other keys do nothing', () => {
  assert.equal(menuKeyIndex('ArrowDown', -1, 3), 0);
  assert.equal(menuKeyIndex('ArrowDown', 2, 3), 0);
  assert.equal(menuKeyIndex('ArrowUp', -1, 3), 2);
  assert.equal(menuKeyIndex('ArrowUp', 0, 3), 2);
  assert.equal(menuKeyIndex('Home', 2, 3), 0);
  assert.equal(menuKeyIndex('End', 0, 3), 2);
  assert.equal(menuKeyIndex('Enter', 0, 3), -1);
  assert.equal(menuKeyIndex('ArrowDown', -1, 0), -1);
});

// ---- The prompt in a window (a small stand-in for the DOM) ------------------------------

function fakeNode(tag = 'div', id = '') {
  const listeners = {};
  const attributes = new Map();
  const classes = new Set();
  const node = {
    tag, id, className: '', textContent: '', hidden: false, open: false, dataset: {}, children: [], scrollTop: 13, listeners,
    classList: {
      toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    dispatch(type, extra = {}) {
      const event = { type, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...extra };
      for (const listener of listeners[type] || []) listener(event);
      return event;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    append(...items) { node.children.push(...items); },
    replaceChildren(...items) { node.children = items; },
    querySelectorAll(selector) {
      const name = selector.replace(/^\./, '');
      const found = [];
      const walk = (item) => {
        if (!item || typeof item !== 'object') return;
        if (String(item.className).split(' ').includes(name)) found.push(item);
        item.children?.forEach(walk);
      };
      node.children.forEach(walk);
      return found;
    },
    focus(options) { document.activeElement = node; node.focusOptions = options; },
    click() { node.dispatch('click'); },
  };
  return node;
}
// The text a node shows, its children's included.
function shownText(node) {
  if (typeof node === 'string') return node;
  return node.children.length ? node.children.map(shownText).join('') : node.textContent;
}

const ids = ['tool-approval-dialog', 'approval-eyebrow', 'approval-title', 'approval-summary', 'approval-preview', 'approval-raw',
  'approval-arguments', 'approval-all', 'approval-once', 'approval-deny', 'approval-queue', 'approval-body', 'approval-notice',
  'approval-notice-text', 'approval-notice-review'];
const nodes = Object.fromEntries(ids.map((id) => [id, fakeNode(id === 'tool-approval-dialog' ? 'dialog' : 'div', id)]));
const dialog = nodes['tool-approval-dialog'];
dialog.showModal = () => { dialog.open = true; };
// The real close event comes later; firing it at once is the harder case for the denial rule.
dialog.close = () => { dialog.open = false; dialog.dispatch('close'); };
nodes['approval-notice'].hidden = true;
const composer = fakeNode('textarea', 'chat-input');
const windowListeners = {};
globalThis.document = {
  activeElement: composer,
  body: fakeNode('body'),
  querySelector: (selector) => nodes[selector.replace(/^#/, '')] || null,
  createElement: (tag) => fakeNode(tag),
};
globalThis.window = globalThis.window || globalThis;
window.addEventListener = (type, listener) => { (windowListeners[type] ||= []).push(listener); };
let emit = null;
let closed = null;
const responses = [];
window.scalemaxAPI = {
  approvals: {
    onRequest(callback) { emit = callback; },
    onClosed(callback) { closed = callback; },
    respond: async (answer) => { responses.push(answer); return { ok: true, data: { accepted: true } }; },
  },
};
const replies = { 'r-api': { taskId: 'api' }, 'r-web': { taskId: 'web' } };
const app = {
  currentTaskId: 'api',
  tasks: [{ id: 'web', title: 'Add a Card component' }, { id: 'api', title: 'Explain the router' }],
  replyFor: (id) => replies[id] || null,
  toasts: [],
  showToast(text) { app.toasts.push(text); },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (type, name, timeStamp, repeat = false) => {
  const event = { type, key: name, repeat, timeStamp, defaultPrevented: false, stopped: false,
    preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; } };
  for (const listener of windowListeners[type] || []) listener(event);
  return event;
};
bindApprovals(app);
// A second call (bindComposerUi binds it too) changes nothing.
bindApprovals(app);

test('M12: a template resource read asks as one, naming its server (driven through the queue)', async () => {
  assert.equal(typeof emit, 'function');
  emit({
    approvalId: 'a1', requestId: 'r-api', serverId: 'MCP', serverName: 'MCP', kind: 'mcp', toolName: 'read_resource',
    readOnly: true, reason: 'required', arguments: json({ server: 'fake-tools', uri: 'memo://notes/2026-10-23' }),
  });
  assert.equal(dialog.open, true);
  assert.equal(nodes['approval-title'].textContent, 'Read a resource from fake-tools?');
  assert.match(nodes['approval-summary'].textContent, /address it filled in itself/);
  assert.doesNotMatch(nodes['approval-summary'].textContent, /You trust this server's label/);
  assert.equal(nodes['approval-eyebrow'].textContent, 'Tool call');
  // A read that always asks is allowed one at a time.
  assert.equal(nodes['approval-all'].hidden, true);
  // The preview is the arguments, indented: no second copy behind "Show raw arguments".
  assert.equal(nodes['approval-raw'].hidden, true);
  assert.match(shownText(nodes['approval-preview']), /"uri": "memo:\/\/notes\/2026-10-23"/);
  // It starts on the heading, at the top.
  assert.equal(document.activeElement, nodes['approval-title']);
  assert.deepEqual(nodes['approval-title'].focusOptions, { preventScroll: true });
  assert.equal(nodes['approval-body'].scrollTop, 0);
  nodes['approval-deny'].click();
  await settle();
  assert.deepEqual(responses.splice(0), [{ approvalId: 'a1', decision: 'deny' }]);
  assert.equal(dialog.open, false);
});

test('C1: a prompt of a task in the background waits in the notice; typing never answers it', async () => {
  document.activeElement = composer;
  emit({
    approvalId: 'b1', requestId: 'r-web', serverId: 'Workspace', serverName: 'Workspace', kind: 'workspace', toolName: 'write_file',
    readOnly: false, arguments: json({ path: 'src/Card.js', content: 'export function Card() {\n  return null;\n}\n' }), folderName: 'web',
  });
  assert.equal(dialog.open, false, 'no modal over the task the user is typing in');
  assert.equal(document.activeElement, composer, 'the keyboard stays in the message box');
  assert.equal(nodes['approval-notice'].hidden, false);
  assert.equal(nodes['approval-notice-text'].textContent, '"Add a Card component" is waiting for your approval');
  // Enter and Space while typing reach the message box, not a prompt.
  assert.equal(key('keydown', ' ', performance.now()).defaultPrevented, false);
  key('keyup', ' ', performance.now());

  // Review opens it, on its heading.
  nodes['approval-notice-review'].click();
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, nodes['approval-title']);
  assert.equal(nodes['approval-title'].textContent, 'Write src/Card.js?');
  assert.equal(nodes['approval-eyebrow'].textContent, 'Tool call · Add a Card component');
  assert.equal(nodes['approval-notice'].hidden, true);
  assert.equal(nodes['approval-raw'].hidden, false);
  assert.equal(nodes['approval-raw'].open, false);
  assert.equal(shownText(nodes['approval-preview'].children.find((child) => child.className.includes('approval-file'))),
    'export function Card() {\n  return null;\n}');
  // Space or Enter right away, a held key's repeats, and the keyup of a key pressed before it
  // appeared click nothing.
  const now = performance.now();
  const space = key('keydown', ' ', now);
  assert.equal(space.defaultPrevented, true);
  assert.equal(space.stopped, true);
  assert.equal(key('keyup', ' ', now + 50).defaultPrevented, true);
  assert.equal(key('keydown', 'Enter', now + 100).defaultPrevented, true);
  assert.equal(key('keydown', 'Enter', now + 2000, true).defaultPrevented, true);
  assert.equal(key('keyup', 'Enter', now + 2100).defaultPrevented, true);
  assert.equal(key('keyup', 'x', now + 10).defaultPrevented, false);
  // Once the user had a moment, a fresh Enter on a button works again.
  assert.equal(key('keydown', 'Enter', now + APPROVAL_KEY_GUARD_MS + 400).defaultPrevented, false);
  key('keyup', 'Enter', now + APPROVAL_KEY_GUARD_MS + 450);
  // A mouse click (or the smoke harness's element.click()) is never held back.
  nodes['approval-once'].click();
  await settle();
  assert.deepEqual(responses.splice(0), [{ approvalId: 'b1', decision: 'once' }]);
  assert.equal(dialog.open, false);
  assert.equal(nodes['approval-notice'].hidden, true);
});

test('opening the task asks its waiting prompts; "Allow all in this reply" answers them together', async () => {
  for (const approvalId of ['c1', 'c2']) {
    emit({ approvalId, requestId: 'r-web', serverId: 'Workspace', serverName: 'Workspace', kind: 'workspace', toolName: 'edit_file',
      arguments: json({ path: 'src/Card.js', old_text: 'return null;', new_text: 'return card;' }) });
  }
  assert.equal(dialog.open, false);
  assert.equal(nodes['approval-notice-text'].textContent, '"Add a Card component" is waiting for your approval · 2 tool calls waiting');
  app.currentTaskId = 'web';
  syncApprovalPrompt();
  assert.equal(dialog.open, true);
  assert.equal(nodes['approval-title'].textContent, 'Edit src/Card.js?');
  assert.equal(nodes['approval-eyebrow'].textContent, 'Tool call', 'on screen now: no other task to name');
  assert.equal(nodes['approval-queue'].hidden, false);
  assert.equal(nodes['approval-queue'].textContent, '2 waiting');
  const diff = nodes['approval-preview'].children.find((child) => child.className.includes('approval-diff'));
  assert.deepEqual(diff.children.map((row) => row.className), ['diff-line is-del', 'diff-line is-add']);
  assert.equal(shownText(diff.children[0]), '-return null;');
  assert.equal(shownText(diff.children[1]), '+return card;');
  nodes['approval-all'].click();
  await settle();
  assert.deepEqual(responses.splice(0), [{ approvalId: 'c1', decision: 'request' }, { approvalId: 'c2', decision: 'once' }]);
  assert.equal(dialog.open, false);
  app.currentTaskId = 'api';
});

test('an automation waits in the notice by its name; Escape denies', async () => {
  emit({ approvalId: 'd1', requestId: 'automation-stamp-1', automation: 'Stamp changelog', serverId: 'Workspace', serverName: 'Workspace',
    kind: 'workspace', toolName: 'run_command', sandbox: 'on', folderName: 'project', arguments: json({ command: 'npm version patch' }) });
  assert.equal(dialog.open, false);
  assert.equal(nodes['approval-notice-text'].textContent, 'Automation "Stamp changelog" is waiting for your approval');
  nodes['approval-notice-review'].click();
  assert.equal(nodes['approval-eyebrow'].textContent, 'Tool call · Automation: Stamp changelog');
  assert.equal(nodes['approval-title'].textContent, 'Run a command?');
  const preview = nodes['approval-preview'].children;
  assert.equal(shownText(preview.find((child) => child.className.includes('approval-command'))), 'npm version patch');
  assert.equal(shownText(preview.find((child) => child.className === 'approval-notes')), 'In the folder "project" · In the sandbox');
  dialog.dispatch('cancel');
  await settle();
  assert.deepEqual(responses.splice(0), [{ approvalId: 'd1', decision: 'deny' }]);
  assert.equal(dialog.open, false);
});

test('a request no task owns asks at once; a background one queued meanwhile waits for it, then shows in the notice', async () => {
  emit({ approvalId: 'e1', requestId: 'smoke-approve', serverId: 'smoke', serverName: 'Smoke tools', kind: 'mcp', toolName: 'echo',
    arguments: json({ text: 'smoke-echo' }) });
  assert.equal(dialog.open, true);
  assert.equal(nodes['approval-title'].textContent, 'Use echo on Smoke tools?');
  emit({ approvalId: 'e2', requestId: 'r-web', serverId: 'Workspace', serverName: 'Workspace', kind: 'workspace', toolName: 'job_stop',
    arguments: json({ job: 'j2' }) });
  assert.equal(nodes['approval-title'].textContent, 'Use echo on Smoke tools?', 'the prompt on screen stays');
  assert.equal(nodes['approval-queue'].textContent, '2 waiting');
  assert.equal(nodes['approval-notice'].hidden, true);
  nodes['approval-once'].click();
  await settle();
  assert.deepEqual(responses.splice(0), [{ approvalId: 'e1', decision: 'once' }]);
  assert.equal(dialog.open, false);
  assert.equal(nodes['approval-notice'].hidden, false);
  // Its reply ended (Stop): the notice goes.
  closed({ approvalId: 'e2' });
  assert.equal(nodes['approval-notice'].hidden, true);
  assert.equal(dialog.open, false);
  assert.deepEqual(responses, []);
});
