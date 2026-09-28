/**
 * What a reply changed in its folder, shown under the reply the way coding agents let you review
 * their work: "2 files changed · +12 −4", each file with Undo and Keep, and Undo all / Keep all.
 * A file's name opens its change as a diff in #changes-dialog. Undo puts a file back only while
 * it is exactly as the reply left it (main checks, lib/checkpoints.cjs), so later work is never
 * overwritten; the model hears about undone files with the next message (historyMessages in
 * src/domain.mjs). DOM is built with createElement and textContent only (no HTML).
 */
import { normalizeChanges, changesSummary } from './domain.mjs';
import { reloadTabs } from './workspace-ui.js';

const $ = (selector) => document.querySelector(selector);
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function bridge() {
  return window.scalemaxAPI?.checkpoints || null;
}
const STATUS_LABELS = { kept: 'Kept', undone: 'Undone' };
const CURRENT_TEXT = {
  same: '',
  original: 'Back as it was before this reply.',
  changed: 'Changed since this reply, so it cannot be undone here.',
  missing: 'This file no longer exists.',
  unknown: 'Open the task\'s folder to undo this file.',
};
const MIXED_TEXT = 'Also changed by someone else while the reply ran, so it cannot be undone here.';
// The review dialog: which reply and file it shows, and the control that opened it.
const review = { app: null, taskId: '', id: '', path: '', opener: null, token: 0, current: 'unknown' };
// Replies with an undo or keep on the way (their buttons wait).
const busy = new Set();

function findMessage(app, taskId, id) {
  const task = app?.tasks.find((item) => item.id === taskId) || null;
  const message = task?.messages.find((item) => item.changes?.id === id) || null;
  return { task, message };
}
// The reply ran commands: what they changed is not in the list.
function ranCommands(message) {
  return (message.steps || []).some((step) => step.type === 'tool' && step.server === 'Workspace' && step.tool === 'run_command')
    || (message.tools || []).some((call) => call.server === 'Workspace' && call.tool === 'run_command');
}
function actionButton(label, className, ariaLabel, onClick) {
  const button = element('button', className, label);
  button.dataset.action = label.toLowerCase().replace(/\s+/g, '-');
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}
function counts(file) {
  const node = element('span', 'changes-counts');
  // Replaced whole: the counts are the size of the change, not a line-by-line comparison.
  const about = file.approximate ? '\u2248' : '';
  if (file.approximate) node.title = 'Too different to compare line by line: counted as replaced';
  if (file.added) node.append(element('span', 'changes-added', `${about}+${file.added}`));
  if (file.removed) node.append(element('span', 'changes-removed', `${about}\u2212${file.removed}`));
  if (!file.added && !file.removed) node.append(element('span', 'changes-zero', file.kind === 'created' ? 'empty' : '±0'));
  return node;
}
const undoable = (file) => file.status === 'changed' && !file.untracked && !file.mixed;

/** The card under a reply that changed files, or null. */
export function renderChangesCard(app, message, taskId) {
  const changes = normalizeChanges(message.changes);
  if (!changes) return null;
  const { id } = changes;
  const waiting = busy.has(id);
  const card = element('section', 'changes-card');
  card.dataset.changesId = id;
  card.setAttribute('aria-label', 'Files this reply changed');
  const head = element('div', 'changes-head');
  head.append(element('span', 'changes-summary', changesSummary(changes)));
  const open = changes.files.filter((file) => file.status === 'changed' && !file.untracked);
  const canUndo = open.filter(undoable);
  if (open.length > 1) {
    const actions = element('div', 'changes-actions');
    if (canUndo.length) {
      const undoAll = actionButton('Undo all', 'changes-action', `Undo all ${canUndo.length} changed files of this reply`,
        () => void undoFiles(app, taskId, id, canUndo.map((file) => file.path), { all: true }));
      undoAll.disabled = waiting;
      actions.append(undoAll);
    }
    const keepAll = actionButton('Keep all', 'changes-action', `Keep all ${open.length} changed files of this reply`,
      () => void keepFiles(app, taskId, id, open.map((file) => file.path), { all: true }));
    keepAll.disabled = waiting;
    actions.append(keepAll);
    head.append(actions);
  }
  card.append(head);
  const list = element('ul', 'changes-list');
  for (const file of changes.files) {
    const row = element('li', 'changes-row');
    row.dataset.path = file.path;
    row.dataset.status = file.status;
    const kind = element('span', `changes-kind is-${file.kind}`, file.kind === 'created' ? 'New' : 'Edited');
    const name = element('button', 'changes-file', file.path);
    name.title = file.untracked ? 'This file was not recorded' : `Review the changes to ${file.path}`;
    name.setAttribute('aria-label', `Review the changes to ${file.path}`);
    name.disabled = Boolean(file.untracked);
    name.addEventListener('click', (event) => void openReview(app, taskId, id, file.path, event.currentTarget));
    row.append(kind, name, counts(file));
    if (file.untracked) {
      row.append(element('span', 'changes-state', 'Not recorded'));
    } else if (file.status !== 'changed') {
      row.append(element('span', `changes-state is-${file.status}`, STATUS_LABELS[file.status]));
    } else {
      if (file.mixed) {
        const state = element('span', 'changes-state is-mixed', 'Also changed by others');
        state.title = MIXED_TEXT;
        row.append(state);
      } else {
        const undo = actionButton('Undo', 'changes-action', `Undo the changes to ${file.path}`, () => void undoFiles(app, taskId, id, [file.path]));
        undo.disabled = waiting;
        row.append(undo);
      }
      const keep = actionButton('Keep', 'changes-action', `Keep the changes to ${file.path}`, () => void keepFiles(app, taskId, id, [file.path]));
      keep.disabled = waiting;
      row.append(keep);
    }
    list.append(row);
  }
  card.append(list);
  if (changes.omitted) {
    card.append(element('p', 'changes-note', `${changes.omitted} more ${changes.omitted === 1 ? 'file was' : 'files were'} changed but ${changes.omitted === 1 ? 'is' : 'are'} not listed.`));
  }
  if (ranCommands(message)) {
    card.append(element('p', 'changes-note', 'Commands this reply ran may have changed other files too; those are not listed here.'));
  }
  return card;
}

// After the transcript was drawn again: focus back on the file that was acted on (its name, as
// its buttons may be gone), or on the card's first file.
function focusCard(id, path) {
  const card = document.querySelector(`.changes-card[data-changes-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const target = (path && card.querySelector(`.changes-row[data-path="${CSS.escape(path)}"] .changes-file`))
    || card.querySelector('.changes-file:not(:disabled)');
  target?.focus();
}
// Keyboard focus is inside this reply's card (so it follows the redraw).
function focusInCard(id) {
  const active = document.activeElement;
  return Boolean(active?.closest?.(`.changes-card[data-changes-id="${CSS.escape(id)}"]`));
}
// The reply's changes as main now reports them: saved with the task and drawn again. Null means
// the reply's changes add up to nothing any more: the card goes.
function applyChanges(app, taskId, id, summary) {
  const { message } = findMessage(app, taskId, id);
  if (!message) return;
  const changes = normalizeChanges(summary);
  if (changes) message.changes = changes;
  else delete message.changes;
  void app.persist('tasks');
  if (app.currentTaskId === taskId) app.renderChat();
}
// Files among `paths` open in the editor with unsaved edits (an undo would conflict with them).
function unsavedAmong(app, taskId, paths) {
  const task = app.tasks.find((item) => item.id === taskId);
  const folder = task?.folder?.path || '';
  if (!folder || folder !== app.workspace.root) return [];
  return (app.workspace.tabs || []).filter((tab) => tab.dirty && paths.includes(tab.path)).map((tab) => tab.path);
}

/** Undoes files of a reply. `paths` are the files as the card lists them. */
export async function undoFiles(app, taskId, id, paths, { all = false } = {}) {
  const api = bridge();
  const { message, task } = findMessage(app, taskId, id);
  if (!api?.undo || !message || busy.has(id)) return false;
  const files = normalizeChanges(message.changes)?.files || [];
  const targets = files.filter((file) => undoable(file) && paths.includes(file.path)).map((file) => file.path);
  if (!targets.length) return false;
  const unsaved = unsavedAmong(app, taskId, targets);
  if (unsaved.length) {
    app.showToast(`Save or close ${unsaved[0]} in the editor first.`);
    return false;
  }
  const refocus = focusInCard(id);
  busy.add(id);
  if (app.currentTaskId === taskId) app.renderChat();
  if (refocus) focusCard(id, all ? '' : targets[0]);
  let result;
  try {
    // Exactly the files the card showed: nothing the user could not see is touched.
    result = await api.undo({ id, paths: targets });
  } catch (error) {
    result = { ok: false, error: { message: error?.message || 'The changes could not be undone.' } };
  } finally {
    busy.delete(id);
  }
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'The changes could not be undone.');
    if (app.currentTaskId === taskId) app.renderChat();
    if (refocus) focusCard(id, all ? '' : targets[0]);
    return false;
  }
  applyChanges(app, taskId, id, result.data.changes);
  if (refocus) focusCard(id, all ? '' : targets[0]);
  const results = Array.isArray(result.data.results) ? result.data.results : [];
  const done = results.filter((item) => item.ok).map((item) => item.path);
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    app.showToast(failed.length > 1 ? `${failed[0].message} (${failed.length - 1} more not undone)` : failed[0].message);
  } else if (done.length) {
    app.showToast(done.length === 1 ? `Undid the changes to ${done[0]}` : `Undid the changes to ${done.length} files`);
  }
  // The open folder shows the files as they are now.
  if (done.length && task?.folder?.path && task.folder.path === app.workspace.root) {
    void app.refreshWorkspace?.();
    void reloadTabs(app, done);
  }
  if (review.id === id && $('#changes-dialog')?.open) await showFile(review.path);
  return failed.length === 0;
}

/** Keeps files of a reply: no more undo for them. */
export async function keepFiles(app, taskId, id, paths, { all = false } = {}) {
  const api = bridge();
  const { message } = findMessage(app, taskId, id);
  if (!api?.keep || !message || busy.has(id)) return false;
  const refocus = focusInCard(id);
  let result;
  try {
    result = await api.keep({ id, paths });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'The changes could not be kept.');
    return false;
  }
  applyChanges(app, taskId, id, result.data);
  if (refocus) focusCard(id, all ? '' : paths[0]);
  if (review.id === id && $('#changes-dialog')?.open) await showFile(review.path);
  return true;
}

// ---- Review dialog ------------------------------------------------------------------

function reviewFiles() {
  const { message } = findMessage(review.app, review.taskId, review.id);
  return normalizeChanges(message?.changes)?.files || [];
}
function renderFileList() {
  const host = $('#changes-files');
  if (!host) return;
  // Choosing a file redraws the list; keyboard focus moves along to the chosen file.
  const hadFocus = host.contains(document.activeElement);
  host.replaceChildren(...reviewFiles().map((file) => {
    const item = element('button', 'changes-dialog-file');
    item.dataset.path = file.path;
    item.dataset.status = file.status;
    const selected = file.path === review.path;
    item.classList.toggle('is-selected', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    item.disabled = Boolean(file.untracked);
    item.append(element('span', 'changes-dialog-name', file.path), counts(file));
    if (file.status !== 'changed') item.append(element('span', `changes-state is-${file.status}`, STATUS_LABELS[file.status]));
    item.addEventListener('click', () => void showFile(file.path));
    return item;
  }));
  if (hadFocus) host.querySelector('.changes-dialog-file.is-selected')?.focus();
}
function diffLine(line) {
  const row = element('div', `diff-line is-${line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'same'}`);
  row.append(
    element('span', 'diff-num', line.oldLine ? String(line.oldLine) : ''),
    element('span', 'diff-num', line.newLine ? String(line.newLine) : ''),
    element('span', 'diff-sign', line.type === ' ' ? '' : line.type === '-' ? '\u2212' : '+'),
  );
  const text = element('span', 'diff-text');
  if (line.type !== ' ') text.append(element('span', 'sr-only', line.type === '+' ? 'Added: ' : 'Removed: '));
  if (line.noNewline) text.append(element('span', 'diff-meta', 'No line break at the end of the file'));
  else text.append(document.createTextNode(line.text));
  row.append(text);
  return row;
}
function renderDiff(data) {
  const host = $('#changes-diff');
  if (!host) return;
  if (data.untracked) {
    host.replaceChildren(element('p', 'changes-empty', 'This file was not recorded, so its change cannot be shown.'));
    return;
  }
  if (data.noDiff) {
    host.replaceChildren(element('p', 'changes-empty', 'This change is too large to show here. Undo still works while the file is as the reply left it.'));
    return;
  }
  if (!data.hunks.length) {
    host.replaceChildren(element('p', 'changes-empty', data.kind === 'created' ? 'The reply created this file empty.' : 'No lines differ.'));
    return;
  }
  const nodes = [];
  for (const hunk of data.hunks) {
    const last = hunk.newLines ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;
    nodes.push(element('div', 'diff-hunk', hunk.newLines > 1 ? `Lines ${hunk.newStart}\u2013${last}` : `Line ${hunk.newStart || 1}`));
    for (const line of hunk.lines) nodes.push(diffLine(line));
  }
  if (data.truncated) nodes.push(element('p', 'changes-empty', 'The rest of this change is too long to show here.'));
  if (data.approximate) nodes.unshift(element('p', 'changes-note', 'Most of this file changed; it is shown as replaced.'));
  host.replaceChildren(...nodes);
  host.scrollTop = 0;
}
function renderReviewActions(file) {
  const undo = $('#changes-undo');
  const keep = $('#changes-keep');
  const openButton = $('#changes-open');
  const canDecide = Boolean(file && file.status === 'changed' && !file.untracked);
  if (undo) {
    undo.disabled = !canDecide || Boolean(file?.mixed) || review.current !== 'same' || busy.has(review.id);
    undo.title = !canDecide ? '' : file.mixed ? MIXED_TEXT : review.current !== 'same' ? (CURRENT_TEXT[review.current] || '') : '';
  }
  if (keep) keep.disabled = !canDecide || busy.has(review.id);
  // The editor shows the open folder only.
  const { task } = findMessage(review.app, review.taskId, review.id);
  const here = Boolean(task?.folder?.path && task.folder.path === review.app.workspace.root);
  if (openButton) {
    openButton.disabled = !here || !file || review.current === 'missing' || (file.kind === 'created' && review.current === 'original');
    openButton.title = here ? '' : 'Open the task\'s folder to edit this file.';
  }
  // A button that just turned off keeps no focus: move it to the next thing that works.
  const dialog = $('#changes-dialog');
  const active = document.activeElement;
  if (dialog?.open && active && dialog.contains(active) && active.disabled) {
    const next = [keep, undo, openButton].find((button) => button && !button.disabled)
      || dialog.querySelector('.changes-dialog-file.is-selected') || $('#changes-close');
    next?.focus();
  }
}
async function showFile(path) {
  review.path = path;
  const token = (review.token += 1);
  renderFileList();
  const file = reviewFiles().find((item) => item.path === path) || null;
  const pathNode = $('#changes-path');
  if (pathNode) pathNode.textContent = path;
  const stateNode = $('#changes-state');
  if (stateNode) stateNode.textContent = 'Loading…';
  review.current = 'unknown';
  renderReviewActions(file);
  let result;
  try {
    result = await bridge()?.diff({ id: review.id, path });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (token !== review.token) return;
  if (!result?.ok) {
    if (stateNode) stateNode.textContent = '';
    $('#changes-diff')?.replaceChildren(element('p', 'changes-empty', result?.error?.message || 'The change could not be loaded.'));
    renderReviewActions(null);
    return;
  }
  review.current = result.data.current || 'unknown';
  const status = file?.status === 'undone' ? 'Undone.' : file?.status === 'kept' ? 'Kept.'
    : file?.mixed ? MIXED_TEXT : CURRENT_TEXT[review.current] ?? '';
  if (stateNode) stateNode.textContent = status;
  renderDiff(result.data);
  renderReviewActions(file);
}

/** Opens the review of one file of a reply's changes. */
export async function openReview(app, taskId, id, path, opener = null) {
  const dialog = $('#changes-dialog');
  if (!dialog || !bridge()?.diff) return;
  Object.assign(review, { app, taskId, id, path, opener });
  const { task } = findMessage(app, taskId, id);
  const subtitle = $('#changes-subtitle');
  if (subtitle) subtitle.textContent = task?.folder?.name ? `In ${task.folder.name}` : '';
  const pending = showFile(path);
  if (!dialog.open) dialog.showModal();
  await pending;
  dialog.querySelector('.changes-dialog-file.is-selected')?.focus();
}

export function bindChangesUi(app) {
  review.app = app;
  const dialog = $('#changes-dialog');
  if (!dialog) return;
  $('#changes-close')?.addEventListener('click', () => dialog.close());
  $('#changes-undo')?.addEventListener('click', () => void undoFiles(app, review.taskId, review.id, [review.path]));
  $('#changes-keep')?.addEventListener('click', () => void keepFiles(app, review.taskId, review.id, [review.path]));
  $('#changes-open')?.addEventListener('click', async () => {
    const target = review.path;
    dialog.close();
    app.switchView('workspace');
    await app.openFile(target);
  });
  dialog.addEventListener('close', () => {
    review.token += 1;
    const opener = review.opener;
    review.opener = null;
    // Back to the control that opened the review; after an undo or keep the card was drawn
    // again, so that is the same file's button in the new card.
    if (opener?.isConnected) opener.focus();
    else focusCard(review.id, review.path);
  });
}
