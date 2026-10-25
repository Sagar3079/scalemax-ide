import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { shortcutCommand, keyLabel, shortcutList, isCommand, COMMANDS, VIEW_ORDER } from '../src/shortcuts.mjs';

const require = createRequire(import.meta.url);
const { buildMenuTemplate, MENU_COMMANDS } = require('../lib/app-branding.cjs');

const press = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
const cmd = (key, extra = {}) => press(key, { metaKey: true, ...extra });

test('⌘N, ⌘,, ⌘K, ⌘L and ⌘⇧O run their commands from anywhere, text fields included', () => {
  for (const typing of [false, true]) {
    assert.equal(shortcutCommand(cmd('n'), { typing }), 'new-task');
    assert.equal(shortcutCommand(cmd(','), { typing }), 'preferences');
    assert.equal(shortcutCommand(cmd('k'), { typing }), 'search');
    assert.equal(shortcutCommand(cmd('l'), { typing }), 'focus-composer');
    assert.equal(shortcutCommand(cmd('O', { shiftKey: true }), { typing }), 'recent-sessions');
  }
  assert.equal(shortcutCommand(cmd('N')), 'new-task', 'Caps Lock does not matter');
});

test('⌘1–⌘6 show the views in sidebar order, by the digit key too', () => {
  VIEW_ORDER.forEach((view, index) => {
    assert.equal(shortcutCommand(cmd(String(index + 1), { code: `Digit${index + 1}` })), `view:${view}`);
  });
  assert.deepEqual(VIEW_ORDER, ['chat', 'workspace', 'assistant', 'experts', 'automation', 'more']);
  // AZERTY types digits with Shift: the key is "&", the code says Digit1.
  assert.equal(shortcutCommand(cmd('&', { code: 'Digit1', shiftKey: true })), 'view:chat');
  assert.equal(shortcutCommand(cmd('7', { code: 'Digit7' })), '', 'there is no seventh view');
});

test('⌘F searches the workspace except in the editor, where it stays CodeMirror\'s find', () => {
  assert.equal(shortcutCommand(cmd('f')), 'search');
  assert.equal(shortcutCommand(cmd('f'), { typing: true }), 'search');
  assert.equal(shortcutCommand(cmd('f'), { typing: true, inEditor: true }), '');
});

test('"/" focuses the message box only while nothing is being typed', () => {
  assert.equal(shortcutCommand(press('/')), 'focus-composer');
  assert.equal(shortcutCommand(press('/'), { typing: true }), '');
  assert.equal(shortcutCommand(press('/', { altKey: true })), '');
  assert.equal(shortcutCommand(press('/', { isComposing: true })), '');
  assert.equal(shortcutCommand(press('k')), '', 'plain letters are text');
});

test('a Mac leaves Ctrl keys to text editing; Windows and Linux use Ctrl', () => {
  assert.equal(shortcutCommand(press('k', { ctrlKey: true }), { mac: true }), '', 'Ctrl+K deletes to the end of the line on a Mac');
  assert.equal(shortcutCommand(press('n', { ctrlKey: true }), { mac: true }), '');
  assert.equal(shortcutCommand(cmd('k', { ctrlKey: true }), { mac: true }), '');
  assert.equal(shortcutCommand(press('k', { ctrlKey: true }), { mac: false }), 'search');
  assert.equal(shortcutCommand(cmd('k'), { mac: false }), '');
  assert.equal(shortcutCommand(cmd('n', { altKey: true })), '', 'Option changes the key');
  assert.equal(shortcutCommand(cmd('n', { shiftKey: true })), '');
  assert.equal(shortcutCommand(cmd('s')), '', '⌘S stays the Workspace\'s save');
  assert.equal(shortcutCommand(null), '');
});

test('keys are written for the platform', () => {
  assert.equal(keyLabel({ mod: true, key: 'K' }), '⌘K');
  assert.equal(keyLabel({ mod: true, shift: true, key: 'O' }), '⌘⇧O');
  assert.equal(keyLabel({ mod: true, shift: true, key: 'O' }, { mac: false }), 'Ctrl+Shift+O');
  const mac = shortcutList({ mac: true });
  const other = shortcutList({ mac: false });
  assert.deepEqual(mac.find((entry) => entry.label === 'New task').keys, ['⌘N']);
  assert.deepEqual(mac.find((entry) => entry.label === 'Focus the message box').keys, ['⌘L', '/']);
  assert.deepEqual(other.find((entry) => entry.label === 'Search workspace').keys, ['Ctrl+K', 'Ctrl+F']);
  assert.ok(mac.some((entry) => entry.keys.includes('⌘1–⌘6')));
});

// The native menu shows the same keys and sends the same commands the window runs.
function eventFor(accelerator) {
  const parts = accelerator.split('+');
  const key = parts.at(-1);
  return cmd(key.length === 1 ? key.toLowerCase() : key, { shiftKey: parts.includes('Shift'), code: /^\d$/.test(key) ? `Digit${key}` : '' });
}

test('the menu\'s shortcuts are the window\'s: same commands, same keys', () => {
  assert.deepEqual([...MENU_COMMANDS].sort(), [...COMMANDS].sort());
  const items = [];
  const walk = (list) => list.forEach((item) => { if (item.id?.startsWith('command:')) items.push(item); if (Array.isArray(item.submenu)) walk(item.submenu); });
  walk(buildMenuTemplate({ platform: 'darwin' }));
  assert.equal(new Set(items.map((item) => item.id)).size, COMMANDS.length, 'every command has one menu item');
  for (const item of items) {
    const command = item.id.slice('command:'.length);
    assert.ok(isCommand(command), command);
    assert.equal(shortcutCommand(eventFor(item.accelerator)), command, `${item.label} ${item.accelerator}`);
  }
  assert.equal(isCommand('reload'), false);
  assert.equal(isCommand('__proto__'), false);
});
