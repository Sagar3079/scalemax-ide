/**
 * Sessions the way coding agents keep them: rewind a conversation to just before one of the
 * user's messages, fork it into a new task from there, find a task again by its title or words,
 * write it out as Markdown, and the worktree a task works in. Pure functions (no DOM, no bridge),
 * tested in test/sessions.test.mjs; the window's half is src/sessions-ui.js and src/gitflow-ui.js.
 */
import {
  isRecord, normalizeChanges, normalizeCompaction, normalizeTaskFolder, stepSummary, changesSummary, metricsLabel,
  normalizeMessageImages,
} from './domain.mjs';

const MAX_TITLE = 60;
const MAX_SNIPPET = 140;
const MAX_RESULTS = 50;

/** The user message at `index` (a task can be rewound or forked only at one of those), or null. */
function userMessageAt(task, index) {
  const messages = Array.isArray(task?.messages) ? task.messages : [];
  if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) return null;
  const message = messages[index];
  return isRecord(message) && message.role === 'user' && typeof message.text === 'string' ? message : null;
}

// The summary of older turns stays only while every turn it covers stays (and some turn after it,
// as src/app.js loadState requires); otherwise it would speak for messages that are gone.
function keptCompaction(task, length) {
  const compaction = normalizeCompaction(task?.compaction);
  return compaction && compaction.through < length ? compaction : null;
}

/**
 * What rewinding `task` to just before its user message `index` takes away:
 *   text     the message, for the message box
 *   keep     how many messages stay (those before it)
 *   removed  how many go
 *   replies  the later replies whose file changes can still be undone, oldest first:
 *            { id, files: paths still as the reply left them, kept: paths the user kept }
 *   files    how many files those are
 *   compaction 'kept' | 'dropped' | null (no summary)
 * Null when `index` is not a user message.
 */
export function rewindPlan(task, index) {
  const message = userMessageAt(task, index);
  if (!message) return null;
  const later = task.messages.slice(index);
  const replies = [];
  for (const item of later) {
    if (!isRecord(item) || item.role !== 'assistant') continue;
    const changes = normalizeChanges(item.changes);
    if (!changes) continue;
    const files = changes.files.filter((file) => file.status === 'changed').map((file) => file.path);
    const kept = changes.files.filter((file) => file.status === 'kept').map((file) => file.path);
    if (files.length || kept.length) replies.push({ id: changes.id, files, kept });
  }
  const summary = normalizeCompaction(task.compaction);
  return {
    text: message.text,
    images: normalizeMessageImages(message.images),
    keep: index,
    removed: later.length,
    replies,
    files: new Set(replies.flatMap((reply) => reply.files)).size,
    compaction: summary ? (keptCompaction(task, index) ? 'kept' : 'dropped') : null,
  };
}

/** The undo order for a rewind: newest reply first, so a file two replies changed goes back step by step. */
export function undoOrder(plan) {
  return Array.isArray(plan?.replies) ? [...plan.replies].reverse() : [];
}

/**
 * The fields of `task` after a rewind to just before its user message `index`: its messages
 * before that one, and the summary of older turns only while it still fits them. Null when
 * `index` is not a user message.
 */
export function rewoundTask(task, index, now = Date.now()) {
  if (!userMessageAt(task, index)) return null;
  const compaction = keptCompaction(task, index);
  return { messages: task.messages.slice(0, index), compaction, updatedAt: now };
}

/**
 * What a rewind's undo did, from one outcome per reply ({ id, ok, results, error, kept }):
 * { restored: paths put back, notRestored: [{ path, message }] }. A file the user had kept, or one
 * changed since (lib/checkpoints.cjs never overwrites that), is left as it is and listed.
 */
export function rewindReport(outcomes) {
  const restored = [];
  const notRestored = [];
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!isRecord(outcome)) continue;
    if (!outcome.ok) {
      notRestored.push({ path: '', message: typeof outcome.error === 'string' && outcome.error ? outcome.error : 'The changes of a reply could not be undone.' });
      continue;
    }
    for (const result of Array.isArray(outcome.results) ? outcome.results : []) {
      if (!isRecord(result) || typeof result.path !== 'string') continue;
      if (result.ok) restored.push(result.path);
      else notRestored.push({ path: result.path, message: typeof result.message === 'string' ? result.message : 'It was left as it is.' });
    }
    for (const path of Array.isArray(outcome.kept) ? outcome.kept : []) {
      notRestored.push({ path, message: `${path} was kept after that reply, so it was left as it is.` });
    }
  }
  // A file a later reply put back and an earlier one could not is not "restored".
  const failed = new Set(notRestored.map((item) => item.path));
  return { restored: [...new Set(restored)].filter((path) => !failed.has(path)), notRestored };
}

/**
 * A new task with `task`'s conversation before its user message `index`, in the same folder (and
 * worktree), for trying that message another way. The copy is deep: nothing is shared with the
 * original. Its replies keep their changes (the same records, so either task can review them;
 * see sharedChangeIds). Null when `index` is not a user message.
 * @param {{ id: string, now?: number }} options the new task's id (src/app.js makeTask)
 */
export function forkedTask(task, index, { id, now = Date.now() } = {}) {
  if (!userMessageAt(task, index) || typeof id !== 'string' || !id) return null;
  const messages = JSON.parse(JSON.stringify(task.messages.slice(0, index)));
  const title = typeof task.title === 'string' && task.title.trim() ? task.title.trim() : 'Task';
  const fork = {
    id,
    title: `${title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title} (fork)`,
    messages,
    createdAt: now,
    updatedAt: now,
  };
  const folder = normalizeTaskFolder(task.folder);
  if (folder) fork.folder = folder;
  const worktree = normalizeWorktree(task.worktree);
  if (worktree) fork.worktree = worktree;
  const compaction = keptCompaction(task, index);
  if (compaction) fork.compaction = JSON.parse(JSON.stringify(compaction));
  return fork;
}

function changeIds(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => (isRecord(message) ? normalizeChanges(message.changes)?.id : null))
    .filter((id) => typeof id === 'string');
}
/** The change ids that tasks other than `task` still show (a fork shares its replies' changes). */
export function sharedChangeIds(tasks, task) {
  return new Set((Array.isArray(tasks) ? tasks : []).filter((item) => item !== task && isRecord(item)).flatMap((item) => changeIds(item.messages)));
}
/** The change ids of `messages` no other task uses: they can be forgotten with those messages. */
export function unsharedChangeIds(tasks, task, messages) {
  const shared = sharedChangeIds(tasks, task);
  return [...new Set(changeIds(messages))].filter((id) => !shared.has(id));
}

function snippetAround(text, needle) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!needle) return flat.slice(0, MAX_SNIPPET);
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, MAX_SNIPPET);
  const start = Math.max(0, at - 40);
  const piece = flat.slice(start, start + MAX_SNIPPET);
  return `${start ? '…' : ''}${piece}${start + MAX_SNIPPET < flat.length ? '…' : ''}`;
}

/**
 * The Recent sessions list: tasks with messages, newest first. With a query, only those whose
 * title or messages contain it (any case), each with a snippet around the first match.
 * @returns {Array<{ id: string, title: string, folderName: string, folderPath: string, updatedAt: number, messages: number, snippet: string, matched: 'title'|'message'|null }>}
 */
export function sessionResults(tasks, query = '', { limit = MAX_RESULTS } = {}) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const results = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isRecord(task) || typeof task.id !== 'string' || typeof task.title !== 'string') continue;
    const messages = Array.isArray(task.messages) ? task.messages.filter((message) => isRecord(message) && typeof message.text === 'string') : [];
    if (!messages.length) continue;
    let matched = null;
    let snippet = '';
    if (needle) {
      if (task.title.toLowerCase().includes(needle)) matched = 'title';
      const hit = messages.find((message) => message.text.toLowerCase().includes(needle));
      if (hit) {
        snippet = snippetAround(hit.text, needle);
        matched = matched || 'message';
      }
      if (!matched) continue;
    }
    if (!snippet) {
      const last = [...messages].reverse().find((message) => message.text.trim());
      snippet = last ? snippetAround(last.text, '') : '';
    }
    const folder = normalizeTaskFolder(task.folder);
    results.push({
      id: task.id,
      title: task.title,
      folderName: folder?.name || '',
      folderPath: folder?.path || '',
      updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : 0,
      messages: messages.length,
      snippet,
      matched,
    });
  }
  results.sort((left, right) => right.updatedAt - left.updatedAt);
  return results.slice(0, Math.max(1, limit));
}

function stamp(time) {
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * The task as Markdown: its title, folder and when, then every message under a heading saying
 * who wrote it and when; a reply also says what it did (steps), what it changed and what it
 * cost, and why it ended early. Replies are Markdown already; the user's text is kept as written.
 */
export function transcriptMarkdown(task, { now = Date.now() } = {}) {
  const title = typeof task?.title === 'string' && task.title.trim() ? task.title.trim() : 'Task';
  const folder = normalizeTaskFolder(task?.folder);
  const worktree = normalizeWorktree(task?.worktree);
  const messages = Array.isArray(task?.messages) ? task.messages.filter((message) => isRecord(message) && typeof message.text === 'string') : [];
  const lines = [`# ${title.replace(/\s+/g, ' ')}`, ''];
  if (folder) lines.push(`- Folder: ${folder.path}`);
  if (worktree) lines.push(`- Worktree branch: ${worktree.branch}${worktree.base ? ` (from ${worktree.base})` : ''}`);
  lines.push(`- Messages: ${messages.length}`, `- Exported: ${stamp(now)}`, '');
  const compaction = normalizeCompaction(task?.compaction);
  if (compaction) lines.push(`> The ${compaction.through} oldest messages were summarized for the model; all of them are below.`, '');
  for (const message of messages) {
    const who = message.role === 'user' ? 'You' : 'ScaleMax';
    lines.push(`## ${who}${Number.isFinite(message.time) ? ` · ${stamp(message.time)}` : ''}`, '');
    if (message.role === 'assistant' && Array.isArray(message.steps) && message.steps.length) lines.push(`*${stepSummary(message.steps)}*`, '');
    if (message.text.trim()) lines.push(message.text.trim(), '');
    const pictures = message.role === 'user' ? normalizeMessageImages(message.images).length : 0;
    if (pictures) lines.push(`*${pictures === 1 ? 'A picture was' : `${pictures} pictures were`} attached.*`, '');
    if (message.role === 'assistant') {
      const notes = [changesSummary(message.changes), typeof message.notice === 'string' ? message.notice : '', metricsLabel(message.metrics)].filter(Boolean);
      for (const note of notes) lines.push(`*${note}*`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** A branch name for a task title (lib/git-flow.cjs slugify makes the same one in main). */
export function slugify(text) {
  const plain = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (plain.length <= 40) return plain || 'task';
  const cut = plain.slice(0, 40);
  const dash = cut.lastIndexOf('-');
  return (dash >= 20 ? cut.slice(0, dash) : cut).replace(/-+$/, '') || 'task';
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;
/**
 * The separate worktree a task works in (src/gitflow-ui.js), as kept with the task:
 * { path, branch, base, mainRoot, mainName, createdAt, removed? }, or null when unusable.
 */
export function normalizeWorktree(value) {
  if (!isRecord(value)) return null;
  const { path, branch, base, mainRoot, mainName } = value;
  if (typeof path !== 'string' || path.length > 4096 || !ABSOLUTE.test(path)) return null;
  if (typeof mainRoot !== 'string' || mainRoot.length > 4096 || !ABSOLUTE.test(mainRoot)) return null;
  if (typeof branch !== 'string' || !BRANCH.test(branch)) return null;
  const worktree = {
    path,
    branch,
    base: typeof base === 'string' && BRANCH.test(base) ? base : null,
    mainRoot,
    mainName: typeof mainName === 'string' && mainName.trim() ? mainName.slice(0, 256) : mainRoot.split(/[\\/]/).filter(Boolean).pop() || mainRoot,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
  };
  if (value.removed === true) worktree.removed = true;
  return worktree;
}
