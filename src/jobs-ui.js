/**
 * Background commands the model started (lib/jobs.cjs): while any run, a bar in the message box
 * says so ("Running in the background: npm run dev" · Show), and #jobs-dialog lists them all with
 * the output as it comes, a line to type into the selected one, and Stop. Main tells the window
 * when the list changes (jobs:changed, at most four times a second). Output is read from an
 * offset; the line still being written is read again from its start until it is complete, so a
 * progress bar or a prompt shows as it ends up. Preferences > Commands (the sandbox switches)
 * live here too. DOM is built with createElement and textContent only (no HTML).
 */
const $ = (selector) => document.querySelector(selector);
// Characters of output the dialog keeps for the command on screen (main keeps 1 MB of each).
const MAX_SHOWN = 400_000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function bridge() {
  return window.scalemaxAPI?.jobs || null;
}

const state = {
  app: null,
  // Views of the jobs from main: running first, then newest first.
  jobs: [],
  // The job the dialog shows, the control that opened it, and the clock for "running for".
  selected: '',
  opener: null,
  timer: null,
  // The sandbox exists here (macOS); unknown until main says.
  sandboxAvailable: null,
};
// The output of the selected job: complete lines in `stable`, the line being written in `tail`,
// read again from `cursor` (the start of that line).
const output = { id: '', cursor: 0, stable: null, tail: null, reading: false, again: false, token: 0 };
// Jobs with a Stop on the way.
const stopping = new Set();

function validJob(job) {
  return job && typeof job === 'object' && typeof job.id === 'string' && typeof job.command === 'string';
}
function selectedJob() {
  return state.jobs.find((job) => job.id === state.selected) || null;
}
// The folder of the task on screen (or the open folder its next message takes).
function folderPath(app = state.app) {
  return app?.taskFolderShown?.()?.path || '';
}

function elapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** "Running for 2m 3s", "Finished after 4s", "Failed (exit code 1) after 2s", "Stopped after 1m 0s". */
export function jobStatus(job, now = Date.now()) {
  if (job.status === 'running') return `Running for ${elapsed(now - job.startedAt)}`;
  const after = Number.isFinite(job.endedAt) ? ` after ${elapsed(job.endedAt - job.startedAt)}` : '';
  if (job.status === 'stopped') return `Stopped${after}`;
  if (job.status === 'exited') return `Finished${after}`;
  const why = Number.isInteger(job.exitCode) ? ` (exit code ${job.exitCode})` : job.signal ? ` (${job.signal})` : '';
  return `Failed${why}${after}`;
}
function whereText(job) {
  const parts = [];
  if (job.folderName) parts.push(`In ${job.folderName}`);
  parts.push(job.sandboxed ? (job.network ? 'in the sandbox' : 'in the sandbox, without network') : 'outside the sandbox');
  if (job.tty) parts.push('in a terminal');
  return parts.join(' · ');
}

// ---- The bar in the message box ------------------------------------------------------------

/** Shows the bar while a background command runs: this folder's by name, others as a count. */
export function renderJobsBar(app = state.app) {
  const bar = $('#jobs-bar');
  const text = $('#jobs-bar-text');
  if (!bar || !text) return;
  const running = state.jobs.filter((job) => job.status === 'running');
  bar.hidden = running.length === 0;
  if (!running.length) return;
  const path = folderPath(app);
  const here = running.filter((job) => job.root === path);
  const elsewhere = running.length - here.length;
  const commands = (count) => `${count} ${count === 1 ? 'command' : 'commands'}`;
  let label = here.length === 1 ? `Running in the background: ${here[0].command}`
    : here.length > 1 ? `${commands(here.length)} running in the background`
      : `${commands(elsewhere)} running in the background in other folders`;
  if (here.length && elsewhere) label += ` · ${elsewhere} in other folders`;
  text.textContent = label;
  text.title = here.length === 1 ? here[0].command : '';
}

// ---- The dialog ----------------------------------------------------------------------------

let listSignature = '';
function renderList(force = false) {
  const host = $('#jobs-list');
  if (!host) return;
  // Rebuilt only when jobs come, go or change state; the times are refreshed in place.
  const signature = state.jobs.map((job) => `${job.id}:${job.status}`).join(',') + `|${state.selected}`;
  if (!force && signature === listSignature) {
    refreshTimes();
    return;
  }
  listSignature = signature;
  const hadFocus = host.contains(document.activeElement);
  if (!state.jobs.length) {
    host.replaceChildren(element('p', 'jobs-empty', 'No background commands yet.'));
    return;
  }
  host.replaceChildren(...state.jobs.map((job) => {
    const item = element('button', 'jobs-item');
    item.dataset.id = job.id;
    item.dataset.status = job.status;
    const selected = job.id === state.selected;
    item.classList.toggle('is-selected', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    const dot = element('span', `jobs-dot is-${job.status}`);
    dot.setAttribute('aria-hidden', 'true');
    const body = element('span', 'jobs-item-body');
    body.append(element('span', 'jobs-item-command', job.command), element('span', 'jobs-item-meta', `${job.folderName || 'Folder'} · ${jobStatus(job)}`));
    item.append(dot, body);
    item.title = job.command;
    item.addEventListener('click', () => select(job.id));
    return item;
  }));
  if (hadFocus) host.querySelector('.jobs-item.is-selected')?.focus();
}
function refreshTimes() {
  for (const node of document.querySelectorAll('#jobs-list .jobs-item')) {
    const job = state.jobs.find((item) => item.id === node.dataset.id);
    const meta = node.querySelector('.jobs-item-meta');
    if (job && meta) meta.textContent = `${job.folderName || 'Folder'} · ${jobStatus(job)}`;
  }
  const job = selectedJob();
  const stateNode = $('#jobs-state');
  if (stateNode) stateNode.textContent = job ? jobStatus(job) : '';
}
function renderView() {
  const job = selectedJob();
  const command = $('#jobs-command');
  if (command) command.textContent = job ? job.command : '';
  const where = $('#jobs-where');
  if (where) where.textContent = job ? whereText(job) : '';
  refreshTimes();
  const running = Boolean(job && job.status === 'running');
  const stop = $('#jobs-stop');
  if (stop) {
    const waiting = Boolean(job && stopping.has(job.id));
    stop.disabled = !running || waiting;
    stop.textContent = waiting ? 'Stopping…' : 'Stop';
  }
  // Typing is for a command that runs; an ended one only shows what it printed.
  const input = $('#jobs-input');
  const send = $('#jobs-send');
  const form = $('#jobs-input-form');
  if (input) input.disabled = !running;
  if (send) send.disabled = !running;
  if (form) form.hidden = !running;
  // A control that just turned off keeps no focus.
  const dialog = $('#jobs-dialog');
  const active = document.activeElement;
  if (dialog?.open && active && dialog.contains(active) && active.disabled) {
    (dialog.querySelector('.jobs-item.is-selected') || $('#jobs-close'))?.focus();
  }
}

function resetOutput(id) {
  output.token += 1;
  Object.assign(output, { id, cursor: 0, reading: false, again: false });
  const pre = $('#jobs-output');
  if (!pre) return;
  output.stable = document.createTextNode('');
  output.tail = document.createTextNode('');
  if (!id) {
    output.stable = null;
    pre.replaceChildren(element('span', 'jobs-output-empty', 'When the model starts a dev server, a watcher or a long build in the background, it shows here with its output.'));
    return;
  }
  pre.replaceChildren(output.stable, output.tail);
}
function applyOutput(data) {
  const pre = $('#jobs-output');
  if (!pre || !output.stable || !data || typeof data.complete !== 'string') return;
  // Only follow the end while the reader is there.
  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  if (data.dropped > 0) output.stable.appendData(output.cursor > 0 ? '\n[Output that was not kept is left out here]\n' : '[Earlier output is not shown]\n');
  output.stable.appendData(data.complete);
  output.tail.data = typeof data.partial === 'string' ? data.partial : '';
  if (Number.isSafeInteger(data.lineStart)) output.cursor = data.lineStart;
  const extra = output.stable.length - MAX_SHOWN;
  if (extra > 0) {
    const cut = output.stable.data.indexOf('\n', extra);
    output.stable.deleteData(0, cut >= 0 ? cut + 1 : extra);
  }
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}
async function readOutput() {
  const api = bridge();
  if (!api?.output || !output.id || !$('#jobs-dialog')?.open) return;
  if (output.reading) {
    output.again = true;
    return;
  }
  output.reading = true;
  const token = output.token;
  let result;
  try {
    result = await api.output({ id: output.id, from: output.cursor });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (token !== output.token) return;
  output.reading = false;
  if (result?.ok) applyOutput(result.data);
  if (output.again) {
    output.again = false;
    void readOutput();
  }
}

function select(id) {
  state.selected = id;
  renderList(true);
  renderView();
  resetOutput(id);
  void readOutput();
}
function setJobs(list) {
  state.jobs = Array.isArray(list) ? list.filter(validJob) : [];
  renderJobsBar();
  if (!$('#jobs-dialog')?.open) return;
  // The one on screen was forgotten (main keeps the last 20 that ended).
  if (state.selected && !selectedJob()) {
    select(state.jobs[0]?.id || '');
    return;
  }
  renderList();
  renderView();
  void readOutput();
}
async function refreshList() {
  let result;
  try {
    result = await bridge()?.list();
  } catch {
    result = null;
  }
  if (result?.ok) setJobs(result.data);
}

/** Opens the dialog on job `id`, or this folder's running command, or the newest one. */
export async function openJobs(app = state.app, { id = '', opener = null } = {}) {
  const dialog = $('#jobs-dialog');
  if (!dialog || !bridge()) return;
  state.opener = opener || document.activeElement;
  await refreshList();
  const path = folderPath(app);
  const pick = state.jobs.find((job) => job.id === id)
    || state.jobs.find((job) => job.status === 'running' && job.root === path)
    || state.jobs.find((job) => job.root === path)
    || state.jobs[0];
  if (!dialog.open) dialog.showModal();
  clearInterval(state.timer);
  state.timer = setInterval(refreshTimes, 1000);
  select(pick?.id || '');
  (dialog.querySelector('.jobs-item.is-selected') || $('#jobs-close'))?.focus();
}

async function stopJob(id) {
  const api = bridge();
  if (!api?.stop || !id || stopping.has(id)) return;
  stopping.add(id);
  renderView();
  let result;
  try {
    result = await api.stop({ id });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  stopping.delete(id);
  if (!result?.ok) state.app?.showToast?.(result?.error?.message || 'The command could not be stopped');
  await refreshList();
  renderView();
}
async function typeInto(event) {
  event.preventDefault();
  const api = bridge();
  const input = $('#jobs-input');
  const job = selectedJob();
  if (!api?.input || !input || !job || job.status !== 'running') return;
  const text = input.value;
  input.value = '';
  let result;
  try {
    result = await api.input({ id: job.id, text: `${text}\n` });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (!result?.ok) {
    if (!input.value) input.value = text;
    state.app?.showToast?.(result?.error?.message || 'That could not be typed into the command');
  }
}

// ---- Preferences > Commands ----------------------------------------------------------------

/** The sandbox switches, from the settings; off where there is no sandbox. */
export function renderCommandSettings(app = state.app) {
  const settings = app?.settings || {};
  const known = state.sandboxAvailable !== null;
  const available = state.sandboxAvailable === true;
  const on = settings.sandbox !== false;
  const toggle = $('#sandbox-toggle');
  if (toggle) {
    // Until main says, the switch shows the setting but waits.
    toggle.setAttribute('aria-checked', String(on && (available || !known)));
    toggle.disabled = !available;
  }
  const network = $('#sandbox-network-toggle');
  if (network) {
    network.setAttribute('aria-checked', String(settings.sandboxNetwork !== false));
    network.disabled = !available || !on;
  }
  const note = $('#sandbox-unavailable');
  if (note) note.hidden = available || state.sandboxAvailable === null;
}

export function bindJobsUi(app) {
  state.app = app;
  const api = bridge();
  const dialog = $('#jobs-dialog');
  if (!api) {
    state.sandboxAvailable = false;
    renderCommandSettings(app);
    return;
  }
  api.onChanged?.((list) => setJobs(list));
  void refreshList();
  void Promise.resolve(api.info?.()).then((result) => {
    state.sandboxAvailable = Boolean(result?.ok && result.data?.sandboxAvailable === true);
    renderCommandSettings(app);
  }).catch(() => {
    state.sandboxAvailable = false;
    renderCommandSettings(app);
  });
  $('#jobs-bar-show')?.addEventListener('click', (event) => void openJobs(app, { opener: event.currentTarget }));
  $('#jobs-close')?.addEventListener('click', () => dialog?.close());
  $('#jobs-stop')?.addEventListener('click', () => void stopJob(state.selected));
  $('#jobs-input-form')?.addEventListener('submit', (event) => void typeInto(event));
  dialog?.addEventListener('close', () => {
    clearInterval(state.timer);
    state.timer = null;
    output.token += 1;
    output.id = '';
    const opener = state.opener;
    state.opener = null;
    if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus();
    else $('#chat-input')?.focus();
  });
  // Main reads the settings before each command.
  const flip = (key) => async () => {
    app.settings[key] = app.settings[key] === false;
    renderCommandSettings(app);
    await app.persist('settings');
  };
  $('#sandbox-toggle')?.addEventListener('click', flip('sandbox'));
  $('#sandbox-network-toggle')?.addEventListener('click', flip('sandboxNetwork'));
}
