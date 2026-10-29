/**
 * Git the way coding agents hand work back (Codex, Claude Code):
 *   - the commit dialog (#commit-dialog), from a reply's changes card, the Workspace Git panel and a
 *     worktree task's header: the changed files with checkboxes (a reply's own files ticked), a
 *     message the current provider writes from the diff (editable; without a provider it describes
 *     the files), commit to the branch or to a new one first, then Push and Create pull request
 *     (GitHub CLI) with a link to it;
 *   - the Git panel's Pull (fast-forward only) and Switch branch (#branch-dialog, stashing on
 *     request); the Workspace header shows the branch and how far it is ahead of / behind its
 *     upstream;
 *   - worktrees: an empty task in a repository offers "Separate worktree"; its first message then
 *     makes <userData>/worktrees/<repo>-<task> on a branch scalemax/<slug> and the task works
 *     there. The task's header shows the branch with Show in Finder, Commit…, Merge into <base>,
 *     Create PR and Remove worktree.
 * Main runs Git (lib/git-flow.cjs, window.scalemaxAPI.git / .worktrees) with the user's identity,
 * settings and hooks; the model never reaches any of it. DOM is built with createElement and
 * textContent only (no HTML).
 */
import { slugify, normalizeWorktree, friendlyFolderName, fullTaskTitle, worktreeName } from './sessions.mjs';
import { reloadTabs } from './workspace-ui.js';
import { askConfirm } from './confirm-dialog.js';

const $ = (selector) => document.querySelector(selector);
const UNSAVED = 'Save or close your unsaved files first.';
const INFO_MAX_AGE_MS = 15_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
// The branch icon of the composer chip, for rows built here.
function branchIcon(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of [['path', { d: 'M6 3v12' }], ['circle', { cx: '18', cy: '6', r: '3' }], ['circle', { cx: '6', cy: '18', r: '3' }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]]) {
    const node = document.createElementNS(SVG_NS, shape[0]);
    for (const [name, value] of Object.entries(shape[1])) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}
const gitApi = () => window.scalemaxAPI?.git || null;
const worktreeApi = () => window.scalemaxAPI?.worktrees || null;
// A bridge call that always resolves to an envelope.
async function call(method, input) {
  try {
    return (await method(input)) || { ok: false, error: { message: 'No answer came back.' } };
  } catch (error) {
    return { ok: false, error: { message: error?.message || 'Something went wrong.' } };
  }
}
const errorText = (result, fallback) => result?.error?.message || fallback;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "just now", "3 min ago", "2 h ago": how long ago `at` was. */
export function agoText(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : 'over a day ago';
}

/** What a pull did, in words: "Pulled 2 commits from origin/main" or "Already up to date with origin/main". */
export function pullMessage(data) {
  const from = data?.upstream || 'the remote';
  if (Number.isInteger(data?.pulled) && data.pulled > 0) return `Pulled ${plural(data.pulled, 'commit')} from ${from}`;
  if (data?.pulled === 0 || data?.upToDate) return `Already up to date with ${from}`;
  return `Pulled from ${from}`;
}

/** `base`, or base-2, base-3 … : the first name that is not among `taken` (a Set of branch names). */
export function uniqueBranchName(base, taken) {
  const names = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
  if (!names.has(base)) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base}-${number}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ---- After Git changed a folder ------------------------------------------------------------

// Worktree states per task ({ at, data, error }) and the tasks whose state is being read.
const infos = new Map();
const reading = new Set();

/** The open folder (if it is `folder`) shows what Git changed: tree, Git panel, open tabs. */
async function afterGitChange(app, folder, { files = false } = {}) {
  for (const task of app.tasks) if (task.folder?.path === folder || normalizeWorktree(task.worktree)?.mainRoot === folder) infos.delete(task.id);
  if (folder !== app.workspace.root) {
    renderWorktreeBar(app);
    return;
  }
  if (files) {
    await app.refreshWorkspace?.();
    const tabs = (app.workspace.tabs || []).map((tab) => tab.path);
    if (tabs.length) await reloadTabs(app, tabs);
  } else {
    await app.refreshGit?.({ quiet: true });
  }
  renderWorktreeBar(app);
}
// Unsaved editor tabs among `paths` of the open folder `folder`.
function unsavedAmong(app, folder, paths) {
  if (folder !== app.workspace.root) return [];
  const wanted = new Set(paths.map((item) => item.replace(/\/$/, '')));
  return (app.workspace.tabs || []).filter((tab) => tab.dirty && [...wanted].some((item) => tab.path === item || tab.path.startsWith(`${item}/`))).map((tab) => tab.path);
}

// ---- Workspace header: branch, ahead / behind ------------------------------------------------

// What Git says about the open folder ({ root, data }; data null: not a repository).
const header = { root: '', data: null, token: 0 };

/** Reads the open folder's branch again (src/app.js refreshGit calls this). */
export async function refreshGitHeader(app) {
  const root = app.workspace.root;
  const token = (header.token += 1);
  const api = gitApi();
  let data = null;
  if (root && api?.status) {
    const result = await call(api.status, { folder: root });
    data = result.ok && result.data?.isRepo ? result.data : null;
  }
  if (token !== header.token) return;
  header.root = root;
  header.data = data;
  // Git looked at the open folder again (a reply changed files, a save, Refresh Git): the bar of
  // a task working in it reads its state again ("1 change not committed", commits to merge).
  for (const task of app.tasks) if (root && task.folder?.path === root && normalizeWorktree(task.worktree)) infos.delete(task.id);
  renderHeader(app);
  renderWorktreeChip(app);
  renderWorktreeBar(app);
}

function renderHeader(app) {
  const data = header.root === app.workspace.root ? header.data : null;
  const node = $('#workspace-branch');
  if (node) {
    node.hidden = !data;
    if (data) {
      const name = data.branch || (data.detached ? 'detached HEAD' : 'HEAD');
      const parts = [branchIcon('ws-branch-icon'), element('span', 'ws-branch-name', name)];
      if (data.upstream) {
        if (data.ahead) parts.push(element('span', 'ws-branch-count', `↑${data.ahead}`));
        if (data.behind) parts.push(element('span', 'ws-branch-count', `↓${data.behind}`));
      } else if (!data.detached && !data.unborn) {
        parts.push(element('span', 'ws-branch-count is-local', 'not pushed'));
      }
      node.replaceChildren(...parts);
      node.title = data.upstream
        ? `${name}: ${plural(data.ahead, 'commit')} to push, ${plural(data.behind, 'commit')} to pull (${data.upstream})`
        : `${name}: no upstream yet`;
      if (data.worktree?.linked) node.title += ' · a separate worktree';
      if (data.upstream && fetchView.root === header.root && fetchView.at) node.title += ` · fetched ${agoText(fetchView.at)}`;
    }
  }
  const pull = $('#git-pull');
  if (pull) {
    pull.disabled = !data?.upstream || Boolean(data?.detached);
    pull.title = !data ? 'Open a Git repository first'
      : !data.upstream ? 'This branch has no upstream yet: push it first'
        : data.behind ? `Bring in ${plural(data.behind, 'commit')} from ${data.upstream} (fast-forward only)`
          : `Bring in what ${data.upstream} has (fast-forward only). Refresh Git fetches to see what is new.`;
  }
  for (const id of ['#git-commit', '#git-switch']) {
    const button = $(id);
    if (button) button.disabled = !data;
  }
  // Changes "Switch branch" stashed: they can be brought back here.
  const restore = $('#git-stash-restore');
  if (restore) {
    const stash = Array.isArray(data?.stashes) ? data.stashes[0] : null;
    restore.hidden = !stash;
    if (stash) {
      const more = data.stashes.length > 1 ? ` (${data.stashes.length - 1} older ${data.stashes.length === 2 ? 'stash' : 'stashes'} too)` : '';
      restore.title = `Brings back the changes stashed${stash.from ? ` on ${stash.from}` : ''} before switching to ${stash.to}${stash.at ? `, ${agoText(stash.at)}` : ''}, onto ${data.branch || 'this checkout'}${more}`;
    }
  }
  renderFetchState(app);
}

// ---- Quiet fetch (Refresh Git) -----------------------------------------------------------------

// The open folder's last fetch: when, or why it failed (error: Git's words, code: lib/git-flow.cjs),
// or that one is running now.
const fetchView = { root: '', at: 0, error: '', code: '', running: false, none: false };

// A failed fetch in a few words; Git's own message is the tooltip.
const FETCH_ERRORS = {
  FETCH_OFFLINE: 'the remote did not answer',
  FETCH_AUTH: 'the remote wants you to sign in',
  GIT_TIMEOUT: 'no answer within 20 seconds',
};

/** The Git panel's line about fetching ("Fetched 3 min ago"), or '' when there is nothing to say. */
export function fetchStateText(view, now = Date.now()) {
  if (!view) return '';
  if (view.running) return 'Fetching…';
  if (view.error) return FETCH_ERRORS[view.code] ? `Could not fetch: ${FETCH_ERRORS[view.code]}` : 'Could not fetch';
  if (view.none) return 'No remote to fetch from';
  if (view.at) return `Fetched ${agoText(view.at, now)}`;
  return '';
}

function renderFetchState(app) {
  const node = $('#git-fetch-state');
  if (!node) return;
  const view = fetchView.root && fetchView.root === app.workspace.root ? fetchView : null;
  node.textContent = fetchStateText(view);
  node.classList.toggle('is-error', Boolean(view?.error && !view.running));
  node.title = view?.error ? view.error : view?.at ? `Last fetched at ${new Date(view.at).toLocaleTimeString()}` : '';
}

/**
 * Refresh Git: a quiet `git fetch` (main: no prompts, 20 s at most, the user's stored
 * credentials) in the background, then the header's ↑ / ↓ again. Nothing waits for it.
 */
async function fetchQuietly(app) {
  const api = gitApi();
  const root = app.workspace.root;
  if (!api?.fetch || !root) return;
  if (fetchView.running && fetchView.root === root) return;
  if (fetchView.root !== root) Object.assign(fetchView, { at: 0, none: false });
  Object.assign(fetchView, { root, running: true, error: '', code: '' });
  renderFetchState(app);
  const result = await call(api.fetch, { folder: root });
  if (fetchView.root !== root) return;
  fetchView.running = false;
  if (result.ok) {
    fetchView.none = !result.data?.fetched;
    if (result.data?.fetched) fetchView.at = result.data.at || Date.now();
  } else if (['NOT_REPOSITORY', 'INVALID_FOLDER', 'FOLDER_NOT_OPENED'].includes(result.error?.code)) {
    // Not a repository (or no longer open): nothing to say.
    Object.assign(fetchView, { root: '', at: 0, none: false });
  } else {
    fetchView.error = errorText(result, 'Git did not answer.');
    fetchView.code = result.error?.code || '';
  }
  renderFetchState(app);
  if (result.ok && app.workspace.root === root) await refreshGitHeader(app);
}

// ---- Commit dialog ---------------------------------------------------------------------------

// The dialog's state: which folder and task, Git's view of it, the message suggestion in flight
// (requestId), whether the user typed a message, the base for a pull request, the opener.
const commit = {
  app: null, folder: '', taskId: null, state: null, requestId: '', touched: false, busy: false,
  base: null, opener: null, token: 0, mode: 'commit', committed: null, branchNames: new Set(), branchTaken: false,
};

function fileLetter(file) {
  if (file.kind === 'untracked') return 'U';
  if (file.kind === 'conflict') return '!';
  if (file.kind === 'renamed') return 'R';
  const code = file.index !== '.' ? file.index : file.worktree;
  return code && code !== '.' ? code : 'M';
}
function fileClass(letter) {
  return { M: 'is-modified', A: 'is-added', U: 'is-untracked', D: 'is-deleted', R: 'is-modified', '!': 'is-conflict' }[letter] || '';
}
// Ticked by default: the reply's files (or every change), never a file that looks like a secret,
// and never ScaleMax's own untracked project notes (`notes`, lib/git-flow.cjs): they are
// ScaleMax's, not the task's work, so they stay out of a commit unless the user ticks them.
function ticked(file, wanted) {
  if (file.secret || file.kind === 'conflict' || file.notes) return false;
  if (!wanted) return true;
  for (const item of wanted) {
    if (item === file.path || item === file.from) return true;
    // A file the reply made inside a folder Git lists as new ("docs/").
    if (file.path.endsWith('/') && item.startsWith(file.path)) return true;
  }
  return false;
}
function selectedPaths() {
  return [...document.querySelectorAll('#commit-files input[type="checkbox"]:checked')].map((box) => box.value);
}
function setCommitStatus(text, { error = false } = {}) {
  const node = $('#commit-status');
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('is-error', Boolean(error && text));
}

function renderFiles(state, wanted) {
  const host = $('#commit-files');
  if (!host) return;
  host.replaceChildren(...state.files.map((file) => {
    const row = element('label', 'commit-file');
    const box = element('input');
    box.type = 'checkbox';
    box.value = file.path;
    box.checked = ticked(file, wanted);
    box.disabled = file.kind === 'conflict';
    const letter = fileLetter(file);
    row.append(box, element('span', `git-status-code ${fileClass(letter)}`, letter),
      element('span', 'commit-file-name', file.from ? `${file.from} → ${file.path}` : file.path));
    if (file.secret) {
      row.append(element('span', 'commit-file-note is-warning', 'Looks like a secret'));
      row.title = 'This file looks like it holds secrets (keys, passwords). It is not ticked, and its contents are never sent to write the message.';
    } else if (file.notes) {
      row.append(element('span', 'commit-file-note', 'ScaleMax project notes'));
      row.title = 'ScaleMax\'s own notes about this project (.scalemax/SCALEMAX.md). Not ticked: they never hold back a merge, a pull request or removing a worktree. Tick them to commit them too.';
    } else if (file.kind === 'untracked' && file.path.endsWith('/')) {
      row.append(element('span', 'commit-file-note', 'New folder'));
    } else if (file.kind === 'conflict') {
      row.append(element('span', 'commit-file-note is-warning', 'Conflict'));
    }
    box.addEventListener('change', () => updateCommitControls());
    return row;
  }));
}

function updateCommitControls() {
  const state = commit.state;
  const formShown = !$('#commit-form-section')?.hidden;
  const paths = selectedPaths();
  const message = $('#commit-message')?.value.trim() || '';
  const fresh = Boolean($('#commit-where-new')?.checked);
  const branch = $('#commit-branch');
  if (branch) branch.disabled = !fresh || commit.busy;
  // A new branch must not be one that exists already (Git would refuse it after the click).
  const taken = Boolean(formShown && fresh && branch && commit.branchNames.has(branch.value.trim()));
  if (branch) branch.setAttribute('aria-invalid', String(taken));
  if (taken !== commit.branchTaken) {
    commit.branchTaken = taken;
    setCommitStatus(taken ? `A branch called ${branch.value.trim()} already exists. Choose another name.` : '', { error: taken });
  }
  const submit = $('#commit-submit');
  if (submit) {
    submit.hidden = !formShown;
    submit.disabled = commit.busy || !paths.length || !message || Boolean(state?.conflicts) || (fresh && !branch?.value.trim()) || taken;
    submit.textContent = fresh ? 'Create branch and commit' : 'Commit';
  }
  const all = $('#commit-toggle-all');
  if (all) {
    const boxes = [...document.querySelectorAll('#commit-files input[type="checkbox"]:not(:disabled)')];
    all.textContent = boxes.length && boxes.every((box) => box.checked) ? 'Select none' : 'Select all';
  }
  const count = $('#commit-count');
  if (count) count.textContent = paths.length ? `${paths.length} of ${state?.files.length || 0} ticked` : 'None ticked';
  const suggest = $('#commit-suggest');
  if (suggest) suggest.disabled = commit.busy || Boolean(commit.requestId) || !paths.length;
  const create = $('#commit-pr-create');
  if (create) create.disabled = commit.busy;
  // Push and "Create pull request…" follow the repository (renderAfter); never while busy.
  for (const id of ['#commit-push', '#commit-pr-open']) {
    const button = $(id);
    if (button && commit.busy) button.disabled = true;
  }
}

function cancelSuggestion() {
  if (!commit.requestId) return;
  void commit.app?.getProviderBridge?.()?.cancel?.(commit.requestId);
  commit.requestId = '';
}

/** Asks main for a message for the ticked files (the provider's, or one describing the files). */
async function suggestMessage() {
  const api = gitApi();
  const paths = selectedPaths();
  const stateNode = $('#commit-message-state');
  if (!api?.suggestMessage || !paths.length) return;
  cancelSuggestion();
  const requestId = `commit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  commit.requestId = requestId;
  const token = commit.token;
  if (stateNode) stateNode.textContent = commit.app?.provider?.configured ? 'Writing a summary of the changes…' : '';
  updateCommitControls();
  const result = await call(api.suggestMessage, { folder: commit.folder, paths, requestId });
  if (token !== commit.token || commit.requestId !== requestId) return;
  commit.requestId = '';
  updateCommitControls();
  if (!result.ok) {
    if (stateNode) stateNode.textContent = result.error?.code === 'CANCELLED' ? '' : errorText(result, '');
    return;
  }
  const input = $('#commit-message');
  if (input && (!commit.touched || !input.value.trim())) {
    input.value = result.data.message || '';
    commit.touched = false;
  }
  if (stateNode) {
    stateNode.textContent = result.data.source === 'provider'
      ? `Suggested by ${result.data.model || 'your provider'} · edit it as you like`
      : result.data.note || 'Describes the files (no provider to write a summary)';
  }
  updateCommitControls();
}

function taskOf(app, taskId) {
  return taskId ? app.tasks.find((item) => item.id === taskId) || null : null;
}

/** The task worktree (not removed) at `folder`, as a task remembers it, or null. */
function worktreeAt(app, folder) {
  for (const task of app.tasks) {
    const own = normalizeWorktree(task.worktree);
    if (own && !own.removed && own.path === folder) return own;
  }
  return null;
}

/**
 * The branch a task worktree has checked out now (a commit to a new branch, Switch branch or a
 * terminal moved it): every task working there remembers it, so the header, the Merge item, the
 * Merge and Remove prompts and the notice after removal name the branch Git really has there.
 * True when something changed.
 */
export function syncWorktreeBranch(app, folder, branch) {
  if (typeof branch !== 'string' || !branch || !folder) return false;
  let changed = false;
  for (const task of app.tasks) {
    const own = normalizeWorktree(task.worktree);
    if (!own || own.path !== folder || own.branch === branch) continue;
    const next = normalizeWorktree({ ...own, branch });
    if (!next) continue;
    task.worktree = next;
    changed = true;
  }
  if (changed) {
    void app.persist('tasks');
    renderWorktreeBar(app);
    app.renderTaskFolderNotice?.();
  }
  return changed;
}

/** What became of the branch a new branch replaced in a task worktree (lib/git-flow.cjs leftBehind). */
export function leftBehindNote(committed) {
  const previous = committed?.previous;
  if (!previous || typeof previous.branch !== 'string') return '';
  if (previous.deleted) return `${previous.branch} had no commits of its own, so it was deleted.`;
  if (previous.pushed) return `${previous.branch} is kept: it was pushed.`;
  if (Number.isInteger(previous.commits) && previous.commits > 0) {
    return `${previous.branch} is kept: its ${plural(previous.commits, 'commit')} ${previous.commits === 1 ? 'is' : 'are'} on ${committed.branch} too.`;
  }
  return `${previous.branch} is kept.`;
}

function renderSubtitle() {
  const state = commit.state;
  const node = $('#commit-subtitle');
  if (!node || !state) return;
  // A task worktree goes by its project and branch ("api (feat/health)", as in the sidebar),
  // never by its generated folder name; any other folder by its name and branch.
  const own = commit.app ? worktreeAt(commit.app, state.root) : null;
  const where = own ? worktreeName({ ...own, branch: state.branch || own.branch })
    : `${friendlyFolderName(state.root, commit.app?.tasks)} · ${state.branch ? `On ${state.branch}` : 'Not on a branch'}`;
  const who = state.identity?.email ? `committing as ${state.identity.name || state.identity.email} <${state.identity.email}>` : 'Git has no user.email set: run git config --global user.email … first';
  node.textContent = `${where} · ${who}`;
}

// The second step: push, open a pull request, the link.
function renderAfter() {
  const state = commit.state;
  const app = commit.app;
  $('#commit-form-section').hidden = true;
  $('#commit-after').hidden = false;
  const committed = commit.committed;
  const result = $('#commit-result');
  if (result) {
    result.textContent = committed
      ? `Committed ${committed.short} on ${committed.branch || 'HEAD'}: ${committed.subject}`
      : state.files.length ? 'Nothing else to commit: only ScaleMax\'s project notes are not committed, and they stay out of the branch.'
        : 'Nothing to commit: every change is committed.';
  }
  const remote = state.remotes?.length ? state.remotes.includes('origin') ? 'origin' : state.remotes[0] : '';
  const push = $('#commit-push');
  if (push) {
    push.hidden = !remote;
    push.disabled = commit.busy || state.detached || state.unborn || Boolean(state.upstream && !state.ahead);
    push.textContent = !state.upstream ? `Push ${state.branch || 'branch'} to ${remote}`
      : state.ahead ? `Push ${plural(state.ahead, 'commit')} to ${state.upstream}` : `Up to date with ${state.upstream}`;
  }
  const open = $('#commit-pr-open');
  if (open) {
    open.hidden = !remote || !$('#commit-pr').hidden;
    open.disabled = commit.busy || state.detached || state.unborn;
  }
  const note = $('#commit-remote-note');
  if (note) note.hidden = Boolean(remote);
  const task = taskOf(app, commit.taskId);
  const title = $('#commit-pr-title');
  if (title && !title.value) title.value = committed?.subject || task?.title || state.branch || '';
  const body = $('#commit-pr-body');
  if (body && !body.value && task?.title) body.value = `Changes from the ScaleMax task “${task.title}”.`;
  const base = $('#commit-pr-base');
  if (base && !base.value && commit.base) base.value = commit.base;
  const cancel = $('#commit-cancel');
  if (cancel) cancel.textContent = 'Close';
  updateCommitControls();
}

function showPrForm() {
  const form = $('#commit-pr');
  if (!form) return;
  form.hidden = false;
  const open = $('#commit-pr-open');
  if (open) open.hidden = true;
  $('#commit-pr-title')?.focus();
}

/**
 * Opens the commit dialog for `folder` (the open folder by default). `paths`: the files to tick
 * (a reply's), else every change that does not look like a secret. `mode: 'pr'` comes from a
 * worktree's "Create PR": the commit step shows only when something is left to commit, then the
 * pull request form opens; `base` is that pull request's base branch.
 */
export async function openCommitDialog(app, { folder = '', taskId = null, paths = null, mode = 'commit', base = null, opener = null } = {}) {
  const dialog = $('#commit-dialog');
  const api = gitApi();
  if (!dialog || !api?.status) {
    app.showToast('Git needs the desktop app');
    return false;
  }
  const target = folder || app.workspace.root;
  if (!target) {
    app.showToast('Open a folder first');
    return false;
  }
  // The branches too, so a suggested new branch name is never one that exists.
  const [result, listed] = await Promise.all([
    call(api.status, { folder: target }),
    api.branches ? call(api.branches, { folder: target }) : Promise.resolve(null),
  ]);
  if (!result.ok) {
    app.showToast(errorText(result, 'Git could not read this folder.'));
    return false;
  }
  if (!result.data?.isRepo) {
    app.showToast('This folder is not a Git repository.');
    return false;
  }
  cancelSuggestion();
  commit.token += 1;
  Object.assign(commit, {
    app, folder: target, taskId, state: result.data, touched: false, busy: false, base, mode, committed: null,
    opener: opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    branchNames: new Set(listed?.ok && Array.isArray(listed.data?.branches) ? listed.data.branches.map((item) => item.name) : []),
    branchTaken: false,
  });
  if (result.data.branch) commit.branchNames.add(result.data.branch);
  const state = result.data;
  for (const id of ['#commit-pr-title', '#commit-pr-body', '#commit-pr-base']) {
    const input = $(id);
    if (input) input.value = '';
  }
  $('#commit-pr').hidden = true;
  $('#commit-pr-link').hidden = true;
  $('#commit-pr-link').replaceChildren();
  $('#commit-cancel').textContent = 'Cancel';
  setCommitStatus('');
  renderSubtitle();
  // A pull request needs no commit for ScaleMax's own notes: with only those left, it goes
  // straight to the pull request form.
  const committable = mode === 'pr' ? state.files.some((file) => !file.notes) : state.files.length > 0;
  if (committable) {
    $('#commit-form-section').hidden = false;
    $('#commit-after').hidden = true;
    renderFiles(state, Array.isArray(paths) ? new Set(paths) : null);
    $('#commit-message').value = '';
    $('#commit-message-state').textContent = '';
    const current = $('#commit-where-current');
    const fresh = $('#commit-where-new');
    $('#commit-where-current-label').textContent = state.branch ? `Commit to ${state.branch}` : 'Commit to the current branch (HEAD is detached: create a branch)';
    current.disabled = state.detached;
    current.checked = !state.detached;
    fresh.checked = state.detached;
    const task = taskOf(app, taskId);
    // Never a branch that exists (a task worktree is already on scalemax/<its title>; an earlier
    // commit may have made that name already): scalemax/<title>, -2, -3 …
    $('#commit-branch').value = uniqueBranchName(`scalemax/${slugify(task ? fullTaskTitle(task) : 'changes')}`, commit.branchNames);
    $('#commit-skip-hooks').checked = false;
    if (state.conflicts) setCommitStatus(`${plural(state.conflicts, 'file is', 'files are')} still in conflict. Resolve them first.`, { error: true });
    else if (state.operation === 'merge') setCommitStatus('A merge is being finished: commit all of its files at once.');
    else if (mode === 'pr') setCommitStatus('Commit these changes first; the pull request comes next.');
    void suggestMessage();
  } else {
    renderAfter();
    if (mode === 'pr') showPrForm();
  }
  updateCommitControls();
  if (!dialog.open) dialog.showModal();
  if (committable) $('#commit-message')?.focus();
  else if (mode !== 'pr') ($('#commit-push')?.hidden ? $('#commit-cancel') : $('#commit-push'))?.focus();
  return true;
}

async function submitCommit() {
  const api = gitApi();
  const app = commit.app;
  if (!api?.commit || commit.busy) return;
  const paths = selectedPaths();
  const message = $('#commit-message').value.trim();
  const fresh = $('#commit-where-new').checked;
  const branch = fresh ? $('#commit-branch').value.trim() : null;
  if (!paths.length || !message || (fresh && !branch)) return;
  const unsaved = unsavedAmong(app, commit.folder, paths);
  if (unsaved.length) {
    setCommitStatus(`Save or close ${unsaved[0]} in the editor first: a commit takes files as they are on disk.`, { error: true });
    return;
  }
  cancelSuggestion();
  const skipHooks = $('#commit-skip-hooks').checked;
  commit.busy = true;
  updateCommitControls();
  setCommitStatus(skipHooks ? 'Committing…' : 'Committing… (the repository\'s commit hooks run first)');
  // In a task's worktree, its base branch: the branch left behind by a new one can be tidied away.
  const own = worktreeAt(app, commit.folder);
  const result = await call(api.commit, { folder: commit.folder, paths, message, branch, skipHooks, ...(own?.base ? { base: own.base } : {}) });
  commit.busy = false;
  if (!result.ok) {
    setCommitStatus(errorText(result, 'The commit did not go through.'), { error: true });
    updateCommitControls();
    // A new branch may exist now even though the commit failed.
    void afterGitChange(app, commit.folder);
    return;
  }
  commit.committed = result.data;
  // A new branch in a task's worktree: the task, its header and every prompt now name that one.
  syncWorktreeBranch(app, commit.folder, result.data.branch);
  const latest = await call(api.status, { folder: commit.folder });
  if (latest.ok && latest.data?.isRepo) commit.state = latest.data;
  renderSubtitle();
  const left = leftBehindNote(result.data);
  setCommitStatus(left);
  renderAfter();
  if (commit.mode === 'pr') showPrForm();
  else if ($('#commit-push') && !$('#commit-push').hidden) $('#commit-push').focus();
  else $('#commit-cancel')?.focus();
  app.showToast(left ? `Committed ${result.data.short} on ${result.data.branch}. ${left}` : `Committed ${result.data.short}`);
  void afterGitChange(app, commit.folder);
}

async function pushCommits() {
  const api = gitApi();
  if (!api?.push || commit.busy) return;
  commit.busy = true;
  renderAfter();
  setCommitStatus('Pushing…');
  const result = await call(api.push, { folder: commit.folder });
  commit.busy = false;
  if (!result.ok) {
    setCommitStatus(errorText(result, 'The push did not go through.'), { error: true });
    renderAfter();
    return;
  }
  const fresh = await call(api.status, { folder: commit.folder });
  if (fresh.ok && fresh.data?.isRepo) commit.state = fresh.data;
  setCommitStatus(`Pushed to ${result.data.upstream || 'the remote'}.`);
  renderAfter();
  void afterGitChange(commit.app, commit.folder);
}

async function createPullRequest() {
  const api = gitApi();
  if (!api?.createPr || commit.busy) return;
  const title = $('#commit-pr-title').value.trim();
  if (!title) {
    setCommitStatus('Give the pull request a title.', { error: true });
    $('#commit-pr-title').focus();
    return;
  }
  commit.busy = true;
  renderAfter();
  setCommitStatus('Pushing the branch and asking GitHub for a pull request…');
  const result = await call(api.createPr, {
    folder: commit.folder, title, body: $('#commit-pr-body').value, base: $('#commit-pr-base').value.trim() || null,
  });
  commit.busy = false;
  if (!result.ok) {
    setCommitStatus(errorText(result, 'The pull request was not created.'), { error: true });
    renderAfter();
    return;
  }
  const fresh = await call(api.status, { folder: commit.folder });
  if (fresh.ok && fresh.data?.isRepo) commit.state = fresh.data;
  setCommitStatus('');
  renderAfter();
  $('#commit-pr').hidden = true;
  const link = $('#commit-pr-link');
  const anchor = element('a', 'commit-pr-anchor', result.data.url);
  // Opens in the browser (main.js setWindowOpenHandler: https only).
  anchor.href = result.data.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  link.replaceChildren('Pull request created: ', anchor);
  link.hidden = false;
  anchor.focus();
  void afterGitChange(commit.app, commit.folder);
}

// ---- Pull and Switch branch (the Workspace Git panel) ---------------------------------------

async function pullBranch(app) {
  const api = gitApi();
  const folder = app.workspace.root;
  if (!api?.pull || !folder) return;
  if (app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return;
  }
  const button = $('#git-pull');
  if (button) button.disabled = true;
  app.showToast('Pulling…');
  const result = await call(api.pull, { folder });
  if (button) button.disabled = false;
  if (!result.ok) {
    app.showToast(errorText(result, 'The pull did not go through.'));
  } else {
    // A pull fetches first: the remote's state is as fresh as a fetch's.
    if (app.workspace.root === folder) Object.assign(fetchView, { root: folder, at: result.data.fetchedAt || Date.now(), error: '', code: '', running: false, none: false });
    app.showToast(pullMessage(result.data));
  }
  await afterGitChange(app, folder, { files: Boolean(result.ok && result.data?.pulled !== 0) });
}

/** "Restore stashed changes": the newest stash Switch branch made comes back onto this checkout. */
async function restoreStashed(app) {
  const api = gitApi();
  const folder = app.workspace.root;
  const data = repoHere(app);
  const stash = Array.isArray(data?.stashes) ? data.stashes[0] : null;
  if (!api?.restoreStash || !folder || !stash) return;
  if (app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return;
  }
  const button = $('#git-stash-restore');
  if (button) button.disabled = true;
  const result = await call(api.restoreStash, { folder, id: stash.id });
  if (button) button.disabled = false;
  if (!result.ok) {
    app.showToast(errorText(result, 'The stashed changes could not be restored.'));
  } else {
    const from = result.data.from || stash.from;
    const onto = result.data.branch && result.data.branch !== from ? ` onto ${result.data.branch}` : '';
    app.showToast(`Restored the changes stashed${from ? ` on ${from}` : ''}${onto}${result.data.dropped === false ? ' (the stash is still listed)' : ''}`);
  }
  await afterGitChange(app, folder, { files: result.ok });
}

const branchView = { app: null, folder: '', data: null, busy: false, opener: null };

async function openBranchDialog(app, opener = null) {
  const dialog = $('#branch-dialog');
  const api = gitApi();
  const folder = app.workspace.root;
  if (!dialog || !api?.branches || !folder) return;
  if (app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return;
  }
  const result = await call(api.branches, { folder });
  if (!result.ok) {
    app.showToast(errorText(result, 'Git could not list the branches.'));
    return;
  }
  Object.assign(branchView, { app, folder, data: result.data, busy: false, opener });
  const data = result.data;
  $('#branch-subtitle').textContent = data.current ? `On ${data.current}` : 'Not on a branch';
  const list = $('#branch-list');
  list.replaceChildren(...data.branches.map((branch) => {
    const row = element('label', 'branch-row');
    const radio = element('input');
    radio.type = 'radio';
    radio.name = 'branch-choice';
    radio.value = branch.name;
    radio.checked = branch.name === data.current;
    // Git keeps a branch in one checkout at a time: one checked out in another worktree (the main
    // checkout, from a task worktree) cannot be switched to here. A task worktree is named by its
    // task, never by its generated folder name.
    const owner = branch.elsewhere ? app.tasks.find((item) => normalizeWorktree(item.worktree)?.path === branch.elsewhere) : null;
    const where = !branch.elsewhere ? '' : owner ? 'a task worktree' : friendlyFolderName(branch.elsewhere, app.tasks);
    radio.disabled = !branch.usable || Boolean(where);
    radio.addEventListener('change', () => renderBranchControls());
    row.append(radio, element('span', 'branch-name', branch.name));
    if (branch.name === data.current) row.append(element('span', 'branch-note', 'current'));
    else if (where) row.append(element('span', 'branch-note', `in ${where}`));
    else if (branch.upstream) row.append(element('span', 'branch-note', branch.upstream));
    if (!branch.usable) row.title = 'Switch to this branch in a terminal: its name is unusual.';
    else if (owner) row.title = `Checked out in the separate worktree of the task “${owner.title}”. Switch there, or remove that worktree first.`;
    else if (where) row.title = `Checked out in ${where}. Switch that checkout to another branch first.`;
    row.classList.toggle('is-taken', Boolean(where));
    return row;
  }));
  $('#branch-stash-row').hidden = !data.dirty;
  $('#branch-stash').checked = false;
  $('#branch-status').textContent = data.dirty ? 'You have uncommitted changes. Commit them first, or stash them to switch.' : '';
  renderBranchControls();
  dialog.showModal();
  (list.querySelector('input:checked') || list.querySelector('input:not(:disabled)'))?.focus();
}

function chosenBranch() {
  return document.querySelector('#branch-list input[name="branch-choice"]:checked')?.value || '';
}
function renderBranchControls() {
  const button = $('#branch-switch');
  if (!button) return;
  const choice = chosenBranch();
  const blocked = branchView.data?.dirty && !$('#branch-stash')?.checked;
  button.disabled = branchView.busy || !choice || choice === branchView.data?.current || Boolean(blocked);
  button.textContent = choice && choice !== branchView.data?.current ? `Switch to ${choice}` : 'Switch';
}

async function switchBranch() {
  const api = gitApi();
  const { app, folder } = branchView;
  const branch = chosenBranch();
  if (!api?.switchBranch || branchView.busy || !branch) return;
  if (app.hasUnsavedEdits()) {
    $('#branch-status').textContent = UNSAVED;
    return;
  }
  branchView.busy = true;
  renderBranchControls();
  $('#branch-status').textContent = `Switching to ${branch}…`;
  const result = await call(api.switchBranch, { folder, branch, stash: $('#branch-stash').checked });
  branchView.busy = false;
  if (!result.ok) {
    $('#branch-status').textContent = errorText(result, 'Could not switch branch.');
    renderBranchControls();
    return;
  }
  $('#branch-dialog').close();
  app.showToast(result.data.stashed ? `On ${branch} now. Your changes are stashed: “Restore stashed changes” in the Git panel brings them back.` : `On ${branch} now`);
  await afterGitChange(app, folder, { files: true });
}

// ---- Worktrees ---------------------------------------------------------------------------------

// Empty tasks whose first message makes a worktree, and tasks making one now.
const offers = new Set();
const making = new Set();
// Whether the worktree bar's "More" menu is open; kept across redraws (a worktree's state arrives
// after the bar is drawn).
let menuOpen = false;

function repoHere(app) {
  return header.root === app.workspace.root ? header.data : null;
}
// The empty task works in the open folder, a repository with commits that is no worktree itself.
function offerable(app, task) {
  if (!task || task.messages.length || !worktreeApi()?.create) return false;
  const folder = task.folder || app.rootFolder();
  const data = repoHere(app);
  return Boolean(folder && folder.path === app.workspace.root && data && !data.unborn && !data.worktree?.linked);
}

function renderWorktreeChip(app) {
  const chip = $('#worktree-chip');
  if (!chip) return;
  const task = app.currentTask();
  const show = offerable(app, task);
  chip.hidden = !show;
  if (!show) return;
  const on = offers.has(task.id);
  const data = repoHere(app);
  chip.setAttribute('aria-pressed', String(on));
  chip.classList.toggle('is-on', on);
  const label = $('#worktree-chip-label');
  if (label) label.textContent = on ? 'Separate worktree: on' : 'Separate worktree';
  chip.title = on
    ? `The first message makes a branch scalemax/… from ${data.branch || 'HEAD'} and a folder of its own for this task (outside the project). Click to work here instead.`
    : 'Separate worktree: this task works on its own copy of the project, in a folder and Git branch of its own, so your files stay as they are until you merge it back';
  chip.setAttribute('aria-description', 'Work on a separate copy of the project, in its own folder and Git branch, so your files stay as they are until you merge it back');
}

/** True when the task's first message should make its worktree first (prepareWorktree). */
export function wantsWorktree(task) {
  return Boolean(task && !task.messages.length && offers.has(task.id));
}

/**
 * Before the first message of a task that asked for a worktree (src/app.js handleSend): makes it
 * from the open folder, binds the task's folder to it and opens it. False when nothing should be
 * sent (it said why).
 */
export async function prepareWorktree(app, task, text) {
  if (!wantsWorktree(task) || text === '/compact') return true;
  // The folder changed since (another one opened, no repository): the offer no longer applies.
  if (!offerable(app, task)) {
    offers.delete(task.id);
    return true;
  }
  const api = worktreeApi();
  const source = task.folder || app.rootFolder();
  if (!api?.create || !source?.path || source.path !== app.workspace.root) return true;
  if (making.has(task.id)) return false;
  if (app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return false;
  }
  making.add(task.id);
  try {
    app.showToast('Making a separate worktree for this task…');
    const result = await call(api.create, { folder: source.path, taskId: task.id, title: text });
    if (!result.ok) {
      app.showToast(`${errorText(result, 'The worktree could not be made.')} Nothing was sent.`);
      return false;
    }
    // Deleted or answered meanwhile: the worktree stays in ScaleMax's worktrees folder.
    if (!app.tasks.includes(task) || task.messages.length) return false;
    offers.delete(task.id);
    const made = result.data;
    // In the folder queue, after any switch still in flight (it would move an empty task's draft
    // folder back to the open one).
    await app.runFolderJob(async () => {
      task.folder = { name: made.name, path: made.path };
      task.worktree = normalizeWorktree({ ...made, createdAt: Date.now() });
    });
    void app.persist('tasks');
    const outcome = await app.openTaskFolder(task);
    if (outcome !== 'ready' || app.workspace.root !== made.path) {
      if (outcome === 'ready') app.showToast('The worktree was made, but its folder did not open. Nothing was sent.');
      return false;
    }
    app.showToast(`Working in a separate worktree on ${made.branch}`);
    return true;
  } finally {
    making.delete(task.id);
  }
}

function infoText(worktree, entry) {
  if (worktree.removed) return 'Removed · the branch is kept';
  if (entry?.error) return entry.error;
  const data = entry?.data;
  if (!data) return '';
  const parts = [];
  if (data.changed) parts.push(`${plural(data.changed, 'change')} not committed`);
  if (data.unmerged) parts.push(`${plural(data.unmerged, 'commit')} to merge`);
  else if (data.unmerged === 0 && !data.changed) parts.push('nothing to merge');
  return parts.join(' · ');
}

async function readWorktreeInfo(app, task, worktree) {
  const api = worktreeApi();
  if (!api?.info || reading.has(task.id)) return;
  reading.add(task.id);
  const result = await call(api.info, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}) });
  reading.delete(task.id);
  infos.set(task.id, { at: Date.now(), data: result.ok ? result.data : null, error: result.ok ? '' : errorText(result, '') });
  // Git's branch there wins over the one the task remembers (syncWorktreeBranch redraws).
  if (result.ok && syncWorktreeBranch(app, worktree.path, result.data?.branch)) return;
  if (app.currentTaskId === task.id) renderWorktreeBar(app);
}

/** Reads the worktree's state now (its branch above all) before a prompt names it. */
async function freshWorktree(app, task, worktree) {
  const api = worktreeApi();
  if (!api?.info) return { worktree, info: null };
  const result = await call(api.info, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}) });
  if (!result.ok) return { worktree, info: null };
  infos.set(task.id, { at: Date.now(), data: result.data, error: '' });
  syncWorktreeBranch(app, worktree.path, result.data?.branch);
  return { worktree: normalizeWorktree(task.worktree) || worktree, info: result.data };
}

function worktreeAction(label, action, title) {
  const button = element('button', 'worktree-action', label);
  button.dataset.worktreeAction = action;
  if (title) button.title = title;
  return button;
}

/** Opens or closes the worktree bar's "More" menu; a keyboard open focuses its first (or last) item. */
function setWorktreeMenu(app, open, { focusFirst = false, focusLast = false, refocus = true } = {}) {
  menuOpen = open;
  renderWorktreeBar(app);
  const bar = $('#worktree-bar');
  const items = bar ? [...bar.querySelectorAll('.worktree-menu-item')] : [];
  if (open && focusLast) items[items.length - 1]?.focus();
  else if (open && focusFirst) items[0]?.focus();
  else if (!open && refocus) bar?.querySelector('[data-worktree-menu]')?.focus();
}

/**
 * Where the arrow keys move in a menu of `count` items from `index` (-1: the menu button):
 * ArrowDown / ArrowUp wrap around, Home / End go to the ends. Null for any other key.
 */
export function menuMove(key, index, count) {
  if (!count) return null;
  if (key === 'ArrowDown') return index < 0 || index >= count - 1 ? 0 : index + 1;
  if (key === 'ArrowUp') return index <= 0 ? count - 1 : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** The task header's worktree bar: the branch, its state and what to do with it. */
function renderWorktreeBar(app) {
  const bar = $('#worktree-bar');
  if (!bar) return;
  const task = app.currentTask();
  const worktree = normalizeWorktree(task?.worktree);
  const show = Boolean(worktree && task.folder?.path === worktree.path);
  bar.hidden = !show;
  if (!show) {
    menuOpen = false;
    bar.replaceChildren();
    return;
  }
  const entry = infos.get(task.id);
  const label = element('span', 'worktree-label');
  label.title = worktree.path;
  label.append(branchIcon('worktree-icon'), element('span', 'worktree-branch', worktree.branch));
  if (worktree.base) label.append(element('span', 'worktree-base', `from ${worktree.base}`));
  const state = element('span', 'worktree-state', infoText(worktree, entry));
  state.title = state.textContent;
  state.setAttribute('role', 'status');
  // Keyboard focus stays on the same action across a redraw.
  const focused = bar.contains(document.activeElement) ? document.activeElement.dataset.worktreeAction : '';
  const focusedMenu = bar.contains(document.activeElement) && Boolean(document.activeElement.dataset.worktreeMenu);
  const nodes = [label, state];
  if (!worktree.removed) {
    // Commit and Create PR stay in view; the rarer actions sit in a menu so the bar stays one
    // line at the narrowest window.
    const actions = element('div', 'worktree-actions');
    const more = element('button', 'worktree-action worktree-more', 'More');
    more.dataset.worktreeMenu = 'toggle';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(menuOpen));
    more.title = 'More worktree actions';
    const menu = element('div', 'worktree-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'More worktree actions');
    menu.hidden = !menuOpen;
    for (const item of [
      worktreeAction(globalThis.window?.scalemaxAPI?.getPlatform?.() === 'win32' ? 'Show in File Explorer' : 'Show in Finder', 'reveal', worktree.path),
      ...(worktree.base ? [worktreeAction(`Merge into ${worktree.base}`, 'merge', `Merge ${worktree.branch} into ${worktree.base} in "${worktree.mainName}"`)] : []),
      worktreeAction('Remove worktree', 'remove', `Delete this worktree's folder (the branch ${worktree.branch} is kept)`),
    ]) {
      item.classList.add('worktree-menu-item');
      item.setAttribute('role', 'menuitem');
      // The arrow keys move between the items; Tab leaves the menu (it closes).
      item.tabIndex = -1;
      menu.append(item);
    }
    actions.append(
      worktreeAction('Commit…', 'commit', 'Commit the changes in this worktree'),
      worktreeAction('Create PR', 'pr', `Push ${worktree.branch} and open a pull request`),
      more,
      menu,
    );
    nodes.push(actions);
  } else {
    menuOpen = false;
  }
  bar.replaceChildren(...nodes);
  if (focused) bar.querySelector(`[data-worktree-action="${focused}"]`)?.focus();
  else if (focusedMenu) bar.querySelector('[data-worktree-menu]')?.focus();
  if (!worktree.removed && (!entry || Date.now() - entry.at > INFO_MAX_AGE_MS)) void readWorktreeInfo(app, task, worktree);
}

// The worktree bar's "More" button as drawn now (the bar is redrawn while a prompt is open).
const moreButton = () => $('#worktree-bar [data-worktree-menu]');

/** What the Merge prompt says ({ title, context, message, note, confirmLabel }), from the worktree and its state. */
export function mergeQuestion(worktree, info = null) {
  // The branch is named on the line under the title (it can be long).
  const commits = Number.isInteger(info?.unmerged) ? info.unmerged : null;
  const what = commits ? plural(commits, 'commit') : 'this worktree\'s branch';
  return {
    title: `Merge ${what} into ${worktree.base}?`,
    context: friendlyFolderName(worktree),
    message: `Git merges it in the project folder "${worktree.mainName}", which must be on ${worktree.base} with no uncommitted changes. If the merge conflicts, it is undone at once and nothing changes.`,
    note: commits === 0 ? `${worktree.base} already has everything from ${worktree.branch}.` : 'The worktree and its branch stay as they are.',
    confirmLabel: `Merge into ${worktree.base}`,
  };
}

async function mergeWorktree(app, task, current) {
  const api = worktreeApi();
  if (!api?.merge || !current.base) return;
  const { worktree, info } = await freshWorktree(app, task, current);
  if (!(await askConfirm({ ...mergeQuestion(worktree, info), returnFocus: moreButton }))) return;
  app.showToast(`Merging into ${worktree.base}…`);
  const result = await call(api.merge, { folder: worktree.path, base: worktree.base, into: worktree.mainRoot });
  infos.delete(task.id);
  if (!result.ok) {
    const commitFirst = result.error?.code === 'WORKTREE_DIRTY' && await askConfirm({
      title: 'Commit the worktree\'s changes first?',
      context: friendlyFolderName(worktree),
      message: errorText(result, 'The worktree has changes that are not committed.'),
      confirmLabel: 'Open Commit…',
      returnFocus: moreButton,
    });
    if (commitFirst) await openCommitDialog(app, { folder: worktree.path, taskId: task.id });
    else if (result.error?.code !== 'WORKTREE_DIRTY') app.showToast(errorText(result, 'The merge did not go through.'));
    renderWorktreeBar(app);
    return;
  }
  app.showToast(result.data.upToDate ? `${worktree.base} already has everything from ${worktree.branch}`
    : `Merged ${plural(result.data.commits, 'commit')} into ${worktree.base} (${result.data.head})`);
  await afterGitChange(app, worktree.mainRoot, { files: true });
}

/**
 * What the Remove prompt says ({ title, context, message, details, note, confirmLabel, danger }):
 * the worktree by its project and branch, what goes (the folder, uncommitted changes) and what is
 * kept (the branch and its commits), from its state (lib/git-flow.cjs worktreeInfo) when known.
 */
export function removeQuestion(worktree, info = null, { others = 0 } = {}) {
  const changed = Number.isInteger(info?.changed) ? info.changed : 0;
  const unmerged = Number.isInteger(info?.unmerged) ? info.unmerged : 0;
  const lost = changed ? ` ${plural(changed, 'uncommitted change')} ${changed === 1 ? 'is' : 'are'} lost with it${info?.changedNames ? `: ${info.changedNames}` : ''}.` : '';
  const kept = unmerged && worktree.base
    ? `The branch ${worktree.branch} is kept, with its ${plural(unmerged, 'commit')} not merged into ${worktree.base}.`
    : `The branch ${worktree.branch} and its commits are kept.`;
  const notes = [];
  if (info?.notes) notes.push('ScaleMax\'s project notes there go with it.');
  if (others) notes.push(`${plural(others, 'other task')} also ${others === 1 ? 'works' : 'work'} there.`);
  return {
    title: 'Remove this task\'s worktree?',
    context: friendlyFolderName(worktree),
    message: `Its folder is deleted.${lost} ${kept}`,
    note: notes.join(' '),
    confirmLabel: changed ? 'Remove and lose changes' : 'Remove worktree',
    danger: true,
  };
}

async function removeWorktree(app, task, current) {
  const api = worktreeApi();
  if (!api?.remove) return;
  if (app.replies.has(task.id)) {
    app.showToast('Wait for the reply to finish, or stop it, then remove the worktree.');
    return;
  }
  if (app.workspace.root === current.path && app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return;
  }
  const { worktree, info } = await freshWorktree(app, task, current);
  const others = app.tasks.filter((item) => item !== task && item.folder?.path === worktree.path).length;
  const question = removeQuestion(worktree, info, { others });
  if (!(await askConfirm({ ...question, returnFocus: moreButton }))) return;
  // What the prompt said would be lost (uncommitted changes) or kept (unmerged commits) was
  // agreed to: the removal goes ahead without asking again.
  const agreed = Boolean(info && (info.changed > 0 || info.unmerged > 0));
  let result = await call(api.remove, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}), ...(agreed ? { force: true } : {}) });
  if (!result.ok && ['WORKTREE_DIRTY', 'UNMERGED'].includes(result.error?.code)) {
    const dirty = result.error.code === 'WORKTREE_DIRTY';
    const anyway = await askConfirm({
      title: dirty ? 'Remove the worktree and lose its changes?' : 'Remove the worktree anyway?',
      context: friendlyFolderName(worktree),
      message: errorText(result, ''),
      note: `The branch ${worktree.branch} is kept.`,
      confirmLabel: dirty ? 'Remove and lose changes' : 'Remove worktree',
      danger: true,
      returnFocus: moreButton,
    });
    if (!anyway) return;
    result = await call(api.remove, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}), force: true });
  }
  if (!result.ok) {
    app.showToast(errorText(result, 'The worktree could not be removed.'));
    return;
  }
  // The branch Git had there when it went (the notice after removal names it).
  const kept = typeof result.data?.branch === 'string' && result.data.branch ? result.data.branch : worktree.branch;
  for (const item of app.tasks) {
    const own = normalizeWorktree(item.worktree);
    if (own?.path === worktree.path) item.worktree = normalizeWorktree({ ...own, branch: kept, removed: true }) || { ...own, removed: true };
  }
  infos.delete(task.id);
  void app.persist('tasks');
  app.missingFolders.add(worktree.path);
  // The window leaves the deleted folder for the checkout the worktree came from; the task stays
  // (its notice says its folder is gone).
  if (app.workspace.root === worktree.path) await app.runFolderJob(() => app.selectFolderNow(worktree.mainRoot));
  app.settleCurrentTask();
  app.showToast(`Removed the worktree; the branch ${kept} is kept`);
}

async function runWorktreeAction(app, action, opener) {
  const task = app.currentTask();
  const worktree = normalizeWorktree(task?.worktree);
  if (!worktree || worktree.removed) return;
  const api = worktreeApi();
  if (action === 'reveal') {
    const result = await call(api.reveal, { folder: worktree.path });
    if (!result.ok) app.showToast(errorText(result, 'The folder could not be shown.'));
  } else if (action === 'commit') {
    await openCommitDialog(app, { folder: worktree.path, taskId: task.id, opener });
  } else if (action === 'pr') {
    await openCommitDialog(app, { folder: worktree.path, taskId: task.id, mode: 'pr', base: worktree.base, opener });
  } else if (action === 'merge') {
    await mergeWorktree(app, task, worktree);
  } else if (action === 'remove') {
    await removeWorktree(app, task, worktree);
  }
}

/** Redraws the worktree chip and the task header's worktree bar (src/app.js renderFolder). */
export function renderGitFlow(app) {
  renderWorktreeChip(app);
  renderWorktreeBar(app);
}

export function bindGitFlowUi(app) {
  commit.app = app;
  branchView.app = app;
  const dialog = $('#commit-dialog');
  if (dialog) {
    const close = () => dialog.close();
    $('#commit-close')?.addEventListener('click', close);
    $('#commit-cancel')?.addEventListener('click', close);
    $('#commit-submit')?.addEventListener('click', () => void submitCommit());
    $('#commit-push')?.addEventListener('click', () => void pushCommits());
    $('#commit-pr-open')?.addEventListener('click', () => showPrForm());
    $('#commit-pr-create')?.addEventListener('click', () => void createPullRequest());
    $('#commit-suggest')?.addEventListener('click', () => {
      commit.touched = false;
      void suggestMessage();
    });
    $('#commit-toggle-all')?.addEventListener('click', () => {
      const boxes = [...document.querySelectorAll('#commit-files input[type="checkbox"]:not(:disabled)')];
      const all = boxes.length && boxes.every((box) => box.checked);
      for (const box of boxes) box.checked = !all;
      updateCommitControls();
    });
    $('#commit-message')?.addEventListener('input', () => {
      commit.touched = true;
      updateCommitControls();
    });
    $('#commit-branch')?.addEventListener('input', () => updateCommitControls());
    for (const id of ['#commit-where-current', '#commit-where-new']) {
      $(id)?.addEventListener('change', () => {
        updateCommitControls();
        if ($('#commit-where-new').checked) $('#commit-branch')?.focus();
      });
    }
    // ⌘/Ctrl+Enter commits from the message box.
    $('#commit-message')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!$('#commit-submit').disabled) void submitCommit();
      }
    });
    dialog.addEventListener('close', () => {
      cancelSuggestion();
      commit.token += 1;
      const opener = commit.opener;
      commit.opener = null;
      if (opener?.isConnected) opener.focus();
    });
  }
  // The task on screen names the branch and the pull request when it works in the open folder.
  $('#git-commit')?.addEventListener('click', (event) => {
    const task = app.currentTask();
    const taskId = task && (task.folder?.path || app.workspace.root) === app.workspace.root ? task.id : null;
    void openCommitDialog(app, { folder: app.workspace.root, taskId, opener: event.currentTarget });
  });
  $('#git-pull')?.addEventListener('click', () => void pullBranch(app));
  $('#git-stash-restore')?.addEventListener('click', () => void restoreStashed(app));
  // Refresh Git (src/app.js reads the panel again) also fetches, quietly, in the background.
  $('#git-refresh')?.addEventListener('click', () => void fetchQuietly(app));
  // "Fetched 3 min ago" keeps counting.
  setInterval(() => { if (fetchView.at && !fetchView.running) renderFetchState(app); }, 30_000);
  $('#git-switch')?.addEventListener('click', (event) => void openBranchDialog(app, event.currentTarget));
  const branches = $('#branch-dialog');
  if (branches) {
    $('#branch-close')?.addEventListener('click', () => branches.close());
    $('#branch-cancel')?.addEventListener('click', () => branches.close());
    $('#branch-switch')?.addEventListener('click', () => void switchBranch());
    $('#branch-stash')?.addEventListener('change', () => renderBranchControls());
    branches.addEventListener('close', () => {
      const opener = branchView.opener;
      branchView.opener = null;
      if (opener?.isConnected) opener.focus();
    });
  }
  $('#worktree-chip')?.addEventListener('click', () => {
    const task = app.currentTask();
    if (!offerable(app, task)) return;
    if (offers.has(task.id)) offers.delete(task.id);
    else offers.add(task.id);
    renderWorktreeChip(app);
    app.showToast(offers.has(task.id) ? 'This task will work in a separate worktree' : 'This task works in the project folder itself');
  });
  $('#worktree-bar')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-worktree-menu]')) {
      setWorktreeMenu(app, !menuOpen, { focusFirst: event.detail === 0 });
      return;
    }
    const button = event.target.closest('[data-worktree-action]');
    if (!button) return;
    // From the menu: it closes with focus on "More", where a prompt it opens gives focus back.
    const fromMenu = Boolean(button.closest('.worktree-menu'));
    if (fromMenu) setWorktreeMenu(app, false);
    void runWorktreeAction(app, button.dataset.worktreeAction, fromMenu ? $('#worktree-bar [data-worktree-menu]') : button);
  });
  // The menu: ArrowDown / ArrowUp (wrapping), Home and End move between its items; on "More"
  // ArrowDown / ArrowUp open it. Escape closes it with focus back on "More"; so does Tab, which
  // then moves on from there. A click outside closes it too.
  $('#worktree-bar')?.addEventListener('keydown', (event) => {
    const bar = event.currentTarget;
    const onMore = Boolean(event.target.closest?.('[data-worktree-menu]'));
    const inMenu = Boolean(event.target.closest?.('.worktree-menu'));
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setWorktreeMenu(app, false);
      return;
    }
    if (!menuOpen) {
      if (onMore && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setWorktreeMenu(app, true, { focusFirst: event.key === 'ArrowDown', focusLast: event.key === 'ArrowUp' });
      }
      return;
    }
    if (!onMore && !inMenu) return;
    if (event.key === 'Tab') {
      if (inMenu) setWorktreeMenu(app, false);
      else setWorktreeMenu(app, false, { refocus: false });
      return;
    }
    const items = [...bar.querySelectorAll('.worktree-menu-item')];
    const next = menuMove(event.key, items.indexOf(document.activeElement), items.length);
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menuOpen && !event.target.closest?.('.worktree-actions')) setWorktreeMenu(app, false, { refocus: false });
  });
  renderHeader(app);
}
