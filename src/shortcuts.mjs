/**
 * The app's keyboard shortcuts, in one place: which key does what (shortcutCommand), and the list
 * Preferences > Keyboard shortcuts shows. Pure (no DOM): src/app.js listens for the keys and runs
 * the commands; the native menu (lib/app-branding.cjs) shows the same keys and sends the same
 * command names (test/shortcuts.test.mjs keeps the two in step).
 *
 * A shortcut never takes a key from what the user is typing in: plain "/" works only outside text
 * fields, and ⌘F stays CodeMirror's find inside the editor. ⌘ is Ctrl on Windows and Linux; on a
 * Mac, Ctrl keys are left alone (Ctrl+K, Ctrl+N and Ctrl+L edit text there).
 */

/** The views in sidebar order: ⌘1 … ⌘6. */
export const VIEW_ORDER = Object.freeze(['chat', 'workspace', 'assistant', 'experts', 'automation', 'more']);

/** The commands the keys and the native menu run (src/app.js runCommand). */
export const COMMANDS = Object.freeze([
  'new-task', 'preferences', 'search', 'recent-sessions', 'focus-composer', ...VIEW_ORDER.map((view) => `view:${view}`),
]);

/** True for a command name the window runs (anything else from the menu is ignored). */
export function isCommand(name) {
  return typeof name === 'string' && COMMANDS.includes(name);
}

/**
 * The command a key press asks for, or '' for none.
 * @param {{ key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean, isComposing?: boolean }} event
 * @param {{ mac?: boolean, typing?: boolean, inEditor?: boolean }} where
 *   typing: the focus is in a text field (input, textarea, select, contenteditable);
 *   inEditor: it is in the code editor (CodeMirror, or its fallback textarea).
 */
export function shortcutCommand(event, { mac = true, typing = false, inEditor = false } = {}) {
  if (!event || typeof event.key !== 'string' || event.isComposing) return '';
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!mod) {
    // "/" focuses the message box, like a search field on the web: only while nothing is being typed.
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    return plain && key === '/' && !typing ? 'focus-composer' : '';
  }
  if (event.altKey) return '';
  // ⌘1–⌘6 by the digit key (code), with or without Shift: layouts such as AZERTY type the
  // digits with Shift.
  const digit = /^Digit([1-9])$/.exec(event.code || '')?.[1] || (/^[1-9]$/.test(key) ? key : '');
  if (digit) return VIEW_ORDER[Number(digit) - 1] ? `view:${VIEW_ORDER[Number(digit) - 1]}` : '';
  if (event.shiftKey) return key === 'o' ? 'recent-sessions' : '';
  switch (key) {
    case 'n': return 'new-task';
    case ',': return 'preferences';
    case 'k': return 'search';
    case 'f': return inEditor ? '' : 'search';
    case 'l': return 'focus-composer';
    default: return '';
  }
}

/**
 * Mac key names in a text as they are written elsewhere: "⌘⇧O" → "Ctrl+Shift+O", "⌘↩" →
 * "Ctrl+Enter", "↩" → "Enter". The page's hints and tooltips are written for the Mac; the app
 * rewrites them once on other systems (src/app.js applyPlatform).
 */
export function otherKeys(text) {
  return String(text)
    .replace(/([⌘⇧]+)(↩|[^\s⌘⇧↩·)]+)?/g, (_all, mods, key = '') => [
      mods.includes('⌘') ? 'Ctrl' : '', mods.includes('⇧') ? 'Shift' : '', key === '↩' ? 'Enter' : key,
    ].filter(Boolean).join('+'))
    .replace(/↩/g, 'Enter');
}

/** How a key combination is written: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function keyLabel(keys, { mac = true } = {}) {
  const { mod = false, shift = false, key } = keys;
  if (mac) return `${mod ? '⌘' : ''}${shift ? '⇧' : ''}${key}`;
  return [mod ? 'Ctrl' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/**
 * Preferences > Keyboard shortcuts: [{ label, keys: [label, …] }], each entry's keys as written on
 * this platform. Keys that belong to one view say where.
 */
export function shortcutList({ mac = true } = {}) {
  const k = (key, extra = {}) => keyLabel({ mod: true, key, ...extra }, { mac });
  return [
    { label: 'New task', keys: [k('N')] },
    { label: 'Search workspace', keys: [k('K'), k('F')], note: `${k('F')} finds in the file while you are in the editor` },
    { label: 'Focus the message box', keys: [k('L'), '/'], note: '/ works while you are not typing in a field' },
    { label: 'Recent sessions', keys: [k('O', { shift: true })] },
    { label: 'Preferences', keys: [k(',')] },
    { label: 'Chat, Workspace, Assistant, Experts, Automation, Preferences', keys: [`${k('1')}–${k('6')}`] },
    { label: 'Send the message', keys: [mac ? '↩' : 'Enter'], note: `${mac ? '⇧↩' : 'Shift+Enter'} starts a new line` },
    { label: 'Save the file (Workspace)', keys: [k('S')] },
  ];
}
