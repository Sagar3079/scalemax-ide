import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BUILTIN_COMMANDS, parseSlash, filterCommands, mergeCommands, costSummary, bindSlashUi } from '../src/slash-ui.js';
import { mentionTargets, folderSuggestions } from '../src/context-ui.js';
import { hookLabel } from '../src/hooks-ui.js';

const require = createRequire(import.meta.url);
const { BUILTIN_NAMES } = require('../lib/slash-commands.cjs');

test('the app\'s own commands are the ones main keeps custom commands away from', () => {
  assert.deepEqual(BUILTIN_COMMANDS.map((command) => command.name).sort(), [...BUILTIN_NAMES].sort());
  for (const command of BUILTIN_COMMANDS) {
    assert.equal(command.source, 'built-in');
    assert.ok(command.description, `/${command.name} says what it does`);
  }
});

test('what counts as a command: "/name arguments", namespaces, never a path', () => {
  assert.deepEqual(parseSlash('/fix 42 "two words"'), { name: 'fix', args: '42 "two words"' });
  assert.deepEqual(parseSlash('  /frontend:component Button  '), { name: 'frontend:component', args: 'Button' });
  assert.deepEqual(parseSlash('/clear'), { name: 'clear', args: '' });
  assert.deepEqual(parseSlash('/mode\ncoding'), { name: 'mode', args: 'coding' });
  assert.equal(parseSlash('/usr/bin/env is missing'), null);
  assert.equal(parseSlash('fix /this'), null);
  assert.equal(parseSlash('/'), null);
  assert.equal(parseSlash('/a:b:c:d'), null);
});

test('the menu: exact name first, then names that start with what was typed, then the rest that fits', () => {
  const commands = mergeCommands([
    { name: 'planner', description: 'Plan a sprint', source: 'project' },
    { name: 'git:commit', description: 'Write a commit message', source: 'user' },
    { name: 'clear', description: 'shadowed by the app', source: 'project' },
    { name: 'bad name', source: 'project' },
    { name: 'Mine', description: 'x'.repeat(500), argumentHint: '<what>', source: 'somewhere' },
  ]);
  assert.deepEqual(commands.slice(BUILTIN_COMMANDS.length).map((command) => [command.name, command.source]), [['planner', 'project'], ['git:commit', 'user'], ['Mine', 'user']]);
  assert.equal(commands.at(-1).description.length, 200);
  assert.deepEqual(filterCommands(commands, 'plan').map((command) => command.name), ['plan', 'planner']);
  assert.deepEqual(filterCommands(commands, 'mode').map((command) => command.name), ['mode', 'model']);
  // Names first ("compact", then "git:commit" by its last part), then descriptions ("List the commands").
  assert.deepEqual(filterCommands(commands, 'com').map((command) => command.name), ['compact', 'git:commit', 'help', 'review']);
  assert.deepEqual(filterCommands(commands, 'sprint').map((command) => command.name), ['planner']);
  assert.equal(filterCommands(commands, '').length, commands.length);
  assert.deepEqual(filterCommands(commands, 'zzz'), []);
});

test('/cost: the task\'s totals from its stored replies', () => {
  assert.equal(costSummary({ messages: [] }), 'No usage recorded for this task yet.');
  const metrics = (input, output, nano) => ({
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    costStatus: 'priced', costNanoUsd: nano, model: 'm',
  });
  const task = { messages: [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b', metrics: metrics(1200, 300, 2_000_000) },
    { role: 'user', text: 'c' },
    { role: 'assistant', text: 'd', metrics: metrics(3000, 500, 1_000_000) },
  ] };
  assert.match(costSummary(task), /^This task so far: .*\$0\.003.* \(4,200 in · 800 out\) over 2 replies\.$/);
});

test('@-mentions: files, folders, web pages and background commands, in order and once each', () => {
  assert.deepEqual(mentionTargets('see @src/app.js, @src/ and @./ then @https://example.com/a?b=1). Also @job:j12. Twice: @src/app.js me@example.com @job:x'), [
    { kind: 'file', value: 'src/app.js' },
    { kind: 'folder', value: 'src/' },
    { kind: 'folder', value: './' },
    { kind: 'url', value: 'https://example.com/a?b=1' },
    { kind: 'job', value: 'j12' },
    { kind: 'file', value: 'job' },
  ]);
  assert.equal(mentionTargets(Array.from({ length: 20 }, (_item, index) => `@f${index}.js`).join(' ')).length, 8);
  assert.deepEqual(mentionTargets('no mentions here'), []);
  const files = ['src/app.js', 'src/lib/parse.js', 'test/app.test.js', 'README.md', 'docs/lib/guide.md'];
  assert.deepEqual(folderSuggestions(files, ''), ['src/', 'test/', 'docs/']);
  assert.deepEqual(folderSuggestions(files, 'lib'), ['src/lib/', 'docs/lib/']);
  assert.deepEqual(folderSuggestions(files, 'src/'), ['src/', 'src/lib/']);
  assert.deepEqual(folderSuggestions(['a/b/c/d.js'], 'a/b'), ['a/b/', 'a/b/c/']);
  assert.equal(hookLabel({ event: 'PreToolUse', matcher: 'workspace_(write|edit)' }), 'PreToolUse · workspace_(write|edit)');
  assert.equal(hookLabel({ event: 'Stop', matcher: '' }), 'Stop');
});

// A small stand-in for the DOM the menu uses (elements, attributes, children, listeners).
function fakeNode(tag = 'div') {
  const listeners = {};
  const attributes = new Map();
  const node = {
    tag, className: '', textContent: '', hidden: false, id: '', dataset: {}, children: [], value: '', selectionStart: 0, selectionEnd: 0, listeners,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    append(...items) { node.children.push(...items); },
    replaceChildren(...items) { node.children = items; },
    querySelector(selector) { return selector === '.is-active' ? node.children.find((child) => child.className.includes('is-active')) || null : null; },
    scrollIntoView() {},
    focus() {},
    setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
    closest(selector) { return selector === '[data-command]' && node.dataset.command ? node : null; },
  };
  return node;
}

test('the menu: "/" opens it, arrows move, Escape closes, Enter runs or completes, Tab completes', async () => {
  const input = fakeNode('textarea');
  const parent = fakeNode();
  input.parentElement = parent;
  const menu = fakeNode();
  menu.hidden = true;
  const nodes = { '#chat-input': input, '#slash-menu': menu };
  globalThis.document = { querySelector: (selector) => nodes[selector] || null, createElement: (tag) => fakeNode(tag) };
  globalThis.window = globalThis.window || globalThis;
  window.setTimeout = setTimeout;
  window.scalemaxAPI = { slash: { list: async (request) => ({ ok: true, data: { commands: [{ name: 'refactor', description: 'Tidy up', argumentHint: '<file>', source: 'project' }] } }) } };
  const sentTexts = [];
  const app = {
    currentTask: () => ({ folder: { name: 'p', path: '/p' } }), workspace: { root: '/p' },
    updateSendEnabled() {}, handleSend: async () => { sentTexts.push(input.value); return true; },
  };
  bindSlashUi(app);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const type = async (value) => {
    input.value = value;
    input.selectionStart = input.selectionEnd = value.length;
    for (const listener of input.listeners.input) listener();
    await settle();
  };
  const key = (name) => {
    const event = { key: name, target: input, shiftKey: false, isComposing: false, defaultPrevented: false, stopped: false,
      preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; } };
    for (const listener of parent.listeners.keydown) listener(event);
    return event;
  };
  const shown = () => menu.children.map((option) => option.dataset.command);

  await type('/re');
  assert.equal(menu.hidden, false);
  // Names first, then commands whose description fits ("fresh", "read").
  assert.deepEqual(shown(), ['refactor', 'review', 'clear', 'init', 'plan']);
  assert.equal(input.getAttribute('aria-controls'), 'slash-menu');
  assert.equal(input.getAttribute('aria-activedescendant'), 'slash-option-0');
  const option = menu.children[0];
  assert.equal(option.getAttribute('role'), 'option');
  assert.deepEqual(option.children.map((child) => child.className), ['slash-head', 'slash-desc', 'slash-source is-project']);
  assert.equal(option.children[2].textContent, 'This project');
  key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), 'slash-option-1');
  key('ArrowUp');
  key('ArrowUp');
  assert.equal(input.getAttribute('aria-activedescendant'), 'slash-option-4', 'it wraps around');
  key('ArrowDown');
  // Tab completes a command that takes an argument, and the menu closes.
  assert.equal(key('Tab').defaultPrevented, true);
  assert.equal(input.value, '/refactor ');
  assert.equal(menu.hidden, true);
  assert.equal(input.getAttribute('aria-controls'), 'mention-menu');
  // Past the first word the menu stays shut: Enter is the message box's again.
  await type('/refactor src/app.js');
  assert.equal(menu.hidden, true);
  assert.equal(key('Enter').defaultPrevented, false);
  // Escape closes it.
  await type('/cl');
  assert.equal(menu.hidden, false);
  key('Escape');
  assert.equal(menu.hidden, true);
  // Enter on a command that needs nothing more runs it.
  await type('/cle');
  key('Enter');
  await settle();
  assert.deepEqual(sentTexts, ['/clear']);
  // Enter on one that takes an argument completes it instead.
  await type('/mod');
  assert.deepEqual(shown(), ['mode', 'model']);
  key('Enter');
  assert.equal(input.value, '/mode ');
  assert.equal(sentTexts.length, 1);
  // Nothing fits: Enter sends the text as typed (the menu does not take the key).
  await type('/zzz');
  assert.equal(menu.hidden, false);
  assert.match(menu.children[0].textContent, /No command by that name/);
  assert.equal(key('Enter').defaultPrevented, false);
});
