import test from 'node:test';
import assert from 'node:assert/strict';

// A small stand-in for the page: #confirm-dialog with the parts src/confirm-dialog.js fills.
class FakeNode {
  constructor(id, { tag = 'div', doc } = {}) {
    this.id = id;
    this.tag = tag;
    this.doc = doc;
    this.textContent = '';
    this.hidden = false;
    this.children = [];
    this.listeners = {};
    this.isConnected = true;
    this.classes = new Set();
    this.classList = {
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
      contains: (name) => this.classes.has(name),
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
  focus() { this.doc.activeElement = this; }
  replaceChildren(...nodes) { this.children = nodes; }
}
globalThis.HTMLElement ??= FakeNode;
const doc = { activeElement: null };
const parts = Object.fromEntries(['confirm-title', 'confirm-context', 'confirm-message', 'confirm-details', 'confirm-note', 'confirm-cancel', 'confirm-accept']
  .map((id) => [id, new FakeNode(id, { doc })]));
const dialog = new FakeNode('confirm-dialog', { doc });
dialog.open = false;
dialog.querySelector = (selector) => parts[selector.slice(1)] || null;
dialog.showModal = () => { dialog.open = true; };
// Closing a <dialog> fires "close" afterwards, as the browser does.
dialog.close = () => {
  if (!dialog.open) return;
  dialog.open = false;
  queueMicrotask(() => dialog.dispatch('close'));
};
globalThis.document = {
  getElementById: (id) => (id === 'confirm-dialog' ? dialog : null),
  createElement: (tag) => new FakeNode('', { tag, doc }),
  get activeElement() { return doc.activeElement; },
};
const { askConfirm } = await import('../src/confirm-dialog.js');

test('the confirmation names what it is about, focuses Cancel and answers true only for the action', async () => {
  const opener = new FakeNode('delete-task-btn', { doc });
  opener.focus();
  const asked = askConfirm({
    title: 'Delete “Fix the parser”?', context: 'api · branch feat/health', message: 'Its conversation is removed.',
    details: ['src/a.js'], confirmLabel: 'Delete task', danger: true,
  });
  assert.equal(dialog.open, true);
  assert.equal(parts['confirm-title'].textContent, 'Delete “Fix the parser”?');
  assert.equal(parts['confirm-context'].textContent, 'api · branch feat/health');
  assert.equal(parts['confirm-message'].textContent, 'Its conversation is removed.');
  assert.equal(parts['confirm-details'].hidden, false);
  assert.equal(parts['confirm-details'].children[0].textContent, 'src/a.js');
  assert.equal(parts['confirm-note'].hidden, true, 'no note: nothing shown');
  assert.equal(parts['confirm-accept'].textContent, 'Delete task');
  assert.equal(parts['confirm-accept'].classList.contains('danger'), true, 'a destructive action is red');
  assert.equal(doc.activeElement, parts['confirm-cancel'], 'Cancel has the focus: Return never confirms by accident');
  parts['confirm-accept'].dispatch('click');
  assert.equal(await asked, true);
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, opener, 'focus goes back where it was');
});

test('Cancel, Escape (the dialog closing by itself) and a newer question all answer false', async () => {
  const cancelled = askConfirm({ title: 'Merge?', confirmLabel: 'Merge' });
  assert.equal(parts['confirm-accept'].classList.contains('danger'), false);
  assert.equal(parts['confirm-accept'].classList.contains('primary'), true, 'not destructive: a primary button');
  assert.equal(parts['confirm-context'].hidden, true);
  parts['confirm-cancel'].dispatch('click');
  assert.equal(await cancelled, false);

  const escaped = askConfirm({ title: 'Remove?' });
  // Escape: the browser closes the dialog itself.
  dialog.close();
  assert.equal(await escaped, false);

  const first = askConfirm({ title: 'First?' });
  const second = askConfirm({ title: 'Second?' });
  assert.equal(await first, false);
  assert.equal(parts['confirm-title'].textContent, 'Second?');
  parts['confirm-accept'].dispatch('click');
  assert.equal(await second, true);
});
