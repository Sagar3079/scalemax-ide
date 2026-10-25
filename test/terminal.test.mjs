import test from 'node:test';
import assert from 'node:assert/strict';

// The Workspace Terminal panel (src/terminal.js) on a small stand-in page: echoed commands,
// output kept across runs, the result line, ↑ / ↓ history and Clear, per folder.

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.value = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.clientHeight = 100;
    this.ownText = '';
    const node = this;
    this.classList = {
      contains: (name) => node.className.split(/\s+/).includes(name),
      add: (name) => { if (!node.classList.contains(name)) node.className = `${node.className} ${name}`.trim(); },
      remove: (name) => { node.className = node.className.split(/\s+/).filter((item) => item && item !== name).join(' '); },
    };
  }
  get children() { return this.childNodes.filter((child) => child.tagName !== '#TEXT'); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.tagName === '#TEXT' ? this.ownText : this.childNodes.map((child) => child.textContent).join('\n'); }
  set textContent(value) { this.childNodes = []; this.ownText = String(value); if (this.tagName !== '#TEXT') this.append(text(value)); }
  // 20px per line of text, as in the panel.
  get scrollHeight() { return this.textContent.split('\n').length * 20; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...nodes);
  }
  after(node) {
    const parent = this.parentNode;
    const next = parent.childNodes[parent.childNodes.indexOf(this) + 1] || null;
    parent.insertBefore(node, next);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setSelectionRange(start, end) { this.selection = [start, end]; }
  focus() {}
  matches(selector) { return selector.startsWith('.') && this.classList.contains(selector.slice(1)); }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  // Runs the listeners; resolves after async ones (submit) have finished.
  async fire(type, init = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: this, ...init };
    await Promise.all((this.listeners[type] || []).map((listener) => listener(event)));
    return event;
  }
}
function text(value) {
  const node = new Node('#text');
  node.ownText = String(value);
  return node;
}

const page = {};
function element(tag, id) {
  const node = new Node(tag);
  node.id = id;
  page[`#${id}`] = node;
  return node;
}
const form = element('form', 'terminal-form');
const input = element('input', 'terminal-command');
const run = element('button', 'terminal-run');
const cancel = element('button', 'terminal-cancel');
const output = element('pre', 'terminal-output');
form.append(input, run, cancel);

globalThis.window = globalThis;
globalThis.document = {
  querySelector: (selector) => page[selector] || null,
  createElement: (tag) => new Node(tag),
  createTextNode: (value) => text(value),
};

// The bridge answers with whatever the test puts next in `answers`.
const answers = [];
const commands = [];
window.scalemaxAPI = {
  workspace: {
    run: async ({ command }) => {
      commands.push(command);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next || { ok: true, data: { stdout: '', stderr: '', exitCode: 0 } };
    },
    cancel: async () => ({ ok: true, data: false }),
  },
};

const terminal = await import('../src/terminal.js');
const app = { workspace: { root: '/work/app' }, toasts: [], showToast(message) { this.toasts.push(message); } };
terminal.bindTerminal(app);

async function runCommand(command, answer) {
  if (answer) answers.push(answer);
  input.value = command;
  return form.fire('submit');
}
const runBlocks = () => output.querySelectorAll('.ws-term-run');
const key = (name, extra = {}) => input.fire('keydown', { key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
const ok = (stdout, exitCode = 0, stderr = '') => ({ ok: true, data: { stdout, stderr, exitCode } });
const clearPanel = () => output.fire('keydown', { key: 'l', ctrlKey: true, metaKey: false, altKey: false });

test('the duration reads in ms, seconds or minutes', () => {
  assert.equal(terminal.formatDuration(320.4), '320 ms');
  assert.equal(terminal.formatDuration(1234), '1.2 s');
  assert.equal(terminal.formatDuration(59_940), '59.9 s');
  assert.equal(terminal.formatDuration(125_000), '2 min 5 s');
  assert.equal(terminal.formatDuration(-5), '0 ms');
});

test('history: ↑ steps back from the draft, ↓ forward and back to the draft', () => {
  const history = terminal.createHistory(3);
  assert.equal(history.previous('x'), null, 'nothing yet');
  for (const command of ['a', 'b', 'b', 'c', 'd']) history.push(command);
  assert.deepEqual(history.entries, ['b', 'c', 'd'], 'repeats once, capped');
  assert.equal(history.previous('draft'), 'd');
  assert.equal(history.previous(), 'c');
  assert.equal(history.previous(), 'b');
  assert.equal(history.previous(), null, 'oldest reached');
  assert.equal(history.next(), 'c');
  assert.equal(history.next(), 'd');
  assert.equal(history.next(), 'draft');
  assert.equal(history.next(), null);
});

test('each run is echoed, appended after the earlier ones and ends with its exit code and time', async () => {
  assert.ok(page['#terminal-clear'] || form.children.find((node) => node.id === 'terminal-clear'), 'Clear sits in the form');
  assert.deepEqual(form.children.map((node) => node.id), ['terminal-command', 'terminal-run', 'terminal-cancel', 'terminal-clear']);
  assert.equal(output.childNodes.length, 0, 'empty: the placeholder shows');
  await runCommand('npm test', ok('# tests 3\n# pass 3\n'));
  await runCommand('npm run lint', ok('', 1, 'src/a.js: missing semicolon\n'));
  assert.deepEqual(commands.slice(-2), ['npm test', 'npm run lint']);
  const [first, second] = runBlocks();
  assert.equal(first.querySelector('.ws-term-cmd').textContent, '$ \nnpm test');
  assert.equal(first.querySelector('.ws-term-out').textContent, '# tests 3\n# pass 3', 'one final line break dropped');
  assert.match(first.querySelector('.ws-term-result').textContent, /^Exit code 0 · \d+ ms$/);
  assert.ok(first.querySelector('.ws-term-result').classList.contains('is-ok'));
  assert.equal(second.querySelector('.ws-term-out'), null, 'no empty stdout block');
  assert.equal(second.querySelector('.ws-term-err').textContent, 'src/a.js: missing semicolon');
  assert.ok(second.querySelector('.ws-term-result').classList.contains('is-failed'));
  assert.equal(input.value, '', 'the input is ready for the next command');
  assert.equal(output.querySelector('.ws-term-status'), null, 'Running… is gone');
  assert.equal(run.disabled, false);
});

test('a stopped command, a refusal and a thrown error each end with their own line', async () => {
  await clearPanel();
  await runCommand('sleep 99', ok('', null));
  await runCommand('sleep 100', { ok: false, error: { code: 'COMMAND_CANCELLED', message: 'Command cancelled.' } });
  await runCommand('make', { ok: false, error: { code: 'COMMAND_TIMEOUT', message: 'Command exceeded 30 seconds; the process group was terminated.' } });
  await runCommand('boom', new Error('Bridge gone'));
  const lines = runBlocks().map((block) => block.querySelector('.ws-term-result'));
  assert.match(lines[0].textContent, /^Stopped · /);
  assert.ok(lines[0].classList.contains('is-stopped'));
  assert.match(lines[1].textContent, /^Command cancelled\. · /);
  assert.ok(lines[1].classList.contains('is-stopped'));
  assert.match(lines[2].textContent, /^Command exceeded 30 seconds/);
  assert.ok(lines[2].classList.contains('is-failed'));
  assert.match(lines[3].textContent, /^Bridge gone · /);
  assert.deepEqual(app.toasts, [], 'failures show in the panel, not as toasts');
});

test('the panel follows the end while the reader is there, and leaves a reader who scrolled up', async () => {
  await clearPanel();
  await runCommand('seq 20', ok(Array.from({ length: 20 }, (_, i) => String(i + 1)).join('\n')));
  assert.equal(output.scrollTop, output.scrollHeight, 'at the end after the run');
  output.scrollTop = 0;
  await runCommand('seq 30', ok('…'));
  assert.equal(output.scrollTop, output.scrollHeight, 'a new command always goes to the end');
  // The reader scrolls up while a command runs: its result does not pull them down.
  let release;
  window.scalemaxAPI.workspace.run = () => new Promise((resolve) => { release = resolve; });
  input.value = 'npm test';
  const pending = form.fire('submit');
  assert.ok(output.querySelector('.ws-term-status'), 'Running… shows meanwhile');
  assert.equal(run.disabled, true);
  output.scrollTop = 0;
  release(ok('lots\nof\noutput'));
  await pending;
  assert.equal(output.scrollTop, 0, 'left where they were reading');
  window.scalemaxAPI.workspace.run = async ({ command }) => { commands.push(command); return answers.shift() || ok(''); };
});

test('↑ and ↓ in the command field recall this folder\'s commands, keeping the draft', async () => {
  input.value = 'git sta';
  let event = await key('ArrowUp');
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, 'npm test');
  await key('ArrowUp');
  assert.equal(input.value, 'seq 30');
  assert.deepEqual(input.selection, [6, 6], 'caret at the end');
  await key('ArrowDown');
  assert.equal(input.value, 'npm test');
  await key('ArrowDown');
  assert.equal(input.value, 'git sta', 'the draft comes back');
  event = await key('ArrowUp', { shiftKey: true });
  assert.equal(event.defaultPrevented, false, 'Shift+↑ selects text as usual');
  input.value = '';
});

test('Ctrl+L and Clear empty the panel but keep the history; a run under way still reports', async () => {
  await runCommand('echo hi', ok('hi'));
  assert.ok(runBlocks().length > 0);
  const event = await key('l', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(output.childNodes.length, 0, 'empty again: the placeholder shows');
  await key('ArrowUp');
  assert.equal(input.value, 'echo hi', 'history kept');
  input.value = '';
  // Clear while a command runs: the running block stays and gets its result.
  await runCommand('echo before', ok('before'));
  let release;
  window.scalemaxAPI.workspace.run = () => new Promise((resolve) => { release = resolve; });
  input.value = 'npm test';
  const pending = form.fire('submit');
  await form.children.find((node) => node.id === 'terminal-clear').fire('click');
  assert.equal(runBlocks().length, 1, 'only the running command is left');
  release(ok('done'));
  await pending;
  assert.equal(runBlocks()[0].querySelector('.ws-term-out').textContent, 'done');
  window.scalemaxAPI.workspace.run = async ({ command }) => { commands.push(command); return answers.shift() || ok(''); };
});

test('each folder has its own runs and history', async () => {
  await clearPanel();
  await runCommand('npm start', ok('listening'));
  app.workspace.root = '/work/other';
  terminal.showTerminalFolder('/work/other');
  assert.equal(output.childNodes.length, 0, 'the other folder ran nothing yet');
  input.value = '';
  await key('ArrowUp');
  assert.equal(input.value, '', 'and has no history');
  await runCommand('cargo build', ok('Finished'));
  assert.deepEqual(runBlocks().map((block) => block.querySelector('.ws-term-cmd').textContent), ['$ \ncargo build']);
  app.workspace.root = '/work/app';
  terminal.showTerminalFolder('/work/app');
  assert.deepEqual(runBlocks().map((block) => block.querySelector('.ws-term-cmd').textContent), ['$ \nnpm start']);
  await key('ArrowUp');
  assert.equal(input.value, 'npm start');
  input.value = '';
});

test('a folder keeps its last 100 runs and says when older output went', async () => {
  await clearPanel();
  for (let i = 0; i < 103; i += 1) await runCommand(`echo ${i}`, ok(String(i)));
  const blocks = runBlocks();
  assert.equal(blocks.length, 100);
  assert.equal(blocks[0].querySelector('.ws-term-out').textContent, '3', 'the oldest went first');
  const session = output.firstChild;
  assert.ok(session.firstChild.classList.contains('ws-term-note'));
  assert.match(session.firstChild.textContent, /Earlier output was removed/);
  // One huge run pushes out the rest but stays itself.
  await runCommand('cat big.log', ok('x'.repeat(1_200_000)));
  assert.equal(runBlocks().length, 1);
  assert.equal(runBlocks()[0].querySelector('.ws-term-out').textContent.length, 1_200_000);
});
