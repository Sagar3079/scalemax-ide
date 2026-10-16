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
import { slugify, normalizeWorktree } from './sessions.mjs';
import { reloadTabs } from './workspace-ui.js';

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
    }
  }
  const pull = $('#git-pull');
  if (pull) {
    pull.disabled = !data?.upstream || Boolean(data?.detached);
    pull.title = !data ? 'Open a Git repository first' : data.upstream ? `Bring in what ${data.upstream} has (fast-forward only)` : 'This branch has no upstream yet: push it first';
  }
  for (const id of ['#git-commit', '#git-switch']) {
    const button = $(id);
    if (button) button.disabled = !data;
  }
}

// ---- Commit dialog ---------------------------------------------------------------------------

// The dialog's state: which folder and task, Git's view of it, the message suggestion in flight
// (requestId), whether the user typed a message, the base for a pull request, the opener.
const commit = {
  app: null, folder: '', taskId: null, state: null, requestId: '', touched: false, busy: false,
  base: null, opener: null, token: 0, mode: 'commit', committed: null,
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
// Ticked by default: the reply's files (or every change), never a file that looks like a secret.
function ticked(file, wanted) {
  if (file.secret || file.kind === 'conflict') return false;
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
  const submit = $('#commit-submit');
  if (submit) {
    submit.hidden = !formShown;
    submit.disabled = commit.busy || !paths.length || !message || Boolean(state?.conflicts) || (fresh && !branch?.value.trim());
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

function renderSubtitle() {
  const state = commit.state;
  const node = $('#commit-subtitle');
  if (!node || !state) return;
  const name = commit.app?.folderLabel?.(state.root) || state.root.split('/').filter(Boolean).pop() || state.root;
  const where = state.branch ? `On ${state.branch}` : 'Not on a branch';
  const who = state.identity?.email ? `committing as ${state.identity.name || state.identity.email} <${state.identity.email}>` : 'Git has no user.email set: run git config --global user.email … first';
  node.textContent = `${name} · ${where} · ${who}`;
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
  const result = await call(api.status, { folder: target });
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
  });
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
  const committable = state.files.length > 0;
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
    $('#commit-branch').value = `scalemax/${slugify(task?.title || 'changes')}`;
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
  const result = await call(api.commit, { folder: commit.folder, paths, message, branch, skipHooks });
  commit.busy = false;
  if (!result.ok) {
    setCommitStatus(errorText(result, 'The commit did not go through.'), { error: true });
    updateCommitControls();
    // A new branch may exist now even though the commit failed.
    void afterGitChange(app, commit.folder);
    return;
  }
  commit.committed = result.data;
  const latest = await call(api.status, { folder: commit.folder });
  if (latest.ok && latest.data?.isRepo) commit.state = latest.data;
  renderSubtitle();
  setCommitStatus('');
  renderAfter();
  if (commit.mode === 'pr') showPrForm();
  else if ($('#commit-push') && !$('#commit-push').hidden) $('#commit-push').focus();
  else $('#commit-cancel')?.focus();
  app.showToast(`Committed ${result.data.short}`);
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
  if (!result.ok) app.showToast(errorText(result, 'The pull did not go through.'));
  else app.showToast(result.data.upstream ? `Up to date with ${result.data.upstream}` : 'Pulled');
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
    // checkout, from a task worktree) cannot be switched to here.
    const where = branch.elsewhere ? (app.folderLabel?.(branch.elsewhere) || branch.elsewhere.split('/').pop()) : '';
    radio.disabled = !branch.usable || Boolean(where);
    radio.addEventListener('change', () => renderBranchControls());
    row.append(radio, element('span', 'branch-name', branch.name));
    if (branch.name === data.current) row.append(element('span', 'branch-note', 'current'));
    else if (where) row.append(element('span', 'branch-note', `in ${where}`));
    else if (branch.upstream) row.append(element('span', 'branch-note', branch.upstream));
    if (!branch.usable) row.title = 'Switch to this branch in a terminal: its name is unusual.';
    else if (where) row.title = `Checked out in ${branch.elsewhere}. Switch there, or remove that worktree first.`;
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
  app.showToast(result.data.stashed ? `On ${branch} now; your changes are in the stash (git stash pop)` : `On ${branch} now`);
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
    : 'Work in a separate worktree: a branch and a folder of its own for this task, so the project stays as it is';
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
  if (app.currentTaskId === task.id) renderWorktreeBar(app);
}

function worktreeAction(label, action, title) {
  const button = element('button', 'worktree-action', label);
  button.dataset.worktreeAction = action;
  if (title) button.title = title;
  return button;
}

/** Opens or closes the worktree bar's "More" menu; a keyboard open focuses its first item. */
function setWorktreeMenu(app, open, { focusFirst = false, refocus = true } = {}) {
  menuOpen = open;
  renderWorktreeBar(app);
  const bar = $('#worktree-bar');
  if (open && focusFirst) bar?.querySelector('.worktree-menu-item')?.focus();
  else if (!open && refocus) bar?.querySelector('[data-worktree-menu]')?.focus();
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
      worktreeAction('Show in Finder', 'reveal', worktree.path),
      ...(worktree.base ? [worktreeAction(`Merge into ${worktree.base}`, 'merge', `Merge ${worktree.branch} into ${worktree.base} in "${worktree.mainName}"`)] : []),
      worktreeAction('Remove worktree', 'remove', 'Delete this worktree folder (the branch is kept)'),
    ]) {
      item.classList.add('worktree-menu-item');
      item.setAttribute('role', 'menuitem');
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

async function mergeWorktree(app, task, worktree) {
  const api = worktreeApi();
  if (!api?.merge || !worktree.base) return;
  const sure = window.confirm(`Merge ${worktree.branch} into ${worktree.base} in "${worktree.mainName}"?\n\nGit merges in that checkout, which must have no uncommitted changes and be on ${worktree.base}. A merge that conflicts is undone at once.`);
  if (!sure) return;
  app.showToast(`Merging into ${worktree.base}…`);
  const result = await call(api.merge, { folder: worktree.path, base: worktree.base, into: worktree.mainRoot });
  infos.delete(task.id);
  if (!result.ok) {
    if (result.error?.code === 'WORKTREE_DIRTY' && window.confirm(`${result.error.message}\n\nCommit them now?`)) {
      await openCommitDialog(app, { folder: worktree.path, taskId: task.id });
    } else {
      app.showToast(errorText(result, 'The merge did not go through.'));
    }
    renderWorktreeBar(app);
    return;
  }
  app.showToast(result.data.upToDate ? `${worktree.base} already has everything from ${worktree.branch}`
    : `Merged ${plural(result.data.commits, 'commit')} into ${worktree.base} (${result.data.head})`);
  await afterGitChange(app, worktree.mainRoot, { files: true });
}

async function removeWorktree(app, task, worktree) {
  const api = worktreeApi();
  if (!api?.remove) return;
  if (app.replies.has(task.id)) {
    app.showToast('Wait for the reply to finish, or stop it, then remove the worktree.');
    return;
  }
  if (app.workspace.root === worktree.path && app.hasUnsavedEdits()) {
    app.showToast(UNSAVED);
    return;
  }
  const others = app.tasks.filter((item) => item !== task && item.folder?.path === worktree.path).length;
  const sure = window.confirm(`Remove this task's worktree?\n\nThe folder ${worktree.path} is deleted; the branch ${worktree.branch} and its commits are kept.${others ? `\n\n${plural(others, 'other task')} also ${others === 1 ? 'works' : 'work'} there.` : ''}`);
  if (!sure) return;
  let result = await call(api.remove, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}) });
  if (!result.ok && ['WORKTREE_DIRTY', 'UNMERGED'].includes(result.error?.code)) {
    if (!window.confirm(`${result.error.message}\n\nRemove the worktree anyway?`)) return;
    result = await call(api.remove, { folder: worktree.path, ...(worktree.base ? { base: worktree.base } : {}), force: true });
  }
  if (!result.ok) {
    app.showToast(errorText(result, 'The worktree could not be removed.'));
    return;
  }
  for (const item of app.tasks) {
    const own = normalizeWorktree(item.worktree);
    if (own?.path === worktree.path) item.worktree = { ...own, removed: true };
  }
  infos.delete(task.id);
  void app.persist('tasks');
  app.missingFolders.add(worktree.path);
  // The window leaves the deleted folder for the checkout the worktree came from; the task stays
  // (its notice says its folder is gone).
  if (app.workspace.root === worktree.path) await app.runFolderJob(() => app.selectFolderNow(worktree.mainRoot));
  app.settleCurrentTask();
  app.showToast(`Removed the worktree; the branch ${worktree.branch} is kept`);
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
    if (button.closest('.worktree-menu')) setWorktreeMenu(app, false, { refocus: false });
    void runWorktreeAction(app, button.dataset.worktreeAction, button);
  });
  // The menu closes on Escape (focus back on "More") and on any click outside it.
  $('#worktree-bar')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setWorktreeMenu(app, false);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (menuOpen && !event.target.closest?.('.worktree-actions')) setWorktreeMenu(app, false, { refocus: false });
  });
  renderHeader(app);
}
