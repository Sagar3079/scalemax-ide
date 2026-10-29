/**
 * Sessions like Claude Code's:
 *   - "Rewind to here" on a message the user sent takes the conversation back to just before it
 *     (its text returns to the message box) and can also undo what the later replies changed in
 *     the folder (#rewind-dialog). Undo is lib/checkpoints.cjs's: a file goes back only while it
 *     is exactly as its reply left it, so edits made since are never lost; the files that stay as
 *     they are, and why, are listed;
 *   - "Fork from here" copies the conversation before that message into a new task in the same
 *     folder, with the message waiting in the message box;
 *   - "Recent sessions" (⌘⇧O, #sessions-dialog) finds a task by its title or its words;
 *   - "Export transcript" saves the task as Markdown where the user chooses.
 * The pure half is src/sessions.mjs. DOM is built with createElement and textContent only.
 */
import {
  rewindPlan, rewoundTask, undoOrder, rewindReport, forkedTask, sessionResults, transcriptMarkdown, unsharedChangeIds, fullTaskTitle,
  normalizeWorktree,
} from './sessions.mjs';
import { taskTime, plainPreview, taskTitleParts } from './domain.mjs';
import { reloadTabs } from './workspace-ui.js';
import { keyLabel } from './shortcuts.mjs';

const $ = (selector) => document.querySelector(selector);


function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const excerpt = (text, size = 60) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > size ? `${flat.slice(0, size)}…` : flat;
};
// The task is working (a reply or a compaction): its conversation must not change under it.
function taskBusy(app, taskId) {
  return app.replies.has(taskId) || Boolean(app.compactingTasks?.has(taskId)) || Boolean(app.demoBusy && app.currentTaskId === taskId);
}
// Puts `text` in the message box, unless the user has a draft there (`replace` for a rewind,
// which the dialog says).
function toComposer(app, text, { replace = false } = {}) {
  const input = $('#chat-input');
  if (!input) return false;
  if (input.value.trim() && !replace) return false;
  input.value = text;
  app.updateSendEnabled();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

/** Rewind / Fork under one of the user's messages (src/app.js renderChat). */
export function renderMessageActions(app, task, index) {
  if (!task || task.messages[index]?.role !== 'user') return null;
  const row = element('div', 'msg-actions');
  const busy = taskBusy(app, task.id);
  const back = element('button', 'msg-action', 'Rewind to here');
  back.dataset.sessionAction = 'rewind';
  back.setAttribute('aria-label', 'Rewind the conversation to just before this message');
  back.title = busy ? 'Wait for the reply to finish first' : 'Go back to just before this message; its text returns to the message box';
  back.disabled = busy;
  back.addEventListener('click', (event) => openRewind(app, task.id, index, event.currentTarget));
  const fork = element('button', 'msg-action', 'Fork from here');
  fork.dataset.sessionAction = 'fork';
  fork.setAttribute('aria-label', 'Fork the conversation into a new task from this message');
  fork.title = 'A new task with the conversation up to here, in the same folder';
  fork.addEventListener('click', () => forkFrom(app, task.id, index));
  row.append(back, fork);
  return row;
}

// ---- Rewind -------------------------------------------------------------------------------

// The rewind being confirmed: the task, the message (by identity, so a conversation that changed
// meanwhile is not cut at the wrong place) and its plan.
const rewind = { app: null, taskId: '', index: -1, message: null, length: 0, plan: null, opener: null, busy: false };

function setRewindStatus(text) {
  const node = $('#rewind-status');
  if (node) node.textContent = text || '';
}

function openRewind(app, taskId, index, opener = null) {
  const dialog = $('#rewind-dialog');
  const task = app.tasks.find((item) => item.id === taskId);
  if (!dialog || !task) return;
  if (taskBusy(app, taskId)) {
    app.showToast('Wait for the reply to finish, or stop it, then rewind.');
    return;
  }
  const plan = rewindPlan(task, index);
  if (!plan) return;
  Object.assign(rewind, { app, taskId, index, message: task.messages[index], length: task.messages.length, plan, opener, busy: false });
  const later = plan.removed - 1;
  $('#rewind-text').textContent = `The conversation goes back to just before “${excerpt(plan.text)}”. This message${later ? ` and the ${plural(later, 'message')} after it are` : ' is'} removed, and its text returns to the message box.`
    + (plan.compaction === 'dropped' ? ' The summary of older messages goes too, as it covered some of them.' : '');
  const files = $('#rewind-files');
  const undo = $('#rewind-undo');
  const replies = plan.replies.filter((reply) => reply.files.length);
  files.hidden = !plan.files;
  undo.hidden = !plan.files;
  if (plan.files) {
    files.textContent = `${plural(replies.length, 'later reply', 'later replies')} changed ${plural(plan.files, 'file')} in the folder. "Rewind and undo file changes" puts them back as they were; a file changed since is left as it is and listed.`;
  }
  $('#rewind-draft').hidden = !$('#chat-input')?.value.trim();
  $('#rewind-report').hidden = true;
  $('#rewind-report').replaceChildren();
  $('#rewind-confirm').hidden = false;
  $('#rewind-cancel').textContent = 'Cancel';
  setRewindStatus('');
  renderRewindButtons();
  dialog.showModal();
  $('#rewind-confirm').focus();
}

function renderRewindButtons() {
  for (const id of ['#rewind-confirm', '#rewind-undo']) {
    const button = $(id);
    if (button) button.disabled = rewind.busy;
  }
}

// The task and message the dialog was opened for, unchanged.
function rewindTarget() {
  const { app, taskId, index, message, length } = rewind;
  const task = app?.tasks.find((item) => item.id === taskId);
  if (!task || task.messages[index] !== message || task.messages.length !== length) return null;
  return task;
}

async function runRewind({ undoFiles = false } = {}) {
  const { app, index, plan } = rewind;
  if (rewind.busy || !plan) return;
  let task = rewindTarget();
  if (!task) {
    setRewindStatus('This conversation changed meanwhile. Close this and try again.');
    return;
  }
  if (taskBusy(app, task.id)) {
    setRewindStatus('A reply is working in this task. Wait for it to finish, or stop it.');
    return;
  }
  let report = null;
  const folder = task.folder?.path || '';
  if (undoFiles && plan.files) {
    const api = window.scalemaxAPI?.checkpoints;
    const paths = new Set(plan.replies.flatMap((reply) => reply.files));
    const unsaved = folder && folder === app.workspace.root ? (app.workspace.tabs || []).filter((tab) => tab.dirty && paths.has(tab.path)).map((tab) => tab.path) : [];
    if (unsaved.length) {
      setRewindStatus(`Save or close ${unsaved[0]} in the editor first.`);
      return;
    }
    if (!api?.undo) {
      setRewindStatus('Undoing file changes needs the desktop app.');
      return;
    }
    rewind.busy = true;
    renderRewindButtons();
    setRewindStatus('Putting files back…');
    // Newest reply first: a file two replies changed goes back one step at a time.
    const outcomes = [];
    for (const reply of undoOrder(plan)) {
      let result;
      try {
        result = await api.undo({ id: reply.id });
      } catch (error) {
        result = { ok: false, error: { message: error?.message } };
      }
      outcomes.push({ id: reply.id, ok: Boolean(result?.ok), results: result?.data?.results || [], error: result?.error?.message || '', kept: reply.kept });
    }
    rewind.busy = false;
    renderRewindButtons();
    report = rewindReport(outcomes);
    task = rewindTarget();
    if (!task) {
      setRewindStatus('The files were put back, but the conversation changed meanwhile, so it was not rewound.');
      return;
    }
  }
  const removed = task.messages.slice(index);
  const forget = unsharedChangeIds(app.tasks, task, removed);
  const next = rewoundTask(task, index);
  task.messages = next.messages;
  if (next.compaction) task.compaction = next.compaction;
  else delete task.compaction;
  // Back to no message at all: it is the empty task now (there is never more than one).
  if (!task.messages.length) app.tasks = app.tasks.filter((item) => item.messages.length || item === task);
  app.updateTask(task, next.updatedAt);
  // The removed replies' recorded changes go with them (unless a fork still shows them).
  if (forget.length) void window.scalemaxAPI?.checkpoints?.remove?.({ ids: forget });
  if (app.currentTaskId !== task.id) app.selectTask(task.id);
  else {
    app.renderChat();
    app.renderFolder();
  }
  toComposer(app, plan.text, { replace: true });
  if (report?.restored.length && folder === app.workspace.root) {
    void app.refreshWorkspace?.();
    void reloadTabs(app, report.restored);
  }
  if (report?.notRestored.length) {
    // What stayed as it is, in the dialog (a toast would be gone too soon).
    rewind.plan = null;
    const list = $('#rewind-report');
    list.replaceChildren(
      element('li', 'rewind-report-head', `Rewound. ${report.restored.length ? `${plural(report.restored.length, 'file')} put back; ` : ''}${plural(report.notRestored.length, 'file was', 'files were')} left as ${report.notRestored.length === 1 ? 'it is' : 'they are'}:`),
      ...report.notRestored.slice(0, 50).map((item) => element('li', 'rewind-report-item', item.message)),
    );
    list.hidden = false;
    $('#rewind-files').hidden = true;
    $('#rewind-undo').hidden = true;
    $('#rewind-confirm').hidden = true;
    $('#rewind-cancel').textContent = 'Close';
    setRewindStatus('');
    $('#rewind-cancel').focus();
    return;
  }
  rewind.opener = null;
  $('#rewind-dialog').close();
  app.showToast(report ? `Rewound and put back ${plural(report.restored.length, 'file')}` : 'Rewound: the message is back in the message box');
}

// ---- Fork ---------------------------------------------------------------------------------

function forkFrom(app, taskId, index) {
  const task = app.tasks.find((item) => item.id === taskId);
  const message = task?.messages[index];
  if (!task || message?.role !== 'user') return;
  let fork = null;
  if (index === 0) {
    // Nothing before it: a new task in the same folder (the empty one, if there is one).
    fork = app.newTask({ folder: task.folder });
    if (!fork) return;
    const worktree = normalizeWorktree(task.worktree);
    if (worktree && fork.folder?.path === worktree.path) {
      fork.worktree = worktree;
      void app.persist('tasks');
    }
  } else {
    const blank = app.makeTask('Fork');
    fork = forkedTask(task, index, { id: blank.id, now: blank.createdAt });
    if (!fork) return;
    app.tasks = [fork, ...app.tasks];
    void app.persist('tasks');
    app.selectTask(fork.id);
  }
  const placed = toComposer(app, message.text);
  app.showToast(placed ? 'Forked into a new task: the message waits in the message box'
    : 'Forked into a new task (your draft stays in the message box)');
}

// ---- Recent sessions ------------------------------------------------------------------------

const picker = { app: null, results: [], active: 0, opener: null };

// A preview shows the message as the text it reads as, not its Markdown ("## Done - Added
// `src/x.js`"): plainPreview, kept per message until its text changes, then cut around the match
// like sessionResults' snippet.
const SNIPPET = 140;
const plainTexts = new WeakMap();
function plainOf(message) {
  const kept = plainTexts.get(message);
  if (kept?.text === message.text) return kept.plain;
  const plain = plainPreview(message.text).replace(/\s+/g, ' ').trim();
  plainTexts.set(message, { text: message.text, plain });
  return plain;
}
/** The preview under a task in Recent sessions: its matching (or last) message as plain text, cut around the match. */
export function sessionPreview(task, query) {
  const messages = (Array.isArray(task?.messages) ? task.messages : [])
    .filter((message) => message && typeof message === 'object' && typeof message.text === 'string');
  const needle = String(query || '').trim().toLowerCase();
  const hit = needle ? messages.find((message) => message.text.toLowerCase().includes(needle)) : null;
  const message = hit || [...messages].reverse().find((item) => item.text.trim());
  if (!message) return '';
  const flat = plainOf(message);
  const at = hit ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat;
  const start = Math.max(0, at - 40);
  return `${start ? '…' : ''}${flat.slice(start, start + SNIPPET)}${start + SNIPPET < flat.length ? '…' : ''}`;
}

function renderPicker() {
  const list = $('#sessions-list');
  const input = $('#sessions-search');
  if (!list || !input) return;
  const query = input.value;
  picker.results = sessionResults(picker.app.tasks, query);
  picker.active = Math.min(Math.max(0, picker.active), Math.max(0, picker.results.length - 1));
  if (!picker.results.length) {
    list.replaceChildren(element('p', 'sessions-empty', query.trim() ? `No task mentions “${query.trim()}”.` : 'No conversations yet.'));
    input.removeAttribute('aria-activedescendant');
    return;
  }
  list.replaceChildren(...picker.results.map((result, index) => {
    const item = element('div', 'sessions-item');
    item.id = `sessions-item-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === picker.active));
    item.classList.toggle('is-active', index === picker.active);
    item.classList.toggle('is-current', result.id === picker.app.currentTaskId);
    item.dataset.taskId = result.id;
    const head = element('span', 'sessions-item-head');
    // A fork is marked before its title, as in the sidebar.
    const parts = taskTitleParts(result.title);
    const title = element('span', 'sessions-item-title');
    if (parts.fork) title.append(element('span', 'task-fork-tag', 'fork'), ' ');
    title.append(parts.title);
    head.append(title, element('span', 'sessions-item-time', taskTime(result.updatedAt)));
    const meta = element('span', 'sessions-item-meta', `${result.folderName || 'No folder'} · ${plural(result.messages, 'message')}`);
    if (result.folderPath) meta.title = result.folderPath;
    item.append(head, meta);
    const task = picker.app.tasks.find((entry) => entry.id === result.id);
    const snippet = task ? sessionPreview(task, query) : result.snippet;
    if (snippet) item.append(element('span', 'sessions-item-snippet', snippet));
    item.addEventListener('click', () => choose(result.id));
    return item;
  }));
  input.setAttribute('aria-activedescendant', `sessions-item-${picker.active}`);
  $(`#sessions-item-${picker.active}`)?.scrollIntoView({ block: 'nearest' });
}

function choose(taskId) {
  const dialog = $('#sessions-dialog');
  picker.opener = null;
  dialog?.close();
  picker.app.selectTask(taskId);
}

/** Opens the Recent sessions picker. */
export function openSessions(app) {
  const dialog = $('#sessions-dialog');
  if (!dialog) return;
  picker.app = app;
  if (!dialog.open) picker.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  picker.active = 0;
  $('#sessions-search').value = '';
  renderPicker();
  if (!dialog.open) dialog.showModal();
  $('#sessions-search').focus();
}

// ---- Export transcript ------------------------------------------------------------------------

async function exportTranscript(app) {
  const task = app.currentTask();
  if (!task?.messages.length) {
    app.showToast('This task has no conversation yet');
    return;
  }
  const api = window.scalemaxAPI?.sessions;
  if (!api?.exportTranscript) {
    app.showToast('Saving files needs the desktop app');
    return;
  }
  let result;
  try {
    // The whole title (not the sidebar's 40 characters and "…"): main names the file from it,
    // cut between words at 60 characters (src/sessions.mjs transcriptFileName).
    result = await api.exportTranscript({ title: fullTaskTitle(task), markdown: transcriptMarkdown(task) });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (!result?.ok) app.showToast(result?.error?.message || 'The transcript could not be saved.');
  else if (result.data?.saved) app.showToast(`Saved ${result.data.name}`);
}

export function bindSessionsUi(app) {
  rewind.app = app;
  picker.app = app;
  const rewindDialog = $('#rewind-dialog');
  if (rewindDialog) {
    $('#rewind-cancel')?.addEventListener('click', () => rewindDialog.close());
    $('#rewind-close')?.addEventListener('click', () => rewindDialog.close());
    $('#rewind-confirm')?.addEventListener('click', () => void runRewind());
    $('#rewind-undo')?.addEventListener('click', () => void runRewind({ undoFiles: true }));
    // Escape while files are being put back would leave the result unseen: wait for it.
    rewindDialog.addEventListener('cancel', (event) => { if (rewind.busy) event.preventDefault(); });
    rewindDialog.addEventListener('close', () => {
      const opener = rewind.opener;
      rewind.opener = null;
      rewind.plan = null;
      if (opener?.isConnected) opener.focus();
      else $('#chat-input')?.focus();
    });
  }
  const sessions = $('#sessions-dialog');
  if (sessions) {
    $('#sessions-close')?.addEventListener('click', () => sessions.close());
    $('#sessions-search')?.addEventListener('input', () => {
      picker.active = 0;
      renderPicker();
    });
    $('#sessions-search')?.addEventListener('keydown', (event) => {
      const count = picker.results.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!count) return;
        picker.active = (picker.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderPicker();
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        if (count) choose(picker.results[picker.active].id);
      }
    });
    sessions.addEventListener('close', () => {
      const opener = picker.opener;
      picker.opener = null;
      if (opener?.isConnected) opener.focus();
    });
  }
  $('#sessions-btn')?.addEventListener('click', () => openSessions(app));
  $('#export-transcript-btn')?.addEventListener('click', () => void exportTranscript(app));
  // ⌘⇧O (Ctrl+Shift+O elsewhere) opens it from anywhere: src/shortcuts.mjs, run by src/app.js.
  const button = $('#sessions-btn');
  if (button) button.title = `Recent sessions (${keyLabel({ mod: true, shift: true, key: 'O' }, { mac: app.isMac?.() !== false })})`;
}
