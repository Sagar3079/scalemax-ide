/**
 * Slash commands in the message box. Typing "/" at the start of a message opens a menu of the
 * commands (arrow keys, Enter or Tab to pick, Escape to close), each with what it does and where it
 * comes from: ScaleMax's own (BUILTIN_COMMANDS) and the custom ones main reads from the task
 * folder's and the user's .scalemax/commands (lib/slash-commands.cjs; the window only gets their
 * names and descriptions). On send, runSlashCommand() runs the app's own commands here (/clear,
 * /plan, /model, /mode, /cost, /help: never sent to the model), or asks main for the prompt a
 * custom command becomes. /compact and /init keep their own paths in src/app.js, and /review goes
 * to main as typed (main reviews the folder's changes read-only).
 * DOM is built with createElement and textContent only (no HTML).
 */
import { taskMetrics, taskMetricsLabel, MODE_IDS, modeInfo } from './domain.mjs';
import { setPermission, setMode } from './composer-ui.js';

const $ = (selector) => document.querySelector(selector);

/**
 * ScaleMax's own commands. `run`: Enter in the menu runs it at once (otherwise it is completed
 * for its argument). lib/slash-commands.cjs BUILTIN_NAMES lists the same names (a test checks),
 * so a custom command can never take one of them.
 */
export const BUILTIN_COMMANDS = Object.freeze([
  { name: 'clear', description: 'Start a fresh task in the same folder', argumentHint: '', run: true },
  { name: 'compact', description: 'Summarize older turns to make room in the context', argumentHint: '', run: true },
  { name: 'cost', description: 'Show the tokens and cost of this task so far', argumentHint: '', run: true },
  { name: 'help', description: 'List the commands', argumentHint: '', run: true },
  { name: 'init', description: 'Read the project and write its notes (.scalemax/SCALEMAX.md)', argumentHint: '', run: true },
  { name: 'mode', description: 'Switch between Working and Coding', argumentHint: 'working | coding', run: false },
  { name: 'model', description: 'Choose the model', argumentHint: '', run: true },
  { name: 'plan', description: 'Switch to Plan: read-only until you run the plan', argumentHint: '', run: true },
  { name: 'review', description: 'Review the uncommitted changes in this folder, read-only', argumentHint: '[what to focus on]', run: true },
].map((command) => Object.freeze({ ...command, source: 'built-in' })));
const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));
// Commands handled elsewhere: their text goes through the normal send path as typed.
const PASSED_ON = new Set(['compact', 'init', 'review']);
const SOURCE_LABELS = { 'built-in': 'ScaleMax', project: 'This project', user: 'Yours' };
// "/name" or "/name arguments"; namespaces with ":" (/frontend:component). "/usr/bin" is no command.
const COMMAND_TEXT = /^\/([A-Za-z0-9][\w.-]{0,63}(?::[A-Za-z0-9][\w.-]{0,63}){0,2})(?:\s+([\s\S]*))?$/;
const VALID_NAME = /^[A-Za-z0-9][\w.-]{0,63}(?::[A-Za-z0-9][\w.-]{0,63}){0,2}$/;
// The custom commands of a folder are asked for again after this long.
const LIST_TTL_MS = 5000;
const SHOWN = 60;

const state = { app: null, open: false, query: '', results: [], active: 0, token: 0, cache: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

/** { name, args } for a message that is a command ("/fix 123"), else null. */
export function parseSlash(text) {
  const match = COMMAND_TEXT.exec(String(text ?? '').trim());
  return match ? { name: match[1], args: (match[2] || '').trim() } : null;
}

/**
 * The commands that fit what was typed after "/": the one of exactly that name first, then names
 * that start with it, names whose last part (after ":") starts with it, names that contain it,
 * and descriptions that do. Nothing typed: all of them, in the order given.
 */
export function filterCommands(commands, query) {
  const list = Array.isArray(commands) ? commands : [];
  const wanted = String(query ?? '').toLowerCase();
  if (!wanted) return list.slice();
  const ranked = [];
  for (const command of list) {
    const name = command.name.toLowerCase();
    const last = name.slice(name.lastIndexOf(':') + 1);
    const rank = name === wanted ? 0 : name.startsWith(wanted) ? 1 : last.startsWith(wanted) ? 2 : name.includes(wanted) ? 3
      : String(command.description || '').toLowerCase().includes(wanted) ? 4 : -1;
    if (rank >= 0) ranked.push([rank, command]);
  }
  return ranked.sort((left, right) => left[0] - right[0] || left[1].name.localeCompare(right[1].name)).map(([, command]) => command);
}

/** The app's own commands followed by the custom ones main listed (malformed ones left out). */
export function mergeCommands(custom) {
  const seen = new Set(BUILTIN_NAMES);
  const extra = [];
  for (const command of Array.isArray(custom) ? custom : []) {
    if (!command || typeof command.name !== 'string' || !VALID_NAME.test(command.name)) continue;
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({
      name: command.name,
      description: typeof command.description === 'string' ? command.description.slice(0, 200) : '',
      argumentHint: typeof command.argumentHint === 'string' ? command.argumentHint.slice(0, 80) : '',
      source: command.source === 'project' ? 'project' : 'user',
    });
  }
  return [...BUILTIN_COMMANDS, ...extra];
}

const count = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0');
/** "/cost": what this task used so far, from its stored replies (src/domain.mjs taskMetrics). */
export function costSummary(task) {
  const totals = taskMetrics(task);
  const label = taskMetricsLabel(task);
  if (!totals.replies || !label) return 'No usage recorded for this task yet.';
  const sides = totals.knownInput || totals.knownOutput ? ` (${count(totals.inputTokens)} in · ${count(totals.outputTokens)} out)` : '';
  const replies = `${totals.replies} ${totals.replies === 1 ? 'reply' : 'replies'}`;
  return `This task so far: ${label}${sides} over ${replies}.`;
}

// The folder of the task on screen, or the open folder its first message takes.
function folderOf(app) {
  return app?.currentTask?.()?.folder?.path || app?.workspace?.root || '';
}

/** The commands for the menu: the app's own and the folder's and user's custom ones (cached briefly). */
async function commandList(app) {
  const folder = folderOf(app);
  const now = Date.now();
  if (state.cache && state.cache.folder === folder && now - state.cache.at < LIST_TTL_MS) return state.cache.commands;
  let custom = [];
  try {
    const result = await window.scalemaxAPI?.slash?.list?.({ folder: folder || undefined });
    if (result?.ok && Array.isArray(result.data?.commands)) custom = result.data.commands;
  } catch { /* the app's own commands still work */ }
  const commands = mergeCommands(custom);
  state.cache = { folder, at: now, commands };
  return commands;
}

// Opens a composer popover (src/composer-ui.js) unless it is open already.
function openPopover(menuSelector, buttonSelector) {
  const menu = $(menuSelector);
  if (typeof menu?.matches === 'function' && menu.matches(':popover-open')) return;
  $(buttonSelector)?.click?.();
}

/**
 * Runs a slash command typed as a message (src/app.js handleSend). Resolves to
 *   { handled: true }               an app command ran here (or failed and said why): send nothing;
 *   { prompt, command }             a custom command: send `prompt` instead, naming `command` so
 *                                   main applies its front matter;
 *   null                            not a command of ours: send the text as typed.
 */
export async function runSlashCommand(app, text) {
  // The message is on its way: the menu for it is done.
  if (state.open) closeMenu();
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const key = parsed.name.toLowerCase();
  if (PASSED_ON.has(key)) return null;
  const input = $('#chat-input');
  // An app command is not a message: the box empties as if it was sent.
  const handled = () => {
    if (input && input.value.trim() === text) input.value = '';
    closeMenu();
    app.updateSendEnabled?.();
    return { handled: true };
  };
  switch (key) {
    case 'clear': {
      const folder = app.currentTask?.()?.folder || app.rootFolder?.() || null;
      handled();
      const task = app.newTask?.(folder ? { folder } : {});
      if (task) app.showToast?.(folder ? `New task in ${folder.name}` : 'New task');
      return { handled: true };
    }
    case 'plan':
      handled();
      await setPermission(app, 'plan');
      return { handled: true };
    case 'model':
      handled();
      openPopover('#model-menu', '#model-button');
      return { handled: true };
    case 'mode': {
      const wanted = parsed.args.toLowerCase();
      handled();
      if (MODE_IDS.includes(wanted)) await setMode(app, wanted);
      else {
        openPopover('#mode-menu', '#mode-chip');
        app.showToast?.(`Type ${MODE_IDS.map((id) => `/mode ${id}`).join(' or ')} (${MODE_IDS.map((id) => modeInfo(id).label).join(' or ')})`);
      }
      return { handled: true };
    }
    case 'cost':
      handled();
      app.showToast?.(costSummary(app.currentTask?.()));
      return { handled: true };
    case 'help':
      // The menu lists every command with what it does.
      if (input) {
        input.value = '/';
        input.setSelectionRange?.(1, 1);
        input.focus?.();
      }
      app.updateSendEnabled?.();
      openMenu('');
      return { handled: true };
    default:
      break;
  }
  const bridge = window.scalemaxAPI?.slash;
  if (!bridge?.expand) return null;
  const folder = folderOf(app);
  let result;
  try {
    result = await bridge.expand({ folder: folder || undefined, name: parsed.name, arguments: parsed.args });
  } catch {
    result = null;
  }
  // No such command: the text goes as typed ("/tmp is full" is a message).
  if (result?.ok === false && result.error?.code === 'NO_COMMAND') return null;
  if (!result?.ok || typeof result.data?.prompt !== 'string' || !result.data.prompt.trim()) {
    app.showToast?.(result?.error?.message || `/${parsed.name} could not be run`);
    return { handled: true };
  }
  closeMenu();
  return { prompt: result.data.prompt, command: typeof result.data.name === 'string' ? result.data.name : parsed.name };
}

// ---- The menu ---------------------------------------------------------------------------

function closeMenu() {
  state.open = false;
  state.results = [];
  state.token += 1;
  const menu = $('#slash-menu');
  if (menu) menu.hidden = true;
  const input = $('#chat-input');
  if (input?.getAttribute?.('aria-controls') === 'slash-menu') {
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-controls', 'mention-menu');
  }
}

function renderMenu() {
  const menu = $('#slash-menu');
  const input = $('#chat-input');
  if (!menu || !input) return;
  if (!state.open) {
    closeMenu();
    return;
  }
  menu.hidden = false;
  input.setAttribute('aria-controls', 'slash-menu');
  if (!state.results.length) {
    menu.replaceChildren(element('div', 'mention-empty', 'No command by that name. Press Enter to send it as a message.'));
    input.removeAttribute('aria-activedescendant');
    return;
  }
  menu.replaceChildren(...state.results.slice(0, SHOWN).map((command, index) => {
    const option = element('div', `mention-option slash-option${index === state.active ? ' is-active' : ''}`);
    option.id = `slash-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === state.active));
    option.dataset.command = command.name;
    const head = element('span', 'slash-head');
    head.append(element('span', 'slash-name', `/${command.name}`));
    if (command.argumentHint) head.append(element('span', 'slash-hint', command.argumentHint));
    option.append(head, element('span', 'slash-desc', command.description || ''),
      element('span', `slash-source is-${command.source}`, SOURCE_LABELS[command.source] || ''));
    return option;
  }));
  input.setAttribute('aria-activedescendant', `slash-option-${state.active}`);
  menu.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
}

function openMenu(query) {
  const token = (state.token += 1);
  state.open = true;
  state.query = query;
  void commandList(state.app).then((commands) => {
    if (token !== state.token || !state.open) return;
    state.results = filterCommands(commands, query).slice(0, SHOWN);
    state.active = 0;
    renderMenu();
  });
}

// The menu is open while the caret is in the first word of a message that starts with "/".
function updateMenu() {
  const input = $('#chat-input');
  if (!input || input.selectionStart !== input.selectionEnd) {
    if (state.open) closeMenu();
    return;
  }
  const before = input.value.slice(0, input.selectionStart);
  const match = /^\/(\S*)$/.exec(before);
  if (!match) {
    if (state.open) closeMenu();
    return;
  }
  if (state.open && state.query === match[1]) return;
  openMenu(match[1]);
}

/** Puts the picked command in the box; `run` sends it at once when it takes no argument. */
function pick(name, { run = false } = {}) {
  const input = $('#chat-input');
  const command = state.results.find((item) => item.name === name);
  if (!input || !command) return;
  // What was typed after the command's word stays (its arguments).
  const space = input.value.search(/\s/);
  const rest = space < 0 ? '' : input.value.slice(space).trim();
  closeMenu();
  const runs = command.source === 'built-in' ? command.run : !command.argumentHint;
  if (run && runs && !rest) {
    input.value = `/${command.name}`;
    state.app?.updateSendEnabled?.();
    void state.app?.handleSend?.();
    return;
  }
  input.value = `/${command.name} ${rest}`;
  const caret = rest ? input.value.length : command.name.length + 2;
  input.setSelectionRange?.(caret, caret);
  input.focus?.();
  state.app?.updateSendEnabled?.();
}

// Before the message box's own keys (capture on its parent), so Enter picks a command instead of
// sending while the menu is open.
function onKeydown(event) {
  if (event.target !== $('#chat-input') || !state.open) return;
  const total = Math.min(state.results.length, SHOWN);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && total) {
    event.preventDefault();
    event.stopPropagation();
    state.active = (state.active + (event.key === 'ArrowDown' ? 1 : total - 1)) % total;
    renderMenu();
  } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.isComposing && total) {
    event.preventDefault();
    event.stopPropagation();
    pick(state.results[state.active].name, { run: event.key === 'Enter' });
  }
}

export function bindSlashUi(app) {
  state.app = app;
  const input = $('#chat-input');
  if (!input) return;
  input.addEventListener('input', updateMenu);
  input.addEventListener('click', updateMenu);
  input.addEventListener('blur', () => window.setTimeout(() => { if (state.open) closeMenu(); }, 150));
  input.parentElement?.addEventListener('keydown', onKeydown, true);
  const menu = $('#slash-menu');
  // A click on the menu must not take the focus (and close it) before it picks the command.
  menu?.addEventListener('mousedown', (event) => event.preventDefault());
  menu?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-command]');
    if (option) pick(option.dataset.command, { run: true });
  });
}
