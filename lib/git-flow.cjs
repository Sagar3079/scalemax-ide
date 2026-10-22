'use strict';
// Git for what the user does with their own hands: commit, push, pull, switch branch, a separate
// worktree per task, merge it back, a pull request through the GitHub CLI. These are the user's
// actions, never tools the model can call (main.js exposes them only through the window's IPC),
// so they run with the user's real Git: their identity (user.name / user.email), their settings,
// their credential helpers for push, and the repository's hooks (a pre-commit hook runs unless the
// user ticks "Skip hooks").
//
// lib/workspace.cjs keeps its own locked-down git() for what ScaleMax runs on its own (the Git
// panel's status and diff): no hooks, no global config, 5 seconds. Here too, what only reads (the
// status, branches, a worktree's state, the diff for a commit message) runs with hooks and
// fsmonitor switched off, so opening a dialog never runs a program the repository configured.
//
// No shell, fixed arguments: the window sends a folder, file paths that must be among the
// changes Git itself lists, a commit message (through stdin), a branch name that must pass Git's
// own check, and nothing else. Every command has a time limit and an output cap; commands run in
// a process group of their own (no terminal, so nothing can wait for a password typed there).
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { secretPath } = require('./workspace.cjs');
const { DEFAULT_LANG } = require('./shell-path.cjs');

const READ_LIMIT = 1024 * 1024;
// What an action keeps of its output (hooks can be chatty): the end, where the error is.
const ACTION_KEEP = 64 * 1024;
// How long output may still arrive after a command ended (see exec()).
const LINGER_MS = 500;
const MAX_FILES = 2000;
const MAX_MESSAGE = 20_000;
const MAX_TITLE = 256;
const MAX_BODY = 60_000;
// The diff a commit message is written from, at most (the model needs the gist, not every line).
const SUMMARY_DIFF = 24 * 1024;
const TIMEOUTS = Object.freeze({
  read: 10_000, commit: 30_000, push: 120_000, pull: 120_000, switch: 30_000, worktree: 120_000, merge: 60_000, gh: 120_000,
});
// Branch names ScaleMax passes on: Git's own rules (git check-ref-format --branch decides too),
// and never a leading "-", so a name can never be read as an option.
const BRANCH_NAME = /^(?!-)(?!\.)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,120}(?<![./])$/;
const TASK_ID = /^[A-Za-z0-9-]{1,80}$/;
const SHA = /^[0-9a-f]{7,64}$/;
// Variables that would send Git to another repository, index or object store than the folder's
// are not passed on; these are the user's own choices (identity, SSH, credentials prompt program).
const KEPT_GIT_ENV = new Set([
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);
// Reads never run what a repository configured: no hooks, no fsmonitor program, no pager.
const READ_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The last lines of a command's output, for an error message. */
function tail(text, lines = 12, chars = 1500) {
  const value = String(text || '').replace(/\r\n?/g, '\n').trim();
  const kept = value.split('\n').slice(-lines).join('\n');
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
}

function gitFailure(result, what) {
  const detail = tail(result.stderr) || tail(result.stdout) || `exit code ${result.code}`;
  return fail('GIT_ERROR', `${what}: ${detail}`);
}

/** A branch name for a task: "Fix the login form!" → "fix-the-login-form" (at most 40 characters). */
function slugify(text) {
  const plain = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (plain.length <= 40) return plain || 'task';
  const cut = plain.slice(0, 40);
  const dash = cut.lastIndexOf('-');
  return (dash >= 20 ? cut.slice(0, dash) : cut).replace(/-+$/, '') || 'task';
}

// A path as a pathspec that means exactly that file or folder: no glob, no magic (":(literal)").
const literal = (file) => `:(literal)${file}`;

function validBranch(name) {
  return typeof name === 'string' && BRANCH_NAME.test(name);
}

/** A commit message when there is no provider (or it did not answer): what changed, in one line. */
function defaultCommitMessage(files) {
  const list = Array.isArray(files) ? files.filter((file) => file && typeof file.path === 'string') : [];
  if (!list.length) return '';
  const name = (file) => file.path.replace(/\/$/, '').split('/').pop();
  if (list.length === 1) {
    const [file] = list;
    if (file.kind === 'untracked' || file.index === 'A') return `chore: add ${name(file)}`;
    if (file.worktree === 'D' || file.index === 'D') return `chore: remove ${name(file)}`;
    return `chore: update ${name(file)}`;
  }
  const added = list.every((file) => file.kind === 'untracked' || file.index === 'A');
  return `chore: ${added ? 'add' : 'update'} ${list.length} files`;
}

/** The first line of what the model wrote, cleaned up as a commit subject (≤ 100 characters). */
function commitSubject(text) {
  const line = String(text || '').split('\n').map((item) => item.trim()).find((item) => item && !/^```/.test(item)) || '';
  const cleaned = line.replace(/^(?:commit message|subject)\s*:\s*/i, '').replace(/^["'`*]+|["'`*]+$/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.length > 100 ? cleaned.slice(0, 100).replace(/\s+\S*$/, '') : cleaned;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`: the branch line(s) and one entry per changed
 * path ({ path, from?, index, worktree, kind: 'changed' | 'renamed' | 'conflict' | 'untracked' }).
 */
function parseStatus(text) {
  const records = String(text).split('\0');
  const state = { head: null, branch: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0, files: [] };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        if (value === '(initial)') state.unborn = true;
        else if (SHA.test(value)) state.head = value;
      } else if (key === 'branch.head') {
        if (value === '(detached)') state.detached = true;
        else state.branch = value;
      } else if (key === 'branch.upstream') {
        state.upstream = value;
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          state.ahead = Number(match[1]);
          state.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === '?') {
      state.files.push({ path: record.slice(2), index: '?', worktree: '?', kind: 'untracked' });
    } else if (type === '1' || type === 'u') {
      // 1 XY sub mH mI mW hH hI path | u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = type === '1' ? 8 : 10;
      const parts = record.split(' ');
      const file = parts.slice(fields).join(' ');
      state.files.push({ path: file, index: parts[1][0], worktree: parts[1][1], kind: type === 'u' ? 'conflict' : 'changed' });
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record.
      const parts = record.split(' ');
      const file = parts.slice(9).join(' ');
      const from = records[index + 1] || '';
      index += 1;
      state.files.push({ path: file, from, index: parts[1][0], worktree: parts[1][1], kind: 'renamed' });
    }
    if (state.files.length > MAX_FILES) throw fail('TOO_MANY_FILES', `More than ${MAX_FILES} files changed; commit them from a terminal.`);
  }
  return state;
}

/**
 * @param {{
 *   env?: object | (() => object), gitPath?: string, worktreesDir?: string,
 *   ghPath?: () => string | null, ghEnv?: () => object, spawnImpl?: typeof childProcess.spawn,
 *   gitVersion?: number[] | null, io?: typeof fs,
 * }} options worktreesDir: where per-task worktrees go (main: <userData>/worktrees); ghPath and
 *   ghEnv: the GitHub CLI and its environment (lib/cli-auth.cjs finds it and strips GH_TOKEN & co.)
 */
function createGitFlow({
  env = () => process.env, gitPath = 'git', worktreesDir = null, ghPath = () => null, ghEnv = null,
  spawnImpl = childProcess.spawn, gitVersion = null, io = fs,
} = {}) {
  const fsp = io.promises;
  // User actions run one after another (two quick clicks never commit or merge at once).
  let queue = Promise.resolve();
  function serial(task) {
    const run = queue.then(() => task());
    queue = run.catch(() => {});
    return run;
  }

  function baseEnvironment() {
    const source = typeof env === 'function' ? env() : env;
    const output = {};
    for (const [key, value] of Object.entries(source || {})) {
      if (typeof value !== 'string') continue;
      if (key.startsWith('GIT_') && !KEPT_GIT_ENV.has(key)) continue;
      output[key] = value;
    }
    if (!output.LANG && !output.LC_ALL) output.LANG = DEFAULT_LANG;
    // Never wait for a password typed into a terminal (there is none); credential helpers and
    // SSH agents still answer. An editor is never opened: messages come from the dialog. Hooks
    // inherit this, so nothing here changes how Git reads their own arguments (paths are made
    // literal one by one, see literal()).
    return {
      ...output, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat', PAGER: 'cat',
    };
  }

  /**
   * Runs a program without a shell in its own process group. `read`: output over READ_LIMIT fails
   * (OUTPUT_LIMIT); otherwise the end of the output is kept. Resolves { code, stdout, stderr }.
   */
  function exec(file, args, { cwd, timeoutMs, input = null, read = false, environment = baseEnvironment() }) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let overflow = false;
      const out = [];
      const err = [];
      let size = 0;
      const windows = process.platform === 'win32';
      const kill = () => {
        if (!child) return;
        try {
          if (!windows && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already ended */ }
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill();
        const who = file === gitPath ? 'Git' : 'The GitHub CLI';
        reject(fail(file === gitPath ? 'GIT_TIMEOUT' : 'TIMEOUT', `${who} took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
      }, timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const keep = (list, chunk) => {
        size += chunk.length;
        if (read && size > READ_LIMIT) {
          overflow = true;
          kill();
          return;
        }
        list.push(chunk);
        // Actions keep the end of their output.
        let total = list.reduce((sum, item) => sum + item.length, 0);
        while (!read && total > ACTION_KEEP && list.length > 1) total -= list.shift().length;
      };
      try {
        child = spawnImpl(file, args, {
          cwd, env: environment, shell: false, detached: !windows, windowsHide: true,
          stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(fail('GIT_ERROR', `Could not start ${path.basename(file)}: ${error.message}`));
        return;
      }
      child.stdout.on('data', (chunk) => keep(out, chunk));
      child.stderr.on('data', (chunk) => keep(err, chunk));
      child.on('error', (error) => {
        if (error.code === 'ENOENT') finish(fail(file === gitPath ? 'GIT_UNAVAILABLE' : 'NOT_FOUND', file === gitPath ? 'Git was not found. Install Git and make it available on PATH.' : `${path.basename(file)} was not found.`));
        else finish(fail('GIT_ERROR', `Could not run ${path.basename(file)}: ${error.message}`));
      });
      const complete = (code) => {
        if (overflow) {
          finish(fail('OUTPUT_LIMIT', 'Git answered with more than 1 MiB; this is too large to show here.'));
          return;
        }
        finish(null, { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      };
      // A program the command left running in the background (an SSH ControlPersist master, a
      // credential cache) can hold the output pipes open long after: once the command itself has
      // ended, what it wrote by then is its answer, and that program is left alone.
      let exitCode = null;
      child.on('exit', (code) => {
        exitCode = code;
        const linger = setTimeout(() => complete(exitCode), LINGER_MS);
        linger.unref?.();
      });
      child.on('close', (code) => complete(code ?? exitCode));
      if (input !== null) {
        child.stdin.on('error', () => { /* the program ended before reading everything */ });
        child.stdin.end(input);
      }
    });
  }

  const read = (cwd, args, timeoutMs = TIMEOUTS.read) => exec(gitPath, [...READ_FLAGS, ...args], { cwd, timeoutMs, read: true });
  const act = (cwd, args, timeoutMs, { input = null } = {}) => exec(gitPath, args, { cwd, timeoutMs, input });
  async function readOk(cwd, args, what) {
    const result = await read(cwd, args);
    if (result.code !== 0) throw gitFailure(result, what);
    return result.stdout;
  }

  let version = Array.isArray(gitVersion) ? gitVersion : null;
  async function gitVersionOf(cwd) {
    if (version) return version;
    const result = await exec(gitPath, ['--version'], { cwd, timeoutMs: TIMEOUTS.read, read: true });
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
    version = match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
    return version;
  }
  // `git worktree remove` came with Git 2.17; older Git removes the folder and prunes.
  async function hasWorktreeRemove(cwd) {
    const [major, minor] = await gitVersionOf(cwd);
    return major > 2 || (major === 2 && minor >= 17);
  }

  async function exists(target) {
    try {
      await fsp.lstat(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * The canonical top folder of a repository the user opened. A folder reached through a link, or
   * one that is not a repository's top folder, is refused, and so is a .git folder with a
   * commondir (it sends Git to another folder's config and hooks; see lib/workspace.cjs).
   */
  async function repositoryRoot(folder, { optional = false } = {}) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0') || folder.length > 4096) {
      throw fail('INVALID_FOLDER', 'Choose a project folder.');
    }
    let canonical;
    try {
      canonical = await fsp.realpath(folder);
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('ENOENT', `The folder "${path.basename(folder)}" is no longer available.`);
      throw error;
    }
    if (canonical !== folder) throw fail('SYMLINK', 'Use the project folder itself, not a link to it.');
    if (!(await fsp.stat(folder)).isDirectory()) throw fail('NOT_DIRECTORY', 'Choose a project folder.');
    let marker = null;
    try { marker = await fsp.lstat(path.join(folder, '.git')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker?.isSymbolicLink()) throw fail('GIT_UNSAFE', 'This project\'s .git is a link, so ScaleMax does not run Git here.');
    if (marker?.isDirectory() && await exists(path.join(folder, '.git', 'commondir'))) {
      throw fail('GIT_UNSAFE', 'This project\'s .git folder points Git at another folder (.git/commondir), so ScaleMax does not run Git here.');
    }
    const result = await read(folder, ['rev-parse', '--show-toplevel']);
    if (result.code !== 0) {
      if (/not a git repository/i.test(result.stderr) && optional) return null;
      if (/not a git repository/i.test(result.stderr)) throw fail('NOT_REPOSITORY', 'This folder is not a Git repository.');
      throw gitFailure(result, 'Git could not read this folder');
    }
    const top = result.stdout.replace(/\r?\n$/, '');
    if (top !== folder) {
      if (optional) return null;
      throw fail('NOT_REPOSITORY', `This folder is inside the repository "${path.basename(top)}". Open its top folder to use Git here.`);
    }
    return folder;
  }

  // The repository's own Git folder and, for a linked worktree, the main one it belongs to.
  async function gitDirs(root) {
    const out = await readOk(root, ['rev-parse', '--git-dir', '--git-common-dir'], 'Git could not read this repository');
    const [gitDir, commonDir] = out.split('\n').map((line) => line.trim()).filter(Boolean).map((item) => path.resolve(root, item));
    const own = await fsp.realpath(gitDir);
    const common = await fsp.realpath(commonDir || gitDir);
    return { gitDir: own, commonDir: common, linked: own !== common };
  }
  // The checkout a Git folder belongs to (<main>/.git → <main>); a bare repository has none.
  const checkoutOf = (commonDir) => (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null);

  async function operationIn(gitDir) {
    if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
    if (await exists(path.join(gitDir, 'rebase-merge')) || await exists(path.join(gitDir, 'rebase-apply'))) return 'rebase';
    if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    return null;
  }

  async function configValue(root, key) {
    const result = await read(root, ['config', '--get', key]);
    return result.code === 0 ? result.stdout.trim().slice(0, 256) : '';
  }

  async function remotes(root) {
    const out = await readOk(root, ['remote'], 'Git could not list the remotes');
    return out.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 50);
  }

  /**
   * The repository as the dialogs show it: branch, upstream and how far ahead/behind, changed
   * files, a merge or rebase in progress, who commits (identity) and whether this is a linked
   * worktree. A folder that is no repository answers { isRepo: false }.
   */
  async function statusOf(root) {
    const parsed = parseStatus(await readOk(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], 'Git could not read the changes'));
    const dirs = await gitDirs(root);
    const [name, email, remoteNames, operation] = await Promise.all([
      configValue(root, 'user.name'), configValue(root, 'user.email'), remotes(root), operationIn(dirs.gitDir),
    ]);
    const conflicts = parsed.files.filter((file) => file.kind === 'conflict').length;
    return {
      isRepo: true,
      root,
      branch: parsed.branch,
      detached: parsed.detached,
      unborn: parsed.unborn,
      head: parsed.head ? parsed.head.slice(0, 12) : null,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      files: parsed.files.map((file) => ({ ...file, secret: secretPath(file.path.replace(/\/$/, '')) })),
      conflicts,
      operation,
      identity: { name, email },
      remotes: remoteNames,
      worktree: { linked: dirs.linked, main: dirs.linked ? checkoutOf(dirs.commonDir) : null },
    };
  }

  async function status(folder) {
    const root = await repositoryRoot(folder, { optional: true });
    if (!root) return { isRepo: false };
    return statusOf(root);
  }

  async function branchExists(root, name) {
    const result = await read(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return result.code === 0;
  }
  async function checkBranchName(root, name) {
    if (!validBranch(name)) throw fail('INVALID_BRANCH', 'Use a branch name of letters, digits and . _ - / (no spaces, no ".." and not starting with "-").');
    const result = await read(root, ['check-ref-format', '--branch', name]);
    if (result.code !== 0) throw fail('INVALID_BRANCH', `"${name}" is not a valid branch name.`);
  }

  async function branchesOf(root) {
    const out = await readOk(root, ['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(objectname)', 'refs/heads'], 'Git could not list the branches');
    const list = [];
    for (const line of out.split('\n')) {
      const [ref, upstream, head] = line.split('\0');
      if (!ref?.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      list.push({ name, upstream: upstream || null, head: SHA.test(head || '') ? head.slice(0, 12) : null, usable: validBranch(name) });
      if (list.length >= 500) break;
    }
    return list.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Branch name → the other checkout (canonical path) that has it checked out: Git refuses to
   * check one branch out in two places, so "Switch branch" shows those as taken.
   */
  async function branchesElsewhere(root) {
    const out = await readOk(root, ['worktree', 'list', '--porcelain'], 'Git could not list the worktrees');
    const taken = new Map();
    let at = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        try { at = await fsp.realpath(line.slice('worktree '.length)); } catch { at = null; }
      } else if (at && at !== root && line.startsWith('branch refs/heads/')) {
        taken.set(line.slice('branch refs/heads/'.length), at);
      }
    }
    return taken;
  }

  /** The local branches (the current one marked, those checked out elsewhere too) for "Switch branch". */
  async function branches(folder) {
    const root = await repositoryRoot(folder);
    const state = await statusOf(root);
    const taken = await branchesElsewhere(root);
    const list = (await branchesOf(root)).map((branch) => ({ ...branch, elsewhere: taken.get(branch.name) || null }));
    return { current: state.branch, detached: state.detached, branches: list, dirty: state.files.some((file) => file.kind !== 'untracked') };
  }

  // Exactly the entries Git listed, by path (a rename by either of its paths).
  function chooseFiles(state, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES || paths.some((item) => typeof item !== 'string' || !item || item.length > 4096 || item.includes('\0'))) {
      throw fail('INVALID_PATHS', 'Choose at least one changed file.');
    }
    const wanted = new Set(paths);
    const chosen = state.files.filter((file) => wanted.has(file.path) || (file.from && wanted.has(file.from)));
    const known = new Set(chosen.flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]));
    const unknown = paths.filter((item) => !known.has(item));
    if (unknown.length) throw fail('INVALID_PATHS', `${unknown[0]} is not among the changes Git lists any more. Refresh and try again.`);
    return chosen;
  }

  /**
   * What a commit message is written from: the chosen files and their diff (at most
   * SUMMARY_DIFF bytes). Secret-looking files (.env, keys; lib/workspace.cjs) are named as
   * "left out" and their contents never read, since this goes to the provider.
   */
  async function summaryInput(folder, paths) {
    const root = await repositoryRoot(folder);
    const state = await statusOf(root);
    const chosen = chooseFiles(state, paths);
    const shown = chosen.filter((file) => !file.secret);
    const tracked = shown.filter((file) => file.kind !== 'untracked').flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]);
    let diff = '';
    if (tracked.length) {
      const base = state.unborn ? ['diff', '--cached'] : ['diff', 'HEAD'];
      const result = await read(root, [...base, '--no-ext-diff', '--no-textconv', '--no-color', '-U2', '--', ...tracked.map(literal)]);
      if (result.code === 0) diff = result.stdout;
    }
    const truncated = Buffer.byteLength(diff) > SUMMARY_DIFF;
    if (truncated) diff = Buffer.from(diff).subarray(0, SUMMARY_DIFF).toString('utf8').replace(/�$/, '');
    return {
      branch: state.branch,
      files: chosen.map((file) => ({ path: file.path, kind: file.kind, index: file.index, worktree: file.worktree, ...(file.secret ? { secret: true } : {}) })),
      diff,
      truncated,
      leftOut: chosen.length - shown.length,
      fallback: defaultCommitMessage(chosen),
    };
  }

  async function headInfo(root) {
    const out = await readOk(root, ['log', '-1', '--format=%H%x00%s'], 'Git could not read the new commit');
    const [commit, subject] = out.replace(/\n$/, '').split('\0');
    return { commit, short: commit.slice(0, 7), subject: subject || '' };
  }

  /**
   * Commits the chosen files. Refused while files are in conflict, during a rebase, and on a
   * detached HEAD unless `branch` names a new branch to create first (which also works on any
   * branch: "create a new branch first"). The repository's commit hooks run unless `skipHooks`.
   * @param {{ paths: string[], message: string, branch?: string|null, skipHooks?: boolean }} input
   */
  function commit(folder, input = {}) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      const state = await statusOf(root);
      if (state.conflicts) throw fail('CONFLICTS', `${state.conflicts === 1 ? 'A file is' : `${state.conflicts} files are`} still in conflict. Resolve ${state.conflicts === 1 ? 'it' : 'them'} first.`);
      if (state.operation === 'rebase') throw fail('REBASE_IN_PROGRESS', 'A rebase is in progress. Finish or abort it in a terminal first.');
      const message = typeof input.message === 'string' ? input.message.replace(/\r\n?/g, '\n').trim() : '';
      if (!message) throw fail('INVALID_MESSAGE', 'Write a commit message.');
      if (message.length > MAX_MESSAGE || message.includes('\0')) throw fail('INVALID_MESSAGE', 'The commit message is too long.');
      const branch = input.branch === undefined || input.branch === null || input.branch === '' ? null : input.branch;
      if (branch !== null) {
        await checkBranchName(root, branch);
        if (await branchExists(root, branch)) throw fail('BRANCH_EXISTS', `A branch called "${branch}" already exists. Choose another name.`);
      } else if (state.detached) {
        throw fail('DETACHED_HEAD', 'HEAD is detached (not on a branch). Create a new branch for this commit.');
      }
      const chosen = chooseFiles(state, input.paths);
      if (state.operation === 'merge' && chosen.length !== state.files.filter((file) => file.kind !== 'untracked').length) {
        throw fail('MERGE_IN_PROGRESS', 'A merge is being finished: commit all of its changed files at once.');
      }
      // An untracked folder is listed as "dir/"; as a literal pathspec it is "dir".
      const pathspecs = [...new Set(chosen.flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]).map((item) => item.replace(/\/+$/, '')))];
      if (branch !== null) {
        const created = await act(root, ['checkout', '-b', branch], TIMEOUTS.commit);
        if (created.code !== 0) throw gitFailure(created, `Could not create the branch ${branch}`);
      }
      const added = await act(root, ['add', '-A', '--', ...pathspecs.map(literal)], TIMEOUTS.commit);
      if (added.code !== 0) throw gitFailure(added, 'Could not stage the files');
      // `--` with paths commits exactly these files, whatever else was staged before; a merge
      // being finished is committed whole (Git refuses a partial merge commit).
      const args = ['commit', '-F', '-', ...(input.skipHooks === true ? ['--no-verify'] : []), ...(state.operation === 'merge' ? [] : ['--', ...pathspecs.map(literal)])];
      const done = await act(root, args, TIMEOUTS.commit, { input: `${message}\n` });
      if (done.code !== 0) {
        const where = branch !== null ? ` You are now on the new branch ${branch}.` : '';
        const error = gitFailure(done, `The commit did not go through${input.skipHooks === true ? '' : ' (a commit hook may have stopped it)'}`);
        error.message += where;
        throw error;
      }
      const after = await statusOf(root);
      return { ...(await headInfo(root)), branch: after.branch, upstream: after.upstream, ahead: after.ahead, behind: after.behind, files: chosen.length };
    });
  }

  // The remote a branch without an upstream goes to: origin, or the only remote there is.
  function pushRemote(state) {
    if (state.remotes.includes('origin')) return 'origin';
    if (state.remotes.length === 1) return state.remotes[0];
    if (!state.remotes.length) throw fail('NO_REMOTE', 'This repository has no remote to push to. Add one (git remote add origin <url>) first.');
    throw fail('NO_REMOTE', 'This repository has several remotes and none is called origin. Push this branch once from a terminal to choose one.');
  }

  async function pushNow(root, state) {
    if (state.detached) throw fail('DETACHED_HEAD', 'HEAD is detached (not on a branch). Create a branch to push.');
    if (state.unborn) throw fail('NO_COMMITS', 'There is nothing to push yet: make a first commit.');
    let result;
    let remote = null;
    if (state.upstream) {
      // The user's own push settings decide where the branch goes.
      result = await act(root, ['push'], TIMEOUTS.push);
    } else {
      remote = pushRemote(state);
      if (!validBranch(state.branch)) throw fail('INVALID_BRANCH', 'Push this branch from a terminal: its name is unusual.');
      result = await act(root, ['push', '--set-upstream', remote, `HEAD:refs/heads/${state.branch}`], TIMEOUTS.push);
    }
    if (result.code !== 0) throw gitFailure(result, 'The push did not go through');
    const after = await statusOf(root);
    return { branch: after.branch, upstream: after.upstream, ahead: after.ahead, behind: after.behind };
  }

  /** Pushes the current branch (setting its upstream on the first push). Never forced. */
  function push(folder) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      return pushNow(root, await statusOf(root));
    });
  }

  /** Brings the branch up to date with its upstream, only when that is a fast-forward. */
  function pull(folder) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      const state = await statusOf(root);
      if (state.detached) throw fail('DETACHED_HEAD', 'HEAD is detached (not on a branch), so there is nothing to pull into.');
      if (state.conflicts || state.operation) throw fail('BUSY_REPOSITORY', 'Finish the merge or rebase in progress first.');
      if (!state.upstream) throw fail('NO_UPSTREAM', 'This branch has no upstream yet. Push it first.');
      const result = await act(root, ['pull', '--ff-only'], TIMEOUTS.pull);
      if (result.code !== 0) {
        const diverged = /not possible to fast-forward|diverg/i.test(`${result.stderr}${result.stdout}`);
        if (diverged) throw fail('DIVERGED', 'Your branch and its upstream have both moved on. Merge or rebase them in a terminal.');
        throw gitFailure(result, 'The pull did not go through');
      }
      const after = await statusOf(root);
      return { branch: after.branch, upstream: after.upstream, ahead: after.ahead, behind: after.behind, head: after.head };
    });
  }

  /**
   * Switches to another local branch. With uncommitted changes to tracked files it is refused,
   * unless `stash` is true: then they are stashed first ("git stash pop" brings them back).
   * Untracked files stay where they are (Git refuses itself if the branch would overwrite one).
   */
  function switchBranch(folder, { branch, stash = false } = {}) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      const state = await statusOf(root);
      if (state.conflicts || state.operation) throw fail('BUSY_REPOSITORY', 'Finish the merge or rebase in progress first.');
      const known = await branchesOf(root);
      if (typeof branch !== 'string' || !known.some((item) => item.name === branch && item.usable)) throw fail('INVALID_BRANCH', 'Choose one of the branches listed.');
      if (branch === state.branch) return { branch, stashed: false };
      const elsewhere = (await branchesElsewhere(root)).get(branch);
      if (elsewhere) throw fail('BRANCH_IN_USE', `${branch} is checked out in "${path.basename(elsewhere)}". Git keeps a branch in one checkout at a time: switch there, or remove that worktree first.`);
      const dirty = state.files.some((file) => file.kind !== 'untracked');
      if (dirty && stash !== true) throw fail('DIRTY', 'You have uncommitted changes. Commit them, or choose to stash them first.');
      let stashed = false;
      if (dirty) {
        const saved = await act(root, ['stash', 'push', '-m', `ScaleMax: before switching to ${branch}`], TIMEOUTS.switch);
        if (saved.code !== 0) throw gitFailure(saved, 'Could not stash your changes');
        stashed = true;
      }
      const switched = await act(root, ['checkout', branch, '--'], TIMEOUTS.switch);
      if (switched.code !== 0) {
        const error = gitFailure(switched, `Could not switch to ${branch}`);
        if (stashed) error.message += ' Your changes are in the stash (git stash pop brings them back).';
        throw error;
      }
      return { branch, stashed };
    });
  }

  // ---- Worktrees ----------------------------------------------------------------------------

  async function worktreesHome() {
    if (typeof worktreesDir !== 'string' || !path.isAbsolute(worktreesDir)) throw fail('UNAVAILABLE', 'Worktrees are not available here.');
    await fsp.mkdir(worktreesDir, { recursive: true, mode: 0o700 });
    return fsp.realpath(worktreesDir);
  }
  // A folder ScaleMax made for a task: directly inside the worktrees folder.
  async function managed(folder) {
    if (typeof worktreesDir !== 'string') return false;
    let home;
    try { home = await fsp.realpath(worktreesDir); } catch { return false; }
    return path.dirname(folder) === home;
  }

  /** The worktrees Git lists for a repository, as canonical paths. */
  async function listedWorktrees(root) {
    const out = await readOk(root, ['worktree', 'list', '--porcelain'], 'Git could not list the worktrees');
    const found = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      try { found.push(await fsp.realpath(line.slice('worktree '.length))); } catch { /* missing: prunable */ }
    }
    return found;
  }

  /**
   * A separate checkout for a task: `git worktree add -b scalemax/<slug> <worktreesDir>/<repo>-<taskId>`
   * from what the folder has checked out now. The branch name gets -2, -3 … when it is taken.
   * @returns {{ path, name, branch, base, baseCommit, mainRoot, mainName }}
   */
  function createWorktree(folder, { taskId, title } = {}) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw fail('INVALID_TASK', 'This task cannot have a worktree.');
      const state = await statusOf(root);
      if (state.unborn) throw fail('NO_COMMITS', 'Make a first commit in this repository before working in a separate worktree.');
      const home = await worktreesHome();
      const repoName = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'repo';
      const target = path.join(home, `${repoName}-${taskId}`);
      if (path.dirname(target) !== home) throw fail('INVALID_TASK', 'This task cannot have a worktree.');
      if (await exists(target)) throw fail('EXISTS', 'A worktree for this task already exists.');
      const slug = slugify(title);
      let branch = `scalemax/${slug}`;
      for (let number = 2; await branchExists(root, branch); number += 1) {
        if (number > 50) throw fail('BRANCH_EXISTS', 'Too many branches with this name already exist.');
        branch = `scalemax/${slug}-${number}`;
      }
      await checkBranchName(root, branch);
      const added = await act(root, ['worktree', 'add', '-b', branch, target, 'HEAD'], TIMEOUTS.worktree);
      if (added.code !== 0) throw gitFailure(added, 'Could not create the worktree');
      const created = await fsp.realpath(target);
      return {
        path: created,
        name: `${repoName} (${branch.slice('scalemax/'.length)})`,
        branch,
        base: state.detached ? null : state.branch,
        baseCommit: state.head,
        mainRoot: root,
        mainName: path.basename(root),
      };
    });
  }

  // A linked worktree's checkout, its main checkout `into` (verified: a checkout of the same
  // repository that lists this worktree) and its branch's commits not yet in `base`.
  async function worktreeState(folder, { base = null, into = null } = {}) {
    const root = await repositoryRoot(folder);
    const state = await statusOf(root);
    if (!state.worktree.linked) throw fail('NOT_WORKTREE', 'This folder is not a separate worktree.');
    let main = null;
    if (into !== null) {
      main = await repositoryRoot(into);
      const [mine, theirs] = await Promise.all([gitDirs(root), gitDirs(main)]);
      if (mine.commonDir !== theirs.commonDir || !(await listedWorktrees(main)).includes(root)) {
        throw fail('NOT_WORKTREE', 'That folder is not where this worktree came from.');
      }
    }
    let unmerged = null;
    if (base !== null) {
      if (!validBranch(base) || !(await branchExists(root, base))) throw fail('INVALID_BRANCH', `The branch "${base}" no longer exists.`);
      const count = await readOk(root, ['rev-list', '--count', `refs/heads/${base}..HEAD`], 'Git could not compare the branches');
      unmerged = Number(count.trim()) || 0;
    }
    return { root, main, state, unmerged };
  }

  /** What the task header shows about its worktree: branch, uncommitted changes, unmerged commits. */
  async function worktreeInfo(folder, { base = null } = {}) {
    const { state, unmerged } = await worktreeState(folder, { base });
    return {
      linked: true,
      branch: state.branch,
      dirty: state.files.length > 0,
      changed: state.files.length,
      unmerged,
      upstream: state.upstream,
      ahead: state.ahead,
      main: state.worktree.main,
    };
  }

  /**
   * Merges the worktree's branch into `base` in the checkout it came from (`into`): refused when
   * that checkout has uncommitted changes or is on another branch, and when the worktree has
   * changes that are not committed (they would not be merged). A merge that conflicts is undone
   * at once (git merge --abort), so the main checkout is never left half-merged.
   */
  function mergeWorktree(folder, { base, into } = {}) {
    return serial(async () => {
      if (typeof into !== 'string') throw fail('INVALID_FOLDER', 'This worktree does not know where it came from.');
      const { main, state, unmerged } = await worktreeState(folder, { base, into });
      if (state.detached || !validBranch(state.branch)) throw fail('DETACHED_HEAD', 'The worktree is not on a branch ScaleMax can merge.');
      if (state.files.length) throw fail('WORKTREE_DIRTY', 'The worktree has changes that are not committed, and they would not be merged. Commit them first.');
      const target = await statusOf(main);
      if (target.operation || target.conflicts) throw fail('BUSY_REPOSITORY', `A merge or rebase is in progress in "${path.basename(main)}". Finish it first.`);
      if (target.files.some((file) => file.kind !== 'untracked')) {
        throw fail('MAIN_DIRTY', `"${path.basename(main)}" has uncommitted changes. Commit or stash them there first.`);
      }
      if (target.branch !== base) {
        throw fail('WRONG_BRANCH', `"${path.basename(main)}" is on ${target.branch ? `the branch ${target.branch}` : 'a detached HEAD'}, not ${base}. Switch it to ${base} first.`);
      }
      if (!unmerged) return { merged: false, upToDate: true, base, branch: state.branch, commits: 0 };
      const merged = await act(main, ['merge', '--no-edit', state.branch], TIMEOUTS.merge);
      if (merged.code !== 0) {
        const after = await statusOf(main).catch(() => null);
        const conflicted = after ? after.files.filter((file) => file.kind === 'conflict').map((file) => file.path) : [];
        if (after?.operation === 'merge') await act(main, ['merge', '--abort'], TIMEOUTS.merge);
        if (conflicted.length) {
          throw fail('MERGE_CONFLICTS', `Merging ${state.branch} into ${base} conflicts in ${conflicted.slice(0, 3).join(', ')}${conflicted.length > 3 ? ` and ${conflicted.length - 3} more` : ''}. Nothing was changed; merge it by hand in a terminal.`);
        }
        throw gitFailure(merged, 'The merge did not go through');
      }
      const head = await headInfo(main);
      return { merged: true, base, branch: state.branch, commits: unmerged, head: head.short };
    });
  }

  /**
   * Removes a worktree ScaleMax made (only folders in the worktrees folder). Without `force` it is
   * refused while the worktree has uncommitted changes or commits not in `base`, so the window
   * can ask first. The branch stays (its commits are not lost). Git 2.17+ removes it with
   * `git worktree remove`; older Git gets the folder deleted and `git worktree prune`.
   */
  function removeWorktree(folder, { base = null, force = false } = {}) {
    return serial(async () => {
      const root = await repositoryRoot(folder);
      if (!(await managed(root))) throw fail('NOT_MANAGED', 'Only worktrees ScaleMax made for a task can be removed here.');
      // A base branch that is gone leaves "unmerged" unknown: the branch is kept either way, so
      // only uncommitted changes can be lost.
      const { state, unmerged } = await worktreeState(root, { base }).catch((error) => {
        if (error?.code === 'INVALID_BRANCH') return worktreeState(root);
        throw error;
      });
      if (force !== true) {
        if (state.files.length) throw fail('WORKTREE_DIRTY', `The worktree has ${state.files.length} uncommitted ${state.files.length === 1 ? 'change' : 'changes'} that would be lost.`);
        if (unmerged) throw fail('UNMERGED', `The branch ${state.branch} has ${unmerged} ${unmerged === 1 ? 'commit' : 'commits'} not merged into ${base}. The branch is kept, so they are not lost.`);
      }
      const dirs = await gitDirs(root);
      // Git runs from the main checkout (or the repository's Git folder when it has none).
      const cwd = checkoutOf(dirs.commonDir) || dirs.commonDir;
      if (await hasWorktreeRemove(cwd)) {
        const removed = await act(cwd, ['worktree', 'remove', ...(force === true ? ['--force'] : []), root], TIMEOUTS.worktree);
        if (removed.code !== 0) throw gitFailure(removed, 'Could not remove the worktree');
      } else {
        // Re-checked right before deleting: still the same managed, linked worktree folder.
        const marker = await fsp.lstat(path.join(root, '.git'));
        if (!marker.isFile() || !(await managed(root))) throw fail('NOT_MANAGED', 'Only worktrees ScaleMax made for a task can be removed here.');
        await fsp.rm(root, { recursive: true, force: false });
        const pruned = await act(cwd, ['worktree', 'prune'], TIMEOUTS.worktree);
        if (pruned.code !== 0) throw gitFailure(pruned, 'The folder is gone, but Git could not forget the worktree');
      }
      if (await exists(root)) throw fail('GIT_ERROR', 'The worktree folder is still there.');
      return { removed: true, branch: state.branch };
    });
  }

  // ---- Pull requests (GitHub CLI) ------------------------------------------------------------

  /**
   * Pushes the branch when the remote does not have it yet (or is behind), then
   * `gh pr create --title … --body-file - --head <branch> [--base …]`. Returns the PR's address.
   * @param {{ title: string, body?: string, base?: string|null, draft?: boolean }} input
   */
  function createPullRequest(folder, input = {}) {
    return serial(async () => {
      const gh = ghPath();
      if (typeof gh !== 'string' || !path.isAbsolute(gh)) {
        throw fail('GH_MISSING', 'Pull requests need the GitHub CLI. Connect GitHub in Experts & resources (it installs the CLI) or install gh.');
      }
      const title = typeof input.title === 'string' ? input.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
      if (!title || title.length > MAX_TITLE) throw fail('INVALID_TITLE', 'Give the pull request a title of at most 256 characters.');
      const body = typeof input.body === 'string' ? input.body.replace(/\0/g, '') : '';
      if (body.length > MAX_BODY) throw fail('INVALID_BODY', 'The description is too long.');
      const base = input.base === undefined || input.base === null || input.base === '' ? null : input.base;
      if (base !== null && !validBranch(base)) throw fail('INVALID_BRANCH', 'The base branch name is not valid.');
      const root = await repositoryRoot(folder);
      let state = await statusOf(root);
      if (state.detached || !state.branch) throw fail('DETACHED_HEAD', 'HEAD is detached (not on a branch). Create a branch for the pull request.');
      if (!validBranch(state.branch)) throw fail('INVALID_BRANCH', 'Open this pull request from a terminal: the branch name is unusual.');
      if (base !== null && base === state.branch) throw fail('INVALID_BRANCH', 'The pull request needs a base branch other than the one it comes from.');
      let pushed = false;
      if (!state.upstream || state.ahead > 0) {
        await pushNow(root, state);
        pushed = true;
        state = await statusOf(root);
      }
      const environment = { ...(typeof ghEnv === 'function' ? ghEnv() : baseEnvironment()), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
      const args = ['pr', 'create', `--title=${title}`, '--body-file', '-', `--head=${state.branch}`, ...(base !== null ? [`--base=${base}`] : []), ...(input.draft === true ? ['--draft'] : [])];
      const result = await exec(gh, args, { cwd: root, timeoutMs: TIMEOUTS.gh, input: body, environment });
      const lines = `${result.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean);
      const url = [...lines].reverse().find((line) => /^https:\/\/\S+$/.test(line));
      if (result.code !== 0 || !url) {
        const detail = tail(result.stderr) || tail(result.stdout) || `exit code ${result.code}`;
        throw fail('GH_ERROR', `GitHub did not create the pull request: ${detail}`);
      }
      let address;
      try { address = new URL(url); } catch { throw fail('GH_ERROR', 'GitHub answered with an address that is not valid.'); }
      if (address.protocol !== 'https:') throw fail('GH_ERROR', 'GitHub answered with an address that is not https.');
      return { url: address.href, branch: state.branch, base, pushed };
    });
  }

  return {
    status, branches, summaryInput, commit, push, pull, switchBranch,
    createWorktree, worktreeInfo, mergeWorktree, removeWorktree, createPullRequest,
    managed,
  };
}

module.exports = {
  createGitFlow, slugify, validBranch, defaultCommitMessage, commitSubject, parseStatus, TIMEOUTS,
};
