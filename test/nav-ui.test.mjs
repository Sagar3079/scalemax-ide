import test from 'node:test';
import assert from 'node:assert/strict';

// The sidebar, search, shortcuts, toasts and focus fixes of src/app.js, on a small stand-in DOM:
// elements with classes, attributes, children and simple selectors (tag, #id, .class, [attr],
// descendants, lists), enough for the code under test. Layout is given by hand (rect).

function parseCompound(text) {
  const tag = /^[a-z][a-z0-9-]*/i.exec(text)?.[0]?.toLowerCase() || '';
  const id = /#([\w-]+)/.exec(text)?.[1] || '';
  const classes = [...text.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const attrs = [...text.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((match) => [match[1], match[2]]);
  return { tag, id, classes, attrs };
}
function matchesCompound(node, part) {
  if (!node || typeof node !== 'object' || !node.tagName) return false;
  if (part.tag && node.tagName.toLowerCase() !== part.tag) return false;
  if (part.id && node.id !== part.id) return false;
  if (part.classes.some((name) => !node.classes.has(name))) return false;
  return part.attrs.every(([name, value]) => {
    const actual = name.startsWith('data-') ? node.dataset[name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] : node.getAttribute(name);
    return actual !== undefined && actual !== null && (value === undefined || String(actual) === value);
  });
}
function matches(node, selector) {
  return selector.split(',').some((one) => {
    const parts = one.trim().replace(/:[\w-]+(\([^)]*\))?/g, '').split(/\s+/).map(parseCompound);
    if (!matchesCompound(node, parts.at(-1))) return false;
    let index = parts.length - 2;
    for (let up = node.parentElement; up && index >= 0; up = up.parentElement) if (matchesCompound(up, parts[index])) index -= 1;
    return index < 0;
  });
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.listeners = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; }, removeProperty: (name) => { delete this.style[name]; } };
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.id = '';
    this.type = '';
    this.rect = null;
    this.parentElement = null;
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this.classes;
    return {
      add: (...names) => names.forEach((name) => set.add(name)),
      remove: (...names) => names.forEach((name) => set.delete(name)),
      contains: (name) => set.has(name),
      toggle: (name, force) => { const on = force === undefined ? !set.has(name) : Boolean(force); if (on) set.add(name); else set.delete(name); return on; },
    };
  }
  get textContent() { return this.childNodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join(''); }
  set textContent(value) { this.childNodes = value === '' ? [] : [String(value)]; }
  get children() { return this.childNodes.filter((node) => typeof node === 'object'); }
  get isConnected() { for (let node = this; node; node = node.parentElement) if (node === document.body) return true; return false; }
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        node.parentElement?.childNodes.splice(node.parentElement.childNodes.indexOf(node), 1);
        node.parentElement = this;
      }
      this.childNodes.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.childNodes = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : (name === 'id' && this.id ? this.id : null); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  removeEventListener() {}
  focus() { document.activeElement = this; }
  select() {}
  scrollIntoView() {}
  contains(node) { for (let up = node; up; up = up.parentElement) if (up === this) return true; return false; }
  closest(selector) { for (let up = this; up; up = up.parentElement) if (matches(up, selector)) return up; return null; }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => { for (const child of node.children) { if (matches(child, selector)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    const { left = 0, top = 0, width = 0, height = 0 } = this.rect || {};
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  getClientRects() { for (let up = this; up; up = up.parentElement) if (up.hidden) return []; return [this.getBoundingClientRect()]; }
  get offsetHeight() { return this.rect?.height ?? 32; }
  get isContentEditable() { return this.attributes.get('contenteditable') === 'true'; }
}

const body = new FakeElement('body');
const docListeners = {};
globalThis.window = globalThis;
globalThis.CSS = { escape: (text) => String(text) };
globalThis.document = {
  body,
  activeElement: body,
  addEventListener(type, listener) { (docListeners[type] ||= []).push(listener); },
  removeEventListener() {},
  querySelector: (selector) => body.querySelector(selector),
  querySelectorAll: (selector) => body.querySelectorAll(selector),
  getElementById: (id) => body.querySelector(`#${id}`),
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag),
  createTextNode: (text) => String(text),
};
window.scalemaxAPI = { getPlatform: () => 'darwin' };

// The parts of index.html these tests use.
function make(tag, id, { parent = body, classes = '', attrs = {} } = {}) {
  const node = new FakeElement(tag);
  if (id) node.id = id;
  if (classes) node.className = classes;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  parent.append(node);
  return node;
}
const nav = make('nav', 'sidebar-nav');
for (const view of ['chat', 'workspace', 'assistant', 'experts', 'automation', 'more']) {
  const item = make('button', '', { parent: nav, classes: 'sidebar-item' });
  item.dataset.view = view;
  item.textContent = view;
}
make('button', 'new-task-btn');
make('button', 'search-btn');
make('span', 'task-count');
make('div', 'tasks-list');
const main = make('main', 'main-content');
main.rect = { left: 260, top: 40, width: 640, height: 620 };
const chatView = make('section', 'view-chat', { parent: main, classes: 'view active', attrs: { 'aria-labelledby': 'welcome-title' } });
const toolbar = make('div', '', { parent: chatView, classes: 'view-toolbar' });
toolbar.rect = { left: 260, top: 40, width: 640, height: 56 };
const worktreeBar = make('div', 'worktree-bar', { parent: chatView });
worktreeBar.hidden = true;
const picker = make('div', 'folder-picker', { parent: chatView });
const pickerOpen = make('button', 'folder-picker-open', { parent: picker });
const chatInput = make('textarea', 'chat-input', { parent: chatView });
const moreView = make('section', 'view-more', { parent: main, classes: 'view', attrs: { 'aria-labelledby': 'more-title' } });
const moreTitle = make('h1', 'more-title', { parent: moreView });
make('dl', 'shortcuts-list', { parent: moreView });
const editorView = make('div', 'editor-view', { parent: main });
const editorContent = make('div', '', { parent: editorView, classes: 'cm-content', attrs: { contenteditable: 'true' } });
const providerTest = make('button', 'provider-test', { parent: main });
make('span', 'provider-status', { parent: main });
const searchDialog = make('dialog', 'search-dialog');
const searchInput = make('input', 'search-input', { parent: searchDialog });
searchInput.type = 'search';
make('div', 'search-results', { parent: searchDialog });
make('p', 'search-count', { parent: searchDialog });
const sessionsDialog = make('dialog', 'sessions-dialog');
const sessionsSearch = make('input', 'sessions-search', { parent: sessionsDialog });
const toast = make('div', 'toast');

const { default: app } = await import('../src/app.js');
const { sessionPreview } = await import('../src/sessions-ui.js');
const { nextRunningJob } = await import('../src/jobs-ui.js');

const ROOT = '/Users/you/api';
const WORKTREE = '/Users/you/Library/Application Support/scalemax-ide/worktrees/api-task-1792746527836-6goj6v';
function setup(tasks = []) {
  Object.assign(app, {
    tasks, currentTaskId: tasks[0]?.id || null, replies: new Map(), unreadTasks: new Set(), taskMoods: new Map(),
    collapsedFolders: new Set(), customExperts: [], customSkills: [], searchActive: 0,
    workspace: { root: ROOT, files: [], recent: [], tree: {}, expanded: new Set() },
    settings: { ...app.settings },
  });
  for (const dialog of [searchDialog, sessionsDialog]) dialog.removeAttribute('open');
  chatView.classes.add('active');
  moreView.classes.delete('active');
  document.activeElement = body;
}
const task = (id, title, extra = {}) => ({ id, title, messages: [{ role: 'user', text: title }], createdAt: 1, updatedAt: 1, folder: { name: 'api', path: ROOT }, ...extra });
function keydown(key, extra = {}) {
  const event = { key, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, defaultPrevented: false, ...extra };
  event.preventDefault = () => { event.defaultPrevented = true; };
  for (const listener of docListeners.keydown || []) listener(event);
  return event;
}

app.bindShortcuts();

test('the shortcut keys run their commands, and stop the key so the menu does not run it twice', () => {
  setup([task('t1', 'Fix login')]);
  const calls = [];
  const saved = { newTask: app.newTask, toggleSearch: app.toggleSearch };
  app.newTask = () => calls.push('new-task');
  app.toggleSearch = (open) => calls.push(`search:${open}`);
  try {
    assert.equal(keydown('n', { metaKey: true }).defaultPrevented, true);
    assert.equal(keydown('k', { metaKey: true }).defaultPrevented, true);
    document.activeElement = chatInput;
    assert.equal(keydown('f', { metaKey: true }).defaultPrevented, true, '⌘F in the message box searches');
    document.activeElement = editorContent;
    assert.equal(keydown('f', { metaKey: true }).defaultPrevented, false, '⌘F in the editor is CodeMirror\'s find');
    assert.equal(keydown('n', { metaKey: true, defaultPrevented: true }).defaultPrevented, true, 'a key someone used is left alone');
    assert.deepEqual(calls, ['new-task', 'search:true', 'search:true']);
  } finally {
    Object.assign(app, saved);
  }
});

test('⌘L and "/" bring up the chat with the focus in the message box; "/" in a field is typed', () => {
  setup([task('t1', 'Fix login')]);
  chatView.classes.delete('active');
  moreView.classes.add('active');
  document.activeElement = moreTitle;
  assert.equal(keydown('/').defaultPrevented, true);
  assert.equal(document.activeElement, chatInput);
  assert.ok(chatView.classes.has('active'));
  assert.ok(!moreView.classes.has('active'));
  assert.equal(nav.querySelector('.sidebar-item[data-view="chat"]').getAttribute('aria-current'), 'page');
  // In the message box "/" starts a slash command.
  assert.equal(keydown('/').defaultPrevented, false);
  document.activeElement = editorContent;
  assert.equal(keydown('/').defaultPrevented, false, 'the editor types it');
  assert.equal(keydown('l', { metaKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement, chatInput);
});

test('⌘6 and ⌘, open Preferences with the focus on its title, not on a control the switch hid', () => {
  setup([task('t1', 'Fix login')]);
  document.activeElement = chatInput;
  keydown('6', { metaKey: true, code: 'Digit6' });
  assert.ok(moreView.classes.has('active'));
  assert.equal(document.activeElement, moreTitle);
  assert.equal(moreTitle.getAttribute('tabindex'), '-1');
  assert.ok(moreTitle.classes.has('focus-target'));
  setup([task('t1', 'Fix login')]);
  keydown(',', { metaKey: true });
  assert.equal(document.activeElement, moreTitle);
});

test('while a dialog is up the shortcuts wait; the one that opened it goes back to its field', () => {
  setup([task('t1', 'Fix login')]);
  const calls = [];
  const saved = app.newTask;
  app.newTask = () => calls.push('new-task');
  try {
    searchDialog.setAttribute('open', '');
    document.activeElement = body;
    assert.equal(keydown('n', { metaKey: true }).defaultPrevented, true, 'stopped, so the menu does not run it either');
    assert.deepEqual(calls, []);
    keydown('k', { metaKey: true });
    assert.equal(document.activeElement, searchInput);
    document.activeElement = body;
    assert.equal(keydown('/').defaultPrevented, false, 'a plain "/" is the dialog\'s');
    searchDialog.removeAttribute('open');
    sessionsDialog.setAttribute('open', '');
    keydown('o', { metaKey: true, shiftKey: true });
    assert.equal(document.activeElement, sessionsSearch);
  } finally {
    app.newTask = saved;
  }
});

test('a native menu item reaches the window as a scalemax:command event; anything else is ignored', () => {
  setup([task('t1', 'Fix login')]);
  for (const listener of docListeners['scalemax:command']) listener({ detail: 'view:more' });
  assert.ok(moreView.classes.has('active'));
  setup([task('t1', 'Fix login')]);
  for (const listener of docListeners['scalemax:command']) listener({ detail: 'reload' });
  for (const listener of docListeners['scalemax:command']) listener({ detail: { toString: () => 'view:more' } });
  assert.ok(chatView.classes.has('active'));
});

test('the sidebar and Preferences show the keys; the nav items carry them for assistive tech', () => {
  const rows = body.querySelector('#shortcuts-list').children;
  assert.ok(rows.length >= 6);
  assert.match(rows[0].textContent, /New task.*⌘N/);
  assert.equal(body.querySelector('#new-task-btn').title, 'New task (⌘N)');
  assert.equal(body.querySelector('#new-task-btn').getAttribute('aria-keyshortcuts'), 'Meta+N');
  assert.equal(nav.children[2].getAttribute('aria-keyshortcuts'), 'Meta+3');
  assert.equal(chatInput.getAttribute('aria-keyshortcuts'), 'Meta+L');
});

test('"Projects" counts projects (folders), not tasks', () => {
  setup([
    task('t1', 'One'), task('t2', 'Two'), task('t3', 'Three'),
    task('t4', 'Web', { folder: { name: 'web', path: '/Users/you/web' } }),
  ]);
  app.renderTasks();
  const count = body.querySelector('#task-count');
  assert.equal(count.textContent, '2');
  assert.equal(count.getAttribute('aria-label'), '2 projects');
});

test('a fork is marked before its title, where the row cannot cut the mark off', () => {
  setup([task('t1', 'Update the README with a one-line descri… (fork)'), task('t2', 'Update the README with a one-line description')]);
  app.renderTasks();
  const rows = body.querySelectorAll('#tasks-list .task-item');
  const title = rows[0].querySelector('.task-title');
  assert.equal(title.children[0].className, 'task-fork-tag');
  assert.equal(title.children[0].textContent, 'fork');
  assert.equal(title.textContent, 'fork Update the README with a one-line descri…');
  assert.equal(rows[0].title, 'Update the README with a one-line descri… (fork)', 'the tooltip keeps the whole title');
  assert.equal(rows[1].querySelector('.task-fork-tag'), null);
});

test('a finished, unseen task keeps its title in the row (its mark leads, the state prints under it)', () => {
  setup([task('t2', 'Other'), task('t1', 'Add a GET /health endpoint')]);
  app.unreadTasks.add('t1');
  app.settings.companion = false;
  app.renderTasks();
  const row = body.querySelectorAll('#tasks-list .task-item').find((node) => node.dataset.taskId === 't1');
  assert.ok(row.classes.has('has-state'));
  assert.deepEqual(row.children.map((node) => node.className.split(' ')[0]), ['task-status', 'task-title', 'task-state-line']);
  assert.equal(row.querySelector('.task-title').textContent, 'Add a GET /health endpoint');
});

test('a task worktree is named after its project and branch, not its folder on disk', () => {
  const worktree = { path: WORKTREE, branch: 'scalemax/add-a-get-health-endpoint', base: 'main', mainRoot: ROOT, mainName: 'api', createdAt: 1 };
  const owner = task('t1', 'Add a GET /health endpoint', { folder: { name: 'api (add-a-get-health-endpoint)', path: WORKTREE }, worktree });
  // Made in the worktree before this fix: the generated folder name was kept.
  const later = task('t2', 'Follow-up', { folder: { name: 'api-task-1792746527836-6goj6v', path: WORKTREE } });
  setup([later, owner]);
  app.workspace.root = WORKTREE;
  assert.deepEqual(app.rootFolder(), { name: 'api (add-a-get-health-endpoint)', path: WORKTREE });
  assert.equal(app.taskFolderShown(later).name, 'api (add-a-get-health-endpoint)');
  assert.equal(app.folderErrorText({ error: { code: 'ENOENT' } }, WORKTREE), 'The folder "api (add-a-get-health-endpoint)" is no longer available.');
  app.renderTasks();
  assert.deepEqual(body.querySelectorAll('#tasks-list .task-group-name').map((node) => node.textContent), ['api (add-a-get-health-endpoint)']);
  // Without its own task, the record still names it.
  setup([later, { ...owner, folder: { name: 'api', path: ROOT } }]);
  assert.equal(app.worktreeLabel(WORKTREE), 'api (add-a-get-health-endpoint)');
  assert.equal(app.folderLabel(ROOT), 'api');
  assert.equal(app.worktreeLabel(ROOT), '');
});

test('Test connection keeps the focus: busy, not disabled, and a second press waits for the first', async () => {
  setup([task('t1', 'One')]);
  let finish;
  let calls = 0;
  window.scalemaxAPI.provider = { discover: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); } };
  const toasts = [];
  const saved = { showToast: app.showToast, markFormEdited: app.markFormEdited, renderModelSelect: app.renderModelSelect };
  Object.assign(app, { showToast: (message) => toasts.push(message), markFormEdited() {}, renderModelSelect() {} });
  try {
    providerTest.focus();
    const testing = app.testProvider();
    assert.equal(providerTest.disabled, false);
    assert.equal(providerTest.getAttribute('aria-busy'), 'true');
    assert.equal(document.activeElement, providerTest);
    await app.testProvider();
    assert.equal(calls, 1, 'the second press did not start another test');
    finish({ ok: false, error: { message: 'Connection refused' } });
    await testing;
    assert.equal(providerTest.getAttribute('aria-busy'), null);
    assert.equal(document.activeElement, providerTest);
    assert.deepEqual(toasts, ['Connection refused']);
  } finally {
    Object.assign(app, saved);
    delete window.scalemaxAPI.provider;
  }
});

test('Search workspace: ↑ ↓ move through the results while the field keeps the focus, Enter opens', () => {
  setup([task('t1', 'Fix the parser'), task('t2', 'Parser (fork)', { messages: [{ role: 'user', text: 'parser' }, { role: 'assistant', text: '## Done\n- Fixed `parse()`' }] })]);
  app.tasks[0].messages.push({ role: 'assistant', text: 'ok' });
  searchInput.value = 'parse';
  app.searchActive = 0;
  app.renderSearch();
  const options = () => body.querySelectorAll('#search-results [role="option"]');
  assert.ok(options().length >= 2);
  assert.equal(searchInput.getAttribute('aria-activedescendant'), 'search-option-0');
  assert.equal(searchInput.getAttribute('aria-expanded'), 'true');
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  const opened = [];
  const saved = { selectTask: app.selectTask, toggleSearch: app.toggleSearch };
  Object.assign(app, { selectTask: (id) => opened.push(id), toggleSearch: () => opened.push('closed') });
  try {
    document.activeElement = searchInput;
    const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; } };
    app.searchKeys(down);
    assert.ok(down.prevented);
    assert.equal(searchInput.getAttribute('aria-activedescendant'), 'search-option-1');
    assert.ok(options()[1].classes.has('is-active'));
    assert.equal(document.activeElement, searchInput);
    app.searchKeys({ key: 'ArrowUp', preventDefault() {} });
    app.searchKeys({ key: 'ArrowUp', preventDefault() {} });
    assert.equal(searchInput.getAttribute('aria-activedescendant'), `search-option-${options().length - 1}`, 'it wraps');
    app.searchActive = 1;
    app.renderSearch();
    // The fork's mark and a Markdown description as plain text.
    assert.equal(options()[1].querySelector('.task-fork-tag')?.textContent, 'fork');
    app.searchKeys({ key: 'Enter', isComposing: false, preventDefault() {} });
    assert.deepEqual(opened, ['t2', 'closed']);
  } finally {
    Object.assign(app, saved);
  }
  searchInput.value = 'no such thing at all';
  app.renderSearch();
  assert.equal(searchInput.getAttribute('aria-activedescendant'), null);
  assert.equal(searchInput.getAttribute('aria-expanded'), 'false');
  assert.equal(body.querySelector('#search-count').textContent, 'No results');
});

test('after a folder opens, the message box takes the focus the hidden folder picker had', () => {
  setup([task('t1', 'One')]);
  pickerOpen.focus();
  picker.hidden = true;
  app.refocusAfterFolder();
  assert.equal(document.activeElement, chatInput);
  // A control that is still there keeps the focus, and nothing moves under a dialog.
  picker.hidden = false;
  providerTest.focus();
  app.refocusAfterFolder();
  assert.equal(document.activeElement, providerTest);
  document.activeElement = body;
  searchDialog.setAttribute('open', '');
  app.refocusAfterFolder();
  assert.equal(document.activeElement, body);
});

test('a toast prints under the main area\'s toolbar, centred on it; over a dialog, above the dialog', () => {
  setup([task('t1', 'One')]);
  app.placeToast(toast, null);
  assert.equal(toast.style['--toast-x'], '580px');
  assert.equal(toast.style['--toast-top'], '108px', 'toolbar bottom (96) + 12');
  worktreeBar.hidden = false;
  worktreeBar.rect = { left: 260, top: 96, width: 640, height: 32 };
  app.placeToast(toast, null);
  assert.equal(toast.style['--toast-top'], '140px', 'under the worktree bar too');
  worktreeBar.hidden = true;
  const dialog = make('dialog', 'jobs-dialog');
  dialog.rect = { left: 100, top: 120, width: 700, height: 400 };
  toast.rect = { height: 34 };
  app.placeToast(toast, dialog);
  assert.equal(toast.style['--toast-x'], '450px');
  assert.equal(toast.style['--toast-top'], '78px', 'its bottom 8px above the dialog');
  dialog.rect = { left: 100, top: 20, width: 700, height: 600 };
  app.placeToast(toast, dialog);
  assert.equal(toast.style['--toast-top'], '8px', 'no room above: at the top of the window');
});

test('Recent sessions previews show a reply\'s Markdown as plain text, around the match', () => {
  const reply = '## Done\n- Added `src/health.js` exporting `health()` (status + uptime).\n- Registered `GET /health` in `src/server.js`.\n\nTests pass. You can commit this from the worktree header.';
  const item = { id: 't1', title: 'Health', messages: [{ role: 'user', text: 'Add a health endpoint' }, { role: 'assistant', text: reply }] };
  assert.equal(sessionPreview(item, ''), 'Done: Added src/health.js exporting health() (status + uptime). Registered GET /health in src/server.js. Tests pass. You can commit this fro…');
  assert.equal(sessionPreview(item, 'server.js'), '… uptime). Registered GET /health in src/server.js. Tests pass. You can commit this from the worktree header.');
  assert.equal(sessionPreview(item, 'health endpoint'), 'Add a health endpoint');
  assert.equal(sessionPreview({ messages: [] }, ''), '');
});

test('after Stop, the focus goes to the next command still running (else to Close)', () => {
  const jobs = [
    { id: 'j1', status: 'running' }, { id: 'j2', status: 'stopped' }, { id: 'j3', status: 'running' }, { id: 'j4', status: 'running' },
  ];
  assert.equal(nextRunningJob(jobs, 'j3').id, 'j4');
  assert.equal(nextRunningJob(jobs, 'j4').id, 'j1', 'it wraps to the top');
  assert.equal(nextRunningJob([{ id: 'j1', status: 'running' }, { id: 'j2', status: 'failed' }], 'j1'), null);
  assert.equal(nextRunningJob(null, 'j1'), null);
});
