import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONNECTOR_CATALOG } from '../src/connector-catalog.js';
import { MCP_SIGN_IN } from '../src/mcp-directory.js';
import { promptDraft, seedComposer } from '../src/mcp-ui.js';

// What the Experts & resources page, the connector cards and the MCP prompts say (the polish
// round's findings: catalog jargon, "Setup guide" cards, prompt roles flattened into the draft).

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('connector cards say what connecting gives, and only chat-connected ones promise tools in chat', () => {
  assert.equal(CONNECTOR_CATALOG.length, 40);
  const inChat = new Set([...Object.keys(MCP_SIGN_IN), 'github']);
  for (const entry of CONNECTOR_CATALOG) {
    assert.doesNotMatch(entry.description, /setup guide/i, entry.id);
    assert.ok(entry.description.length <= 110, `${entry.id} is short`);
    // Only the connectors served by an MCP server (one-click, and GitHub through its CLI) get tools in chat.
    assert.equal(/tools in chat/.test(entry.description), inChat.has(entry.id), entry.id);
  }
});

test('the Experts page uses one name for skills and a plain two-sentence intro', () => {
  const intro = /<p class="notice">([^<]*)<\/p>\s*<section class="catalog-section" aria-labelledby="experts-title">/.exec(html)?.[1];
  assert.ok(intro, 'the intro is above the experts');
  assert.equal(intro.split(/(?<=\.)\s+/).length, 2, intro);
  assert.doesNotMatch(intro, /validation endpoint|app registration|OAuth/);
  assert.match(html, /<h2 id="skills-title">30 skills<\/h2>/);
  assert.doesNotMatch(html, /Prompt library|prompt templates|30 templates/);
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\{skills\.length\} skills/);
  const catalog = fs.readFileSync(new URL('../src/catalog-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(catalog, /Prompt template/);
});

test('no hidden kicker spans above dialog titles; the detail dialog is labelled and described', () => {
  assert.doesNotMatch(html, /class="eyebrow/);
  assert.doesNotMatch(html, /id="(detail-kind|custom-dialog-kind)"/);
  assert.match(html, /<dialog id="detail-dialog" aria-labelledby="detail-title" aria-describedby="detail-description">/);
  assert.doesNotMatch(css, /\.eyebrow\b/);
});

test('state tags print at 11px and a view switch uses the motion tokens', () => {
  const tag = /\n\.sm-state-tag \{[^}]*\}/.exec(css)[0];
  assert.match(tag, /font-size: 11px;/);
  const view = /\n\.view\.active \{[^}]*\}/.exec(css)[0];
  assert.match(view, /animation: sm-view-in var\(--sm-dur-2\) var\(--sm-ease-out\);/);
  assert.doesNotMatch(css, /10\.5px|160ms/);
});

test('a filled-in prompt puts only the user\'s lines in the draft; the rest is quoted as context', () => {
  const result = {
    text: 'Review src/stamp.js for timezone handling.',
    messages: [
      { role: 'user', text: 'Review src/stamp.js for timezone handling.' },
      { role: 'assistant', text: 'Sure, send it.\n\nI will look at it.' },
      { role: 'system', text: 'Be brief.' },
    ],
  };
  assert.deepEqual(promptDraft(result, { title: 'Review a file', server: 'Echo' }), {
    text: 'Review src/stamp.js for timezone handling.\n\n'
      + '> Context from the Echo prompt "Review a file" (quoted, not your words):\n'
      + '> Assistant: Sure, send it.\n>\n> I will look at it.\n'
      + '> System: Be brief.',
    quoted: 2,
  });
  assert.deepEqual(promptDraft({ text: 'Just mine.', messages: [{ role: 'user', text: 'Just mine.' }] }), { text: 'Just mine.', quoted: 0 });
  assert.deepEqual(promptDraft({ text: '', messages: [] }), { text: '', quoted: 0 });
});

// A minimal message box and app for seedComposer.
function composer(t, { value = '', task }) {
  const input = { value, focused: 0, focus() { this.focused += 1; }, setSelectionRange() {} };
  globalThis.document = { getElementById: (id) => (id === 'chat-input' ? input : null) };
  t.after(() => { delete globalThis.document; });
  const app = {
    tasks: [task], currentTaskId: task.id, toasts: [], views: [], started: 0,
    currentTask() { return this.tasks.find((item) => item.id === this.currentTaskId); },
    switchView(view) { this.views.push(view); },
    showToast(message) { this.toasts.push(message); },
    updateSendEnabled() {},
    newTask() {
      this.started += 1;
      const fresh = { id: `task-new-${this.started}`, messages: [] };
      this.tasks.unshift(fresh);
      this.currentTaskId = fresh.id;
      return fresh;
    },
  };
  return { input, app };
}

test('a prompt goes into a chat task, never into an automation\'s run log', (t) => {
  const { input, app } = composer(t, { task: { id: 'task-auto', automationId: 'a1', messages: [{ role: 'user', text: 'Run' }] } });
  assert.deepEqual(seedComposer(app, 'Review a.js.'), { moved: true });
  assert.equal(app.currentTaskId, 'task-new-1', 'a new task holds the draft');
  assert.equal(input.value, 'Review a.js.');
  assert.deepEqual(app.views, ['chat']);
});

test('a prompt goes into the chat task that is open, and never over a draft', (t) => {
  const { input, app } = composer(t, { task: { id: 'task-chat', messages: [] } });
  assert.deepEqual(seedComposer(app, 'Review a.js.'), { moved: false });
  assert.equal(app.currentTaskId, 'task-chat');
  assert.equal(input.value, 'Review a.js.');
  assert.equal(seedComposer(app, 'Something else'), null);
  assert.equal(input.value, 'Review a.js.');
  assert.deepEqual(app.toasts, ['Send or clear what you have typed first']);
});
