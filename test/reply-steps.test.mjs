import test from 'node:test';
import assert from 'node:assert/strict';

// How steps read on screen (src/reply-ui.js): a tiny element stand-in that keeps children, text
// and classes, enough to read back what a step row says.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.ownText = '';
    this.style = { setProperty() {} };
  }
  append(...kids) {
    for (const kid of kids) this.children.push(typeof kid === 'string' ? Object.assign(new FakeNode('#text'), { ownText: kid }) : kid);
  }
  appendChild(kid) { this.append(kid); return kid; }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  get textContent() { return this.ownText + this.children.map((kid) => kid.textContent).join(''); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes[name] ?? null; }
  addEventListener() {}
  querySelector(selector) { return all(this, selector.replace(/^\./, ''))[0] || null; }
  querySelectorAll(selector) { return all(this, selector.replace(/^\./, '')); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(' '); },
      remove: (name) => { this.className = names().filter((item) => item !== name).join(' '); },
      contains: (name) => names().includes(name),
      toggle: () => {},
    };
  }
}
function all(node, className) {
  const found = [];
  for (const kid of node.children) {
    if (kid.className.split(/\s+/).includes(className)) found.push(kid);
    found.push(...all(kid, className));
  }
  return found;
}
globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode('#text'), { ownText: text }),
};
window.cancelAnimationFrame = () => {};
window.requestAnimationFrame = () => 1;

const { createReply, applyProgress, renderLiveReply, renderMessageSteps } = await import('../src/reply-ui.js');

const rows = (root) => all(root, 'reply-step').map((node) => [node.dataset.state, all(node, 'reply-step-title')[0].textContent]);

test('a live step reads as what it will do, what it is doing, then what it did', () => {
  const reply = createReply({ taskId: 't', requestId: 'r' });
  const at = (event) => applyProgress(reply, { requestId: 'r', ...event }, 1000);
  at({ phase: 'approval', callId: 'step-1', title: 'Edited src/format-date.js', serverId: 'Workspace', toolName: 'edit_file' });
  at({ phase: 'tool', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' });
  at({ phase: 'tool', callId: 'step-3', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' });
  at({ phase: 'tool-done', callId: 'step-3', ok: true });
  at({ phase: 'approval', callId: 'step-4', title: 'Wrote NOTES.md', serverId: 'Workspace', toolName: 'write_file' });
  at({ phase: 'tool-done', callId: 'step-4', ok: false, outcome: 'denied' });
  assert.deepEqual(rows(renderLiveReply(reply)), [
    ['approval', 'Edit src/format-date.js — waiting for your approval'],
    ['running', 'Running npm test'],
    ['ok', 'Read a.js'],
    ['declined', 'Write NOTES.md — Denied by you'],
  ]);
});

test('a finished reply shows calls nobody let run neutrally and leaves them out of "failed"', () => {
  const details = renderMessageSteps([
    { type: 'tool', title: 'PreToolUse hook: ./guard.sh (blocked, 0.1s)', ok: false, server: 'Hooks', tool: 'PreToolUse', preview: 'No new files while Tomás reviews.', outcome: 'blocked' },
    { type: 'tool', title: 'Wrote NOTES.md', ok: false, server: 'Workspace', tool: 'write_file', outcome: 'hook', hook: './guard.sh',
      preview: 'Error: a PreToolUse hook the user set up blocked this call: No new files while Tomás reviews.' },
    { type: 'tool', title: 'Edited src/a.js', ok: false, server: 'Workspace', tool: 'edit_file', preview: 'Error: the user denied this tool call. Do not retry it.' },
    { type: 'tool', title: 'Wrote SUMMARY.md', ok: false, server: 'Workspace', tool: 'write_file', outcome: 'plan' },
    { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', preview: 'Error: exit 1' },
    { type: 'tool', title: 'Ran npm run build', ok: false, server: 'Workspace', tool: 'run_command', stopped: true },
  ]);
  assert.deepEqual(rows(details), [
    ['declined', 'PreToolUse hook: ./guard.sh (blocked, 0.1s)'],
    ['declined', 'Write NOTES.md — Blocked by hook ./guard.sh'],
    ['declined', 'Edit src/a.js — Denied by you'],
    ['declined', 'Write SUMMARY.md — Not run (Plan)'],
    ['error', 'Ran npm test'],
    ['stopped', 'Run npm run build'],
  ]);
  const summary = all(details, 'msg-steps-summary')[0].textContent;
  assert.match(summary, / · 1 failed$/, 'only the command that broke counts as failed');
  // Only the real failure shows its error in red; the hook says what it said, quietly.
  assert.deepEqual(all(details, 'reply-step-error').map((node) => node.textContent), ['Error: exit 1']);
  assert.deepEqual(all(details, 'reply-step-why-detail').map((node) => node.textContent), ['No new files while Tomás reviews.']);
});
