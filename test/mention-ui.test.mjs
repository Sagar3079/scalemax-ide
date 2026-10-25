import test from 'node:test';
import assert from 'node:assert/strict';
import { jobSuggestions, bindComposerContext } from '../src/context-ui.js';

const ROOT = '/Users/you/project';
const JOBS = [
  { id: 'j1', command: 'npm run dev', root: ROOT, status: 'running', startedAt: 1 },
  { id: 'j2', command: 'npm test -- --watch', root: ROOT, status: 'exited', startedAt: 2 },
  { id: 'j3', command: 'python3 -m http.server', root: '/Users/you/other', status: 'running', startedAt: 3 },
];

test('@ offers this folder\'s running background commands; "@job" and the command line find them; "@job:" lists them all', () => {
  const paths = (query, jobs = JOBS) => jobSuggestions(jobs, query, ROOT).map((job) => job.path);
  // "@" alone: the running ones of this folder (not another folder's, not finished ones).
  assert.deepEqual(jobSuggestions(JOBS, '', ROOT), [{ path: 'job:j1', detail: 'npm run dev', running: true }]);
  for (const query of ['j', 'jo', 'job', 'JOB', 'j1', 'dev', 'npm run']) assert.deepEqual(paths(query), ['job:j1'], query);
  // A single letter of a command line is not enough, and other words do not match.
  assert.deepEqual(paths('d'), []);
  assert.deepEqual(paths('src/app'), []);
  // After "job:": every command of this folder, finished ones too, by id or command line.
  assert.deepEqual(paths('job:'), ['job:j1', 'job:j2']);
  assert.deepEqual(paths('job:j'), ['job:j1', 'job:j2']);
  assert.deepEqual(paths('job:watch'), ['job:j2']);
  assert.deepEqual(paths('job:j2'), ['job:j2']);
  // At most five running ones next to the files.
  const many = Array.from({ length: 8 }, (_item, index) => ({ id: `j${index + 1}`, command: `node w${index}.js`, root: ROOT, status: 'running' }));
  assert.equal(paths('', many).length, 5);
  assert.deepEqual(jobSuggestions(null, '', ROOT), []);
  assert.deepEqual(jobSuggestions([null, { id: 4, root: ROOT, status: 'running' }], '', ROOT), []);
});

// A small stand-in for the DOM the menu uses (elements, attributes, children, listeners, style).
function fakeNode(tag = 'div') {
  const listeners = {};
  const attributes = new Map();
  const node = {
    tag, className: '', hidden: false, id: '', dataset: {}, children: [], value: '', selectionStart: 0, selectionEnd: 0, listeners, title: '',
    get textContent() { return node.text !== undefined ? node.text : node.children.map((child) => child.textContent).join(''); },
    set textContent(value) { node.text = value; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    append(...items) { node.children.push(...items); },
    replaceChildren(...items) { node.children = items; },
    querySelector(selector) { return selector === '.is-active' ? node.children.find((child) => child.className.includes('is-active')) || null : null; },
    scrollIntoView() {},
    focus() {},
    setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
    closest(selector) { return selector === '[data-path]' && node.dataset.path ? node : null; },
  };
  return node;
}

test('typing "@job" shows the running command as "job:j1 · npm run dev" in a popover inside the window, and Enter names it', async () => {
  const input = fakeNode('textarea');
  const card = fakeNode();
  input.parentElement = card;
  let rect = { top: 300, bottom: 372, left: 100, right: 700, width: 600, height: 72 };
  input.getBoundingClientRect = () => rect;
  card.getBoundingClientRect = () => ({ top: 290, bottom: 420, left: 90, right: 710, width: 620, height: 130 });
  const menu = fakeNode();
  menu.hidden = true;
  const calls = [];
  let open = false;
  const style = new Map();
  Object.assign(menu, {
    scrollHeight: 200,
    style: { setProperty: (name, value) => style.set(name, value), removeProperty: (name) => style.delete(name) },
    showPopover() { calls.push('show'); open = true; },
    hidePopover() { calls.push('hide'); open = false; },
    matches: (selector) => selector === ':popover-open' && open,
  });
  const nodes = { '#chat-input': input, '#mention-menu': menu, '#chat-card': card };
  globalThis.window = globalThis.window || globalThis;
  globalThis.document = { querySelector: (selector) => nodes[selector] || null, createElement: (tag) => fakeNode(tag) };
  window.innerHeight = 700;
  window.innerWidth = 900;
  const resize = [];
  window.addEventListener = (type, listener) => { if (type === 'resize') resize.push(listener); };
  const found = [];
  window.scalemaxAPI = {
    jobs: { list: async () => ({ ok: true, data: JOBS }) },
    workspace: { find: async (query) => { found.push(query); return { ok: true, data: { files: query === '' ? ['src/app.js'] : [] } }; } },
  };
  bindComposerContext({ workspace: { root: ROOT }, updateSendEnabled() {}, showToast() {} });
  assert.equal(menu.getAttribute('popover'), 'manual', 'it never takes the focus from the message box');
  const type = async (value) => {
    input.value = value;
    input.selectionStart = input.selectionEnd = value.length;
    for (const listener of input.listeners.input) listener();
    await new Promise((resolve) => setTimeout(resolve, 120));
  };
  const key = (name) => {
    const event = { key: name, target: input, shiftKey: false, isComposing: false, defaultPrevented: false, stopped: false,
      preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; } };
    for (const listener of card.listeners.keydown) listener(event);
    return event;
  };
  const px = (name) => Number.parseFloat(style.get(name));
  const texts = () => menu.children.map((child) => child.textContent);

  // "@": the running command first, then the folders and files.
  await type('Is it alive? @');
  assert.deepEqual(texts(), ['job:j1 · npm run dev', 'src/', 'app.jssrc']);
  assert.deepEqual(calls, ['show']);
  assert.equal(menu.hidden, false);
  // "@job": the command, and no "No file with that name".
  await type('Is the ticker alive? Check @job');
  assert.deepEqual(texts(), ['job:j1 · npm run dev']);
  assert.ok(!texts().some((text) => /No file/.test(text)));
  assert.match(menu.children[0].className, /is-job/);
  assert.equal(input.getAttribute('aria-activedescendant'), 'mention-option-0');
  // Placed below the box, inset in the composer card, inside the 900 × 700 window.
  assert.equal(menu.dataset.side, 'below');
  assert.equal(px('top'), 376);
  assert.equal(px('left'), 102);
  assert.equal(px('width'), 596);
  assert.ok(px('left') + px('width') <= 900 - 8);
  // Near the bottom of the window it opens above the box instead.
  rect = { top: 560, bottom: 632, left: 100, right: 700, width: 600, height: 72 };
  for (const listener of resize) listener();
  assert.equal(menu.dataset.side, 'above');
  assert.equal(px('bottom'), 700 - 560 + 4);
  assert.ok(px('max-height') <= 240 && px('max-height') <= 560 - 4 - 8);
  // Enter names it in the message.
  assert.equal(key('Enter').defaultPrevented, true);
  assert.equal(input.value, 'Is the ticker alive? Check @job:j1 ');
  assert.deepEqual(calls, ['show', 'hide']);
  assert.equal(menu.hidden, true);
  // Nothing fits: one message for both kinds; Escape closes and keeps the key from the box.
  await type('@zzz');
  assert.deepEqual(texts(), ['No file or background command by that name in this folder']);
  const escape = key('Escape');
  assert.equal(escape.stopped, true);
  assert.equal(menu.hidden, true);
  // No jobs bridge: files still work.
  window.scalemaxAPI.jobs = undefined;
  await type('@');
  assert.deepEqual(texts(), ['src/', 'app.jssrc']);
});
