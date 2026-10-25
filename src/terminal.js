/**
 * The Workspace's Terminal panel: one command at a time in the open folder, shown the way a
 * terminal shows it. Each run is echoed as a prompt line ("$ npm test"), its output is appended
 * below the earlier runs, and it ends with a line saying how it ended and how long it took
 * ("Exit code 1 · 0.8 s"). The panel follows the end of the output while the user is reading
 * there, ↑ / ↓ recall earlier commands, and Clear (or Ctrl+L) empties the panel.
 *
 * Output and command history belong to a folder and last for the app session: switching folders
 * shows that folder's runs (showTerminalFolder, called whenever the open folder changes). Output
 * is always written with textContent, never as HTML, so results are never read as markup.
 */

const $ = (selector) => document.querySelector(selector);

// Per folder: the runs kept on screen and the commands kept for ↑ / ↓.
const MAX_RUNS = 100;
const MAX_CHARS = 1_000_000;
const MAX_HISTORY = 200;
// Within this many pixels of the end counts as "at the end": the panel keeps following it.
const FOLLOW_SLACK = 24;
const TRIMMED_NOTE = 'Earlier output was removed to keep the terminal fast.';

/** A run's duration as the result line shows it: "320 ms", "1.2 s", "2 min 5 s". */
export function formatDuration(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * Command history with a shell's ↑ / ↓: previous(draft) steps back (the first step keeps what
 * was being typed), next() steps forward and past the newest gives the draft back. Null means
 * there is nowhere to go.
 */
export function createHistory(limit = MAX_HISTORY) {
  const entries = [];
  let index = -1;
  let draft = '';
  return {
    entries,
    push(command) {
      if (command && entries[entries.length - 1] !== command) entries.push(command);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      index = -1;
      draft = '';
    },
    previous(current = '') {
      if (!entries.length) return null;
      if (index === -1) {
        draft = current;
        index = entries.length - 1;
      } else if (index > 0) {
        index -= 1;
      } else {
        return null;
      }
      return entries[index];
    },
    next() {
      if (index === -1) return null;
      if (index < entries.length - 1) {
        index += 1;
        return entries[index];
      }
      index = -1;
      return draft;
    },
    reset() {
      index = -1;
      draft = '';
    },
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// The panel once bound: its elements, the folder sessions and the one on screen.
const term = { output: null, input: null, sessions: new Map(), shown: null };

function sessionFor(root) {
  const key = root || '';
  if (!term.sessions.has(key)) {
    term.sessions.set(key, { root: key, node: element('span', 'ws-term-session'), history: createHistory(), chars: 0 });
  }
  return term.sessions.get(key);
}
// The shown session goes into the output only while it has something, so the placeholder
// (#terminal-output:empty) shows for a folder that ran nothing yet.
function attach(session) {
  if (!term.output || term.shown !== session) return;
  if (session.node.childNodes.length) {
    if (session.node.parentNode !== term.output) term.output.replaceChildren(session.node);
  } else {
    term.output.replaceChildren();
  }
}

/** Shows the Terminal of the folder `root` (its runs and its ↑ / ↓ history). */
export function showTerminalFolder(root) {
  if (!term.output) return;
  const session = sessionFor(root);
  if (term.shown === session) return;
  term.shown = session;
  attach(session);
}

function atEnd(output) {
  return output.scrollHeight - output.scrollTop - output.clientHeight <= FOLLOW_SLACK;
}
function toEnd(output) {
  output.scrollTop = output.scrollHeight;
}

function runs(session) {
  return [...session.node.children].filter((node) => node.classList.contains('ws-term-run'));
}
// Older runs go once a folder holds too many or too much text; the newest always stays.
function trim(session) {
  let list = runs(session);
  let trimmed = false;
  while (list.length > 1 && (list.length > MAX_RUNS || session.chars > MAX_CHARS)) {
    const oldest = list.shift();
    session.chars -= Number(oldest.dataset.chars) || 0;
    oldest.remove();
    trimmed = true;
  }
  if (trimmed && !session.node.querySelector('.ws-term-note')) {
    session.node.insertBefore(element('span', 'ws-term-note', TRIMMED_NOTE), session.node.firstChild);
  }
}

// Clear (button or Ctrl+L): the shown folder's finished runs go; a run still going stays, so its
// result appears when it ends. History stays.
function clearShown() {
  const session = term.shown;
  if (!session) return;
  for (const node of [...session.node.children]) {
    if (node.classList.contains('ws-term-run') && node.classList.contains('is-running')) continue;
    session.chars -= Number(node.dataset?.chars) || 0;
    node.remove();
  }
  if (session.chars < 0) session.chars = 0;
  attach(session);
}

// A trimmed copy of a stream: one final line break dropped, so blocks don't leave blank lines.
function streamText(text) {
  const value = typeof text === 'string' ? text : '';
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function finishRun(session, block, { stdout = '', stderr = '', line, kind }) {
  const output = term.output;
  const shown = term.shown === session && output;
  const follow = shown && atEnd(output);
  block.querySelector('.ws-term-status')?.remove();
  block.classList.remove('is-running');
  let chars = 0;
  const out = streamText(stdout);
  const err = streamText(stderr);
  if (out) { block.append(element('span', 'ws-term-out', out)); chars += out.length; }
  if (err) { block.append(element('span', 'ws-term-err', err)); chars += err.length; }
  block.append(element('span', `ws-term-result is-${kind}`, line));
  block.dataset.chars = String(chars);
  session.chars += chars;
  trim(session);
  attach(session);
  if (follow) toEnd(output);
}

/**
 * Wires the Terminal panel to the workspace bridge.
 * @param {{showToast: (message: string) => void, workspace: {root: string}}} app
 */
export function bindTerminal(app) {
  const form = $('#terminal-form');
  const input = $('#terminal-command');
  const runButton = $('#terminal-run');
  const cancelButton = $('#terminal-cancel');
  const output = $('#terminal-output');
  if (!form || !input || !runButton || !cancelButton || !output) return;
  term.output = output;
  term.input = input;
  term.shown = null;
  showTerminalFolder(app.workspace?.root || '');

  // Clear sits with Run and Cancel (built here, so the page's markup stays as it is).
  let clearButton = $('#terminal-clear');
  if (!clearButton) {
    clearButton = element('button', 'button secondary compact', 'Clear');
    clearButton.id = 'terminal-clear';
    clearButton.type = 'button';
    clearButton.title = 'Clear the output (Ctrl+L)';
    cancelButton.after(clearButton);
  }

  let running = false;
  const bridge = () => window.scalemaxAPI?.workspace || null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const command = input.value.trim();
    if (!command || running) return;
    const workspace = bridge();
    if (!workspace?.run) { app.showToast('Commands require the desktop app'); return; }

    showTerminalFolder(app.workspace?.root || '');
    const session = term.shown;
    session.history.push(command);
    input.value = '';

    const block = element('span', 'ws-term-run is-running');
    const prompt = element('span', 'ws-term-cmd');
    const sign = element('span', 'ws-term-prompt', '$ ');
    sign.setAttribute('aria-hidden', 'true');
    prompt.append(sign, document.createTextNode(command));
    block.append(prompt, element('span', 'ws-term-status', 'Running…'));
    session.node.append(block);
    attach(session);
    // A new command: the panel goes to its end, as a terminal does.
    toEnd(output);

    running = true;
    runButton.disabled = true;
    const started = now();
    let outcome;
    try {
      const result = await workspace.run({ command });
      const took = formatDuration(now() - started);
      if (result?.ok) {
        const data = result.data || {};
        const code = Number.isInteger(data.exitCode) ? data.exitCode : null;
        outcome = {
          stdout: data.stdout,
          stderr: data.stderr,
          line: code === null ? `Stopped · ${took}` : `Exit code ${code} · ${took}`,
          kind: code === null ? 'stopped' : code === 0 ? 'ok' : 'failed',
        };
      } else {
        const message = result?.error?.message || 'Command failed';
        outcome = { line: `${message} · ${took}`, kind: result?.error?.code === 'COMMAND_CANCELLED' ? 'stopped' : 'failed' };
      }
    } catch (error) {
      outcome = { line: `${error?.message || 'Command failed'} · ${formatDuration(now() - started)}`, kind: 'failed' };
    } finally {
      running = false;
      runButton.disabled = false;
    }
    finishRun(session, block, outcome);
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      clearShown();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const history = term.shown?.history;
    if (!history) return;
    const value = event.key === 'ArrowUp' ? history.previous(input.value) : history.next();
    event.preventDefault();
    if (value === null) return;
    input.value = value;
    input.setSelectionRange?.(value.length, value.length);
  });
  // Typing something new starts from the newest command again.
  input.addEventListener('input', () => term.shown?.history.reset());

  output.addEventListener('keydown', (event) => {
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      clearShown();
    }
  });

  clearButton.addEventListener('click', () => clearShown());

  cancelButton.addEventListener('click', async (event) => {
    event.preventDefault();
    const workspace = bridge();
    if (!workspace?.cancel) { app.showToast('Commands require the desktop app'); return; }
    const result = await workspace.cancel();
    if (!result?.ok) { app.showToast(result?.error?.message || 'Command could not be cancelled'); return; }
    app.showToast(result.data ? 'Command cancelled' : 'No command is running');
  });
}
