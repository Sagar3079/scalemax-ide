/**
 * What a reply changed in its folder, shown under the reply the way coding agents let you review
 * their work: "2 files changed · +12 −4", each file with Undo and Keep, and Undo all / Keep all.
 * A file's name opens its change as a diff in #changes-dialog. Undo puts a file back only while
 * it is exactly as the reply left it (main checks, lib/checkpoints.cjs), so later work is never
 * overwritten; the model hears about undone files with the next message (historyMessages in
 * src/domain.mjs). DOM is built with createElement and textContent only (no HTML).
 */
import { normalizeChanges, changesSummary } from './domain.mjs';
import { reloadTabs, reviewReplyChanges, settleReviews } from './workspace-ui.js';
import { openCommitDialog } from './gitflow-ui.js';

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
// Part of a file's change undone in the editor's review (lib/checkpoints.cjs editorUndo): the
// counts are what is left, which can still be undone or kept here.
function partlyText(file) {
  const { changes, lines } = file.partly;
  const at = lines.length ? ` (at ${lines.length === 1 ? 'line' : 'lines'} ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''})` : '';
  return `${changes} ${changes === 1 ? 'change' : 'changes'} undone in the editor${at}.`;
}
// The review dialog: which reply and file it shows, and the control that opened it.
const review = { app: null, taskId: '', id: '', path: '', opener: null, token: 0, current: 'unknown', toEditor: false };
// Replies with an undo or keep on the way (their buttons wait).
const busy = new Set();

function findMessage(app, taskId, id) {
  const task = app?.tasks.find((item) => item.id === taskId) || null;
  const message = task?.messages.find((item) => item.changes?.id === id) || null;
  return { task, message };
}
// The task and reply whose changes are `id`, in any task (the editor knows only the id).
function findReply(app, id) {
  for (const task of app?.tasks || []) {
    const message = task.messages?.find((item) => item.changes?.id === id);
    if (message) return { task, message };
  }
  return { task: null, message: null };
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
  // Commit what the reply changed (src/gitflow-ui.js): the dialog ticks this reply's files.
  if (window.scalemaxAPI?.git?.commit) {
    const commitButton = actionButton('Commit\u2026', 'changes-action', 'Commit the files this reply changed', (event) => {
      const { task } = findMessage(app, taskId, id);
      void openCommitDialog(app, { folder: task?.folder?.path || '', taskId, paths: changes.files.map((file) => file.path), opener: event.currentTarget });
    });
    commitButton.dataset.action = 'commit';
    const actions = head.querySelector('.changes-actions') || head.appendChild(element('div', 'changes-actions'));
    actions.append(commitButton);
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
      const label = element('span', `changes-state is-${file.status}`, file.partly && file.status === 'kept' ? 'Kept, partly undone' : STATUS_LABELS[file.status]);
      if (file.partly) label.title = partlyText(file);
      row.append(label);
    } else {
      if (file.partly) {
        const state = element('span', 'changes-state is-partly', 'Partly undone in the editor');
        state.title = `${partlyText(file)} The counts are what is left.`;
        row.append(state);
      }
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
  // The editor stops marking files of this reply that were kept or undone here.
  settleReviews(app, id, changes);
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

// ---- The editor's inline review (src/workspace-ui.js) ---------------------------------------
// The editor's review of a file goes through the same record as the card: Keep all and Undo all
// there are this file's Keep and Undo, and Undo on one change (which the editor saves itself) is
// taken in as "partly undone", so the card, the review dialog and the note to the model agree.

/** Records part of a file's change that the editor's review undid and saved (editorUndo). */
export async function recordEditorUndo(app, { id, path, from, revision, changes = 1, lines = [] } = {}) {
  const api = bridge();
  const { task } = findReply(app, id);
  if (!api?.undo || !task) return false;
  let result;
  try {
    result = await api.undo({ id, part: { path, from, revision, changes, lines } });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (!result?.ok) {
    // The file is saved all the same; the card says it changed since the reply.
    app.showToast(result?.error?.message || 'That undo could not be added to the reply\'s changes.');
    return false;
  }
  applyChanges(app, task.id, id, result.data.changes);
  if (review.id === id && $('#changes-dialog')?.open) await showFile(review.path);
  return true;
}

// The file as the reply's record has it, with what the editor needs to say about it.
function replyFile(app, id, path) {
  const { task, message } = findReply(app, id);
  const file = normalizeChanges(message?.changes)?.files.find((item) => item.path === path) || null;
  return { task, file };
}

/** Keep all in the editor's review (or every change kept there): the card's Keep for the file. */
export async function keepEditorReview(app, id, path, { quiet = false } = {}) {
  const { task, file } = replyFile(app, id, path);
  // Nothing left to keep in the record (kept or undone already, or the reply is gone).
  if (!task || !file || file.status !== 'changed') return true;
  const kept = await keepFiles(app, task.id, id, [path]);
  if (kept && !quiet) app.showToast(`Kept the changes to ${path}`);
  return kept;
}

/** Undo all in the editor's review: the card's Undo for the file. */
export async function undoEditorReview(app, id, path, { unsaved = false } = {}) {
  const { task, file } = replyFile(app, id, path);
  if (!task) { app.showToast('That reply is no longer in a task.'); return false; }
  if (!file || file.status !== 'changed') { app.showToast(`The changes to ${path} were already ${file?.status || 'decided'}.`); return false; }
  if (file.untracked) { app.showToast(`${path} was not recorded, so it cannot be undone here.`); return false; }
  if (file.mixed) { app.showToast(`${path} was also changed by someone else while the reply ran, so it cannot be undone as a whole. Undo its changes one at a time.`); return false; }
  if (unsaved) {
    app.showToast(`Undo all puts ${path} back as it was before the reply, so your unsaved edits are in the way. Undo them, or undo the reply's changes one at a time.`);
    return false;
  }
  return undoFiles(app, task.id, id, [path]);
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
    else if (file.partly) item.append(element('span', 'changes-state is-partly', 'Partly undone'));
    item.addEventListener('click', () => void showFile(file.path));
    return item;
  }));
  if (hadFocus) host.querySelector('.changes-dialog-file.is-selected')?.focus();
}
// ---- The diff in the review dialog: word-level marks and syntax colours ---------------------
// Like the editor's inline review: the words that changed inside a changed line are marked, and
// the code is coloured by its language (src/editor.js highlightLines, the editor's own parser
// and tags). Both are bounded, so a very large change still opens quickly.

const WORD = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
// Word marks: a table of at most this many cells per line pair, and this many for the whole diff
// (past it, only the changed middle of a line is marked).
const WORD_CELLS = 160_000;
const WORD_BUDGET = 4_000_000;
// Lines sharing less than this share of their (non-space) characters are simply replaced.
const WORD_SHARED = 0.3;
// Syntax colours only for diffs up to this many characters.
export const SYNTAX_LIMIT = 200_000;

function addRange(list, from, to) {
  const last = list[list.length - 1];
  if (last && last[1] === from) last[1] = to;
  else if (to > from) list.push([from, to]);
}
// Ranges with only spaces between them read as one change.
function joinRanges(list, text) {
  const joined = [];
  for (const range of list) {
    const last = joined[joined.length - 1];
    if (last && !text.slice(last[1], range[0]).trim()) last[1] = range[1];
    else joined.push([...range]);
  }
  return joined;
}
const visible = (text) => text.replace(/\s+/g, '').length;

/**
 * Which parts of a removed line and the added line that took its place differ, word by word:
 * { removed: [[from, to]], added: [[from, to]], cells } (character offsets; cells is the work
 * it took). Null when the lines share too little for marks to help. `budget` caps the work: past
 * it only the changed middle (between the common start and end) is marked.
 */
export function wordDiff(before, after, { budget = WORD_CELLS } = {}) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  const wordsA = a.match(WORD) || [];
  const wordsB = b.match(WORD) || [];
  const n = wordsA.length;
  const m = wordsB.length;
  const cells = (n + 1) * (m + 1);
  const removed = [];
  const added = [];
  let shared = 0;
  let work = a.length + b.length;
  if (cells <= Math.min(WORD_CELLS, budget)) {
    work = cells;
    // Longest common subsequence of the words, then a walk that marks the rest.
    const width = m + 1;
    const table = new Uint32Array(cells);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = wordsA[i] === wordsB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let atA = 0;
    let atB = 0;
    while (i < n || j < m) {
      if (i < n && j < m && wordsA[i] === wordsB[j]) {
        shared += visible(wordsA[i]);
        atA += wordsA[i].length;
        atB += wordsB[j].length;
        i += 1;
        j += 1;
      } else if (j < m && (i >= n || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
        addRange(added, atB, atB + wordsB[j].length);
        atB += wordsB[j].length;
        j += 1;
      } else {
        addRange(removed, atA, atA + wordsA[i].length);
        atA += wordsA[i].length;
        i += 1;
      }
    }
  } else {
    const shortest = Math.min(a.length, b.length);
    let start = 0;
    while (start < shortest && a[start] === b[start]) start += 1;
    let end = 0;
    while (end < shortest - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
    shared = visible(a.slice(0, start)) + visible(a.slice(a.length - end));
    addRange(removed, start, a.length - end);
    addRange(added, start, b.length - end);
  }
  const size = Math.max(visible(a), visible(b));
  if (!size || shared / size < WORD_SHARED) return null;
  return { removed: joinRanges(removed, a), added: joinRanges(added, b), cells: work };
}

// Pieces of a line: syntax ranges and changed ranges (each sorted, not overlapping) merged into
// [{ text, token, changed }].
function segments(text, syntax = [], changes = []) {
  const cuts = new Set([0, text.length]);
  for (const [from, to] of syntax) { cuts.add(Math.min(from, text.length)); cuts.add(Math.min(to, text.length)); }
  for (const [from, to] of changes) { cuts.add(from); cuts.add(to); }
  const points = [...cuts].sort((x, y) => x - y);
  const pieces = [];
  let s = 0;
  let c = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (to <= from) continue;
    while (s < syntax.length && syntax[s][1] <= from) s += 1;
    while (c < changes.length && changes[c][1] <= from) c += 1;
    const token = s < syntax.length && syntax[s][0] <= from ? syntax[s][2] : '';
    const changed = c < changes.length && changes[c][0] <= from;
    const last = pieces[pieces.length - 1];
    if (last && last.token === token && last.changed === changed) last.text += text.slice(from, to);
    else pieces.push({ text: text.slice(from, to), token, changed });
  }
  return pieces;
}

/**
 * The review dialog's diff as plain data: hunk headings and lines, each line with its numbers
 * and its text in pieces ({ text, token: 'tok-keyword' or '', changed }). `highlight` is
 * src/editor.js highlightLines (null: no syntax colours), `path` picks the language.
 */
export function diffView(data, { highlight = null, path = '' } = {}) {
  const hunks = Array.isArray(data?.hunks) ? data.hunks : [];
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((size, line) => size + (line.text?.length || 0) + 1, 0), 0);
  const colour = typeof highlight === 'function' && total <= SYNTAX_LIMIT;
  let budget = WORD_BUDGET;
  const items = [];
  for (const hunk of hunks) {
    const lines = hunk.lines;
    const last = hunk.newLines ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;
    items.push({ kind: 'hunk', text: hunk.newLines > 1 ? `Lines ${hunk.newStart}–${last}` : `Line ${hunk.newStart || 1}` });
    const syntax = lines.map(() => []);
    const changes = lines.map(() => []);
    if (colour) {
      // Each side of the hunk is coloured as the text it was: context and removed lines as the
      // file before, context and added lines as the file after.
      for (const side of ['-', '+']) {
        const rows = lines.map((line, index) => (!line.noNewline && (line.type === ' ' || line.type === side) ? index : -1)).filter((index) => index >= 0);
        if (!rows.length) continue;
        const colours = highlight(rows.map((index) => lines[index].text).join('\n'), path);
        rows.forEach((index, row) => { if (side === '+' || lines[index].type === '-') syntax[index] = colours[row] || []; });
      }
    }
    if (!data.approximate) {
      // In each run of changed lines, the n-th removed line is compared with the n-th added one.
      for (let start = 0; start < lines.length;) {
        if (lines[start].type === ' ') { start += 1; continue; }
        let end = start;
        while (end < lines.length && lines[end].type !== ' ') end += 1;
        const gone = [];
        const come = [];
        for (let index = start; index < end; index += 1) {
          if (lines[index].noNewline) continue;
          (lines[index].type === '-' ? gone : come).push(index);
        }
        for (let pair = 0; pair < Math.min(gone.length, come.length); pair += 1) {
          const words = wordDiff(lines[gone[pair]].text, lines[come[pair]].text, { budget });
          if (!words) continue;
          budget -= words.cells;
          changes[gone[pair]] = words.removed;
          changes[come[pair]] = words.added;
        }
        start = end;
      }
    }
    lines.forEach((line, index) => {
      items.push({
        kind: 'line',
        type: line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'same',
        oldLine: line.oldLine || 0,
        newLine: line.newLine || 0,
        noNewline: Boolean(line.noNewline),
        pieces: line.noNewline ? [] : segments(line.text, syntax[index], changes[index]),
      });
    });
  }
  return items;
}

function diffLine(item) {
  const row = element('div', `diff-line is-${item.type}`);
  row.append(
    element('span', 'diff-num', item.oldLine ? String(item.oldLine) : ''),
    element('span', 'diff-num', item.newLine ? String(item.newLine) : ''),
    element('span', 'diff-sign', item.type === 'same' ? '' : item.type === 'del' ? '−' : '+'),
  );
  const text = element('span', 'diff-text');
  if (item.type !== 'same') text.append(element('span', 'sr-only', item.type === 'add' ? 'Added: ' : 'Removed: '));
  if (item.noNewline) text.append(element('span', 'diff-meta', 'No line break at the end of the file'));
  for (const piece of item.pieces) {
    const className = [piece.token, piece.changed ? 'diff-word' : ''].filter(Boolean).join(' ');
    text.append(className ? element('span', className, piece.text) : document.createTextNode(piece.text));
  }
  row.append(text);
  return row;
}

// src/editor.js's highlighter, loaded once (null when CodeMirror cannot load: plain text then).
let highlighter = null;
function loadHighlighter() {
  highlighter ||= import('./editor.js').then((module) => module.highlightLines).catch(() => null);
  return highlighter;
}

function renderDiff(data, highlight = null) {
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
  const nodes = diffView(data, { highlight, path: review.path }).map((item) => (item.kind === 'hunk' ? element('div', 'diff-hunk', item.text) : diffLine(item)));
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
  let highlight = null;
  try {
    [result, highlight] = await Promise.all([bridge()?.diff({ id: review.id, path }), loadHighlighter()]);
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
  const partly = file?.partly ? ` ${partlyText(file)}` : '';
  const status = file?.status === 'undone' ? 'Undone.' : file?.status === 'kept' ? `Kept.${partly}`
    : file?.mixed ? MIXED_TEXT
      : file?.partly && review.current === 'same' ? `${partlyText(file)} What is left is shown here and can still be undone.`
        : CURRENT_TEXT[review.current] ?? '';
  if (stateNode) stateNode.textContent = status;
  renderDiff(result.data, highlight);
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
    const { message } = findMessage(app, review.taskId, review.id);
    // Keyboard focus goes to the file in the editor, not back to what opened the review.
    review.toEditor = true;
    dialog.close();
    app.switchView('workspace');
    // The editor marks this reply's changes in the file, with Keep and Undo on each.
    if (await app.openFile(target)) await reviewReplyChanges(app, normalizeChanges(message?.changes), [target]);
  });
  dialog.addEventListener('close', () => {
    review.token += 1;
    const opener = review.opener;
    review.opener = null;
    if (review.toEditor) {
      review.toEditor = false;
      return;
    }
    // Back to the control that opened the review; after an undo or keep the card was drawn
    // again, so that is the same file's button in the new card.
    if (opener?.isConnected) opener.focus();
    else focusCard(review.id, review.path);
  });
}
