'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createGitFlow, slugify, validBranch, defaultCommitMessage, commitSubject, parseStatus,
} = require('../lib/git-flow.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');
const { commandLine } = require('../lib/commands.cjs');
const sandbox = require('../lib/sandbox.cjs');

const macSandbox = { skip: !sandbox.available() && 'needs macOS sandbox-exec' };

// Throwaway folders under /private/tmp (the canonical path: /tmp is a link on macOS).
function folder(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/private/tmp', prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A test identity in a home folder of its own. GIT_CONFIG_GLOBAL names the file for Git 2.32+;
// older Git (the 2.15 on the development Mac) reads $HOME/.gitconfig, the same file.
function identity(t) {
  const home = folder(t, 'sm-gf-home-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.invalid\n[advice]\n\tdetachedHead = false\n');
  return {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', LANG: 'en_US.UTF-8',
  };
}
function git(cwd, env, ...args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
// A repository with one commit, and a flow whose worktrees go to a folder of the test.
function setup(t, { gh = null, ghEnv = null, gitVersion = null } = {}) {
  const env = identity(t);
  const root = folder(t, 'sm-gf-repo-');
  git(root, env, 'init', '-q');
  write(root, 'README.md', '# Demo\n');
  write(root, 'src/app.js', 'export const answer = 41;\n');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'Initial commit');
  const base = git(root, env, 'symbolic-ref', '--short', 'HEAD');
  const appData = folder(t, 'sm-gf-appdata-');
  const worktreesDir = path.join(appData, 'worktrees');
  const flow = createGitFlow({ env, worktreesDir, ghPath: () => gh, ...(ghEnv ? { ghEnv } : {}), gitVersion });
  return { env, root, base, appData, worktreesDir, flow };
}
const realGitVersion = (() => {
  const match = /(\d+)\.(\d+)/.exec(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout || '');
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
})();

test('branch names come from task titles and must pass the branch rules', () => {
  assert.equal(slugify('Fix the login form!'), 'fix-the-login-form');
  assert.equal(slugify('  Ünïcode — café crème  '), 'unicode-cafe-creme');
  assert.equal(slugify('!!!'), 'task');
  assert.equal(slugify('a very long title that keeps going and going well past forty characters'), 'a-very-long-title-that-keeps-going-and');
  for (const name of ['main', 'scalemax/fix-login', 'release-1.2', 'feature/a_b']) assert.equal(validBranch(name), true, name);
  for (const name of ['-x', '.hidden', 'a..b', 'a//b', 'a/.b', 'a.lock', 'a/', 'with space', 'a@{b', 'x.', '', 'é']) assert.equal(validBranch(name), false, name);
});

test('a commit message without a provider describes the files; a model answer becomes one clean line', () => {
  assert.equal(defaultCommitMessage([{ path: 'src/app.js', kind: 'changed', index: '.', worktree: 'M' }]), 'chore: update app.js');
  assert.equal(defaultCommitMessage([{ path: 'notes/', kind: 'untracked', index: '?', worktree: '?' }]), 'chore: add notes');
  assert.equal(defaultCommitMessage([{ path: 'old.txt', kind: 'changed', index: '.', worktree: 'D' }]), 'chore: remove old.txt');
  assert.equal(defaultCommitMessage([{ path: 'a', kind: 'untracked' }, { path: 'b', kind: 'untracked' }]), 'chore: add 2 files');
  assert.equal(defaultCommitMessage([{ path: 'a', kind: 'changed' }, { path: 'b', kind: 'untracked' }]), 'chore: update 2 files');
  assert.equal(defaultCommitMessage([]), '');
  assert.equal(commitSubject('```\nfix(parser): handle empty input\n```'), 'fix(parser): handle empty input');
  assert.equal(commitSubject('Commit message: "feat: add dark mode"'), 'feat: add dark mode');
  assert.equal(commitSubject(`feat: ${'x'.repeat(200)}`).length <= 100, true);
});

test('porcelain v2 status: branch, upstream, ahead/behind, renames, conflicts, untracked folders', () => {
  const text = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/a file.js',
    '2 R. N... 100644 100644 100644 bbbbbbb bbbbbbb R100 new name.js', 'old name.js',
    'u UU N... 100644 100644 100644 100644 ccccccc ddddddd eeeeeee conflict.txt',
    '? notes/', '',
  ].join('\0');
  const state = parseStatus(text);
  assert.deepEqual({ branch: state.branch, upstream: state.upstream, ahead: state.ahead, behind: state.behind, detached: state.detached, unborn: state.unborn },
    { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false, unborn: false });
  assert.deepEqual(state.files, [
    { path: 'src/a file.js', index: '.', worktree: 'M', kind: 'changed' },
    { path: 'new name.js', from: 'old name.js', index: 'R', worktree: '.', kind: 'renamed' },
    { path: 'conflict.txt', index: 'U', worktree: 'U', kind: 'conflict' },
    { path: 'notes/', index: '?', worktree: '?', kind: 'untracked' },
  ]);
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').unborn, true);
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').detached, true);
});

test('status of a repository: branch, files, identity; not a repository; not its top folder; a link', async (t) => {
  const { flow, root, base, env } = setup(t);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  write(root, 'notes/todo.md', '- a\n');
  write(root, '.env', 'KEY=secret\n');
  const state = await flow.status(root);
  assert.equal(state.isRepo, true);
  assert.equal(state.branch, base);
  assert.equal(state.upstream, null);
  assert.deepEqual(state.identity, { name: 'Test Person', email: 'test@example.invalid' });
  assert.deepEqual(state.files.map((file) => `${file.kind}:${file.path}:${file.secret}`).sort(),
    ['changed:src/app.js:false', 'untracked:.env:true', 'untracked:notes/:false']);
  assert.deepEqual(state.worktree, { linked: false, main: null });
  assert.deepEqual(await flow.status(folder(t, 'sm-gf-plain-')), { isRepo: false });
  await assert.rejects(flow.commit(path.join(root, 'src'), { paths: ['src/app.js'], message: 'x' }), { code: 'NOT_REPOSITORY' });
  const link = path.join(folder(t, 'sm-gf-link-'), 'repo');
  fs.symlinkSync(root, link);
  await assert.rejects(flow.status(link), { code: 'SYMLINK' });
  await assert.rejects(flow.status('relative/path'), { code: 'INVALID_FOLDER' });
  // Variables that would point Git elsewhere are not passed on.
  const misdirected = createGitFlow({ env: { ...env, GIT_DIR: '/private/tmp/nowhere', GIT_WORK_TREE: '/private/tmp' } });
  assert.equal((await misdirected.status(root)).branch, base);
});

test('commit: only the chosen files, the message as written, the user\'s identity', async (t) => {
  const { flow, root, env } = setup(t);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  write(root, 'README.md', '# Demo, changed\n');
  write(root, 'docs/new/guide.md', '# Guide\n');
  fs.rmSync(path.join(root, 'README.md'));
  const message = '-n starts like an option $(touch pwned)\n\nBody line with `ticks`';
  const done = await flow.commit(root, { paths: ['src/app.js', 'docs/', 'README.md'], message });
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  assert.equal(done.subject, '-n starts like an option $(touch pwned)');
  assert.equal(done.files, 3);
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false, 'the message never reached a shell');
  assert.equal(git(root, env, 'log', '-1', '--format=%an <%ae>'), 'Test Person <test@example.invalid>');
  assert.equal(git(root, env, 'log', '-1', '--format=%B'), message);
  assert.deepEqual(git(root, env, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tdocs/new/guide.md', 'D\tREADME.md', 'M\tsrc/app.js']);

  // Something staged before but not chosen stays out of the commit (and staged).
  write(root, 'staged.txt', 'staged\n');
  git(root, env, 'add', 'staged.txt');
  write(root, 'chosen.txt', 'chosen\n');
  await flow.commit(root, { paths: ['chosen.txt'], message: 'Add chosen' });
  assert.equal(git(root, env, 'show', '--name-only', '--format=', 'HEAD'), 'chosen.txt');
  assert.equal(git(root, env, 'diff', '--cached', '--name-only'), 'staged.txt');

  // Paths are exactly those files: "[draft]" is no glob, and a hook's own pathspecs keep working.
  write(root, 'notes [draft].md', 'draft\n');
  write(root, 'notes d.md', 'd\n');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit diff --cached --name-only -- "*.md" > "$(git rev-parse --git-dir)/hook-saw.txt"\n', { mode: 0o755 });
  await flow.commit(root, { paths: ['notes [draft].md'], message: 'Add the draft' });
  assert.equal(git(root, env, 'show', '--name-only', '--format=', 'HEAD'), 'notes [draft].md');
  assert.equal(fs.readFileSync(path.join(root, '.git', 'hook-saw.txt'), 'utf8').trim(), 'notes [draft].md', 'the hook\'s "*.md" was still a glob');
  assert.equal((await flow.status(root)).files.some((file) => file.path === 'notes d.md'), true);

  await assert.rejects(flow.commit(root, { paths: ['not-changed.txt'], message: 'x' }), { code: 'INVALID_PATHS' });
  await assert.rejects(flow.commit(root, { paths: ['staged.txt'], message: '   ' }), { code: 'INVALID_MESSAGE' });
  await assert.rejects(flow.commit(root, { paths: [], message: 'x' }), { code: 'INVALID_PATHS' });
  await assert.rejects(flow.commit(root, { paths: ['--all'], message: 'x' }), { code: 'INVALID_PATHS' });
});

test('commit hooks run, and only "Skip hooks" skips them', async (t) => {
  const { flow, root, env } = setup(t);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: fix src/app.js" >&2\nexit 1\n', { mode: 0o755 });
  write(root, 'src/app.js', 'export const answer = 42;\n');
  await assert.rejects(flow.commit(root, { paths: ['src/app.js'], message: 'fix: answer' }), (error) => {
    assert.equal(error.code, 'GIT_ERROR');
    assert.match(error.message, /commit hook/);
    assert.match(error.message, /lint failed: fix src\/app\.js/);
    return true;
  });
  assert.equal(git(root, env, 'rev-list', '--count', 'HEAD'), '1');
  const done = await flow.commit(root, { paths: ['src/app.js'], message: 'fix: answer', skipHooks: true });
  assert.equal(done.subject, 'fix: answer');
  assert.equal(git(root, env, 'rev-list', '--count', 'HEAD'), '2');
});

test('a program left running in the background (an SSH ControlPersist master) does not hold the action', async (t) => {
  const { flow, root } = setup(t);
  // The hook's background sleep keeps Git's output pipes open for 37 seconds.
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 37 &\necho checked\nexit 0\n', { mode: 0o755 });
  t.after(() => {
    const listed = spawnSync('/bin/ps', ['-A', '-o', 'pid=,command=']).stdout.toString().split('\n');
    for (const line of listed) if (/^\s*\d+\s+sleep 37$/.test(line)) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* ended */ } }
  });
  write(root, 'src/app.js', 'export const answer = 42;\n');
  const started = Date.now();
  const done = await flow.commit(root, { paths: ['src/app.js'], message: 'fix: answer' });
  assert.equal(done.subject, 'fix: answer');
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
});

test('a new branch first; a detached HEAD needs one; conflicts are refused', async (t) => {
  const { flow, root, base, env } = setup(t);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  for (const name of ['-x', 'a..b', 'with space']) {
    await assert.rejects(flow.commit(root, { paths: ['src/app.js'], message: 'x', branch: name }), { code: 'INVALID_BRANCH' });
  }
  await assert.rejects(flow.commit(root, { paths: ['src/app.js'], message: 'x', branch: base }), { code: 'BRANCH_EXISTS' });
  const done = await flow.commit(root, { paths: ['src/app.js'], message: 'feat: answer', branch: 'scalemax/new-answer' });
  assert.equal(done.branch, 'scalemax/new-answer');
  assert.equal(git(root, env, 'rev-list', '--count', base), '1', 'the base branch did not move');

  git(root, env, 'checkout', '-q', '--detach', 'HEAD');
  write(root, 'README.md', '# Detached\n');
  await assert.rejects(flow.commit(root, { paths: ['README.md'], message: 'docs' }), { code: 'DETACHED_HEAD' });
  const rescued = await flow.commit(root, { paths: ['README.md'], message: 'docs', branch: 'scalemax/rescued' });
  assert.equal(rescued.branch, 'scalemax/rescued');

  // A merge that stopped with a conflict.
  git(root, env, 'checkout', '-q', base);
  write(root, 'src/app.js', 'export const answer = 7;\n');
  git(root, env, 'commit', '-q', '-am', 'seven');
  const merge = spawnSync('git', ['merge', 'scalemax/new-answer'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(merge.status, 0);
  const state = await flow.status(root);
  assert.equal(state.conflicts, 1);
  assert.equal(state.operation, 'merge');
  await assert.rejects(flow.commit(root, { paths: ['src/app.js'], message: 'merge' }), { code: 'CONFLICTS' });
  // Resolved: a merge is committed whole.
  write(root, 'src/app.js', 'export const answer = 42;\n');
  git(root, env, 'add', 'src/app.js');
  write(root, 'other.txt', 'x\n');
  git(root, env, 'add', 'other.txt');
  await assert.rejects(flow.commit(root, { paths: ['src/app.js'], message: 'merge' }), { code: 'MERGE_IN_PROGRESS' });
  const merged = await flow.commit(root, { paths: ['src/app.js', 'other.txt'], message: 'Merge new answer' });
  assert.equal(merged.subject, 'Merge new answer');
  assert.equal(git(root, env, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a real merge commit');
});

test('push sets the upstream once, pull only fast-forwards, nothing is forced', async (t) => {
  const { flow, root, base, env } = setup(t);
  await assert.rejects(flow.push(root), { code: 'NO_REMOTE' });
  const remote = folder(t, 'sm-gf-remote-');
  git(remote, env, 'init', '-q', '--bare');
  git(root, env, 'remote', 'add', 'origin', remote);
  await assert.rejects(flow.pull(root), { code: 'NO_UPSTREAM' });
  const pushed = await flow.push(root);
  assert.equal(pushed.upstream, `origin/${base}`);
  assert.equal(pushed.ahead, 0);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  await flow.commit(root, { paths: ['src/app.js'], message: 'fix: answer' });
  assert.equal((await flow.status(root)).ahead, 1);
  assert.equal((await flow.push(root)).ahead, 0);

  // Someone else pushes; pull brings it in.
  const other = path.join(folder(t, 'sm-gf-clone-'), 'clone');
  git(path.dirname(other), env, 'clone', '-q', remote, other);
  write(other, 'from-other.txt', 'hello\n');
  git(other, env, 'add', '-A');
  git(other, env, 'commit', '-q', '-m', 'from the other clone');
  git(other, env, 'push', '-q', 'origin', `HEAD:${base}`);
  const pulled = await flow.pull(root);
  assert.equal(pulled.behind, 0);
  assert.equal(fs.readFileSync(path.join(root, 'from-other.txt'), 'utf8'), 'hello\n');

  // Both sides moved on: no merge commit is made behind the user's back.
  write(other, 'from-other.txt', 'again\n');
  git(other, env, 'commit', '-q', '-am', 'again');
  git(other, env, 'push', '-q', 'origin', `HEAD:${base}`);
  write(root, 'local.txt', 'local\n');
  await flow.commit(root, { paths: ['local.txt'], message: 'local' });
  await assert.rejects(flow.pull(root), { code: 'DIVERGED' });
  await assert.rejects(flow.push(root), { code: 'GIT_ERROR' });
  assert.equal(git(root, env, 'rev-list', '--count', 'HEAD'), '4');
});

test('switching branch: refused with uncommitted changes unless they are stashed', async (t) => {
  const { flow, root, base, env } = setup(t);
  git(root, env, 'branch', 'feature');
  const listed = await flow.branches(root);
  assert.deepEqual(listed.branches.map((item) => item.name), [base, 'feature'].sort());
  assert.equal(listed.current, base);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  assert.equal((await flow.branches(root)).dirty, true);
  await assert.rejects(flow.switchBranch(root, { branch: 'feature' }), { code: 'DIRTY' });
  await assert.rejects(flow.switchBranch(root, { branch: 'nope', stash: true }), { code: 'INVALID_BRANCH' });
  await assert.rejects(flow.switchBranch(root, { branch: '--orphan' }), { code: 'INVALID_BRANCH' });
  const switched = await flow.switchBranch(root, { branch: 'feature', stash: true });
  assert.deepEqual(switched, { branch: 'feature', stashed: true });
  assert.equal(git(root, env, 'symbolic-ref', '--short', 'HEAD'), 'feature');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'export const answer = 41;\n');
  assert.match(git(root, env, 'stash', 'list'), /ScaleMax: before switching to feature/);
  // Untracked files alone do not hold a switch.
  write(root, 'scratch.txt', 'x\n');
  assert.deepEqual(await flow.switchBranch(root, { branch: base }), { branch: base, stashed: false });
});

test('what a commit message is written from leaves secret files out', async (t) => {
  const { flow, root } = setup(t);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  write(root, '.env', 'API_KEY=do-not-send\n');
  const input = await flow.summaryInput(root, ['src/app.js', '.env']);
  assert.equal(input.leftOut, 1);
  assert.match(input.diff, /\+export const answer = 42;/);
  assert.equal(input.diff.includes('do-not-send'), false);
  assert.deepEqual(input.files.map((file) => [file.path, Boolean(file.secret)]), [['src/app.js', false], ['.env', true]]);
  assert.equal(input.fallback, 'chore: update 2 files');
});

test('a task worktree: made outside the project, accepted by the workspace, merged back, removed', async (t) => {
  const { flow, root, base, env, worktreesDir } = setup(t, { gitVersion: [2, 15, 0] });
  const made = await flow.createWorktree(root, { taskId: 'task-1-abc', title: 'Fix the answer' });
  assert.equal(made.branch, 'scalemax/fix-the-answer');
  assert.equal(made.base, base);
  assert.equal(made.mainRoot, root);
  assert.equal(made.path, path.join(fs.realpathSync(worktreesDir), `${path.basename(root)}-task-1-abc`));
  assert.equal(made.name, `${path.basename(root)} (fix-the-answer)`);
  assert.equal(fs.statSync(path.join(made.path, '.git')).isFile(), true, 'a linked worktree: its .git is a file');
  // The same title again gets its own branch; the same task cannot get a second worktree.
  const second = await flow.createWorktree(root, { taskId: 'task-2-abc', title: 'Fix the answer' });
  assert.equal(second.branch, 'scalemax/fix-the-answer-2');
  await assert.rejects(flow.createWorktree(root, { taskId: 'task-1-abc', title: 'x' }), { code: 'EXISTS' });
  await assert.rejects(flow.createWorktree(root, { taskId: '../escape', title: 'x' }), { code: 'INVALID_TASK' });

  // lib/workspace.cjs (the window and the model's tools) opens it like any repository.
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(made.path);
  write(made.path, 'src/app.js', 'export const answer = 42;\n');
  const panel = await workspace.gitStatus();
  assert.equal(panel.isRepo, true);
  assert.equal(panel.branch, 'scalemax/fix-the-answer');
  assert.deepEqual(panel.files, [{ status: ' M', path: 'src/app.js' }]);
  assert.match(await workspace.gitDiff('src/app.js'), /\+export const answer = 42;/);

  const status = await flow.status(made.path);
  assert.deepEqual(status.worktree, { linked: true, main: root });
  await assert.rejects(flow.mergeWorktree(made.path, { base, into: root }), { code: 'WORKTREE_DIRTY' });
  await flow.commit(made.path, { paths: ['src/app.js'], message: 'fix: the answer is 42' });
  const info = await flow.worktreeInfo(made.path, { base });
  assert.equal(info.unmerged, 1);
  assert.equal(info.dirty, false);

  // The checkout it came from must be clean, on the base branch, and really its origin.
  write(root, 'README.md', '# Busy\n');
  await assert.rejects(flow.mergeWorktree(made.path, { base, into: root }), { code: 'MAIN_DIRTY' });
  git(root, env, 'checkout', '-q', '--', 'README.md');
  await assert.rejects(flow.mergeWorktree(made.path, { base, into: second.path }), { code: 'WRONG_BRANCH' });
  const stranger = setup(t);
  await assert.rejects(flow.mergeWorktree(made.path, { base, into: stranger.root }), { code: 'NOT_WORKTREE' });
  const merged = await flow.mergeWorktree(made.path, { base, into: root });
  assert.equal(merged.merged, true);
  assert.equal(merged.commits, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'export const answer = 42;\n');
  assert.equal((await flow.worktreeInfo(made.path, { base })).unmerged, 0);
  assert.equal((await flow.mergeWorktree(made.path, { base, into: root })).upToDate, true);

  // Removing: refused while there is something to lose, then forced; the branch stays.
  write(made.path, 'wip.txt', 'not committed\n');
  await assert.rejects(flow.removeWorktree(made.path, { base }), { code: 'WORKTREE_DIRTY' });
  const removed = await flow.removeWorktree(made.path, { base, force: true });
  assert.deepEqual(removed, { removed: true, branch: 'scalemax/fix-the-answer' });
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git(root, env, 'worktree', 'list', '--porcelain').includes(made.path), false, 'Git forgot it (pruned)');
  assert.equal(git(root, env, 'rev-parse', '--verify', '--quiet', 'refs/heads/scalemax/fix-the-answer').length, 40);
  // Unmerged commits ask first too.
  write(second.path, 'second.txt', 'two\n');
  await flow.commit(second.path, { paths: ['second.txt'], message: 'second' });
  await assert.rejects(flow.removeWorktree(second.path, { base }), { code: 'UNMERGED' });
  // Only worktrees ScaleMax made can be removed from here.
  const outside = path.join(folder(t, 'sm-gf-outside-'), 'wt');
  git(root, env, 'worktree', 'add', '-b', 'elsewhere', outside, 'HEAD');
  await assert.rejects(flow.removeWorktree(outside, { force: true }), { code: 'NOT_MANAGED' });
  assert.equal(fs.existsSync(outside), true);
});

test('removing follows the Git on PATH: git worktree remove from 2.17, the folder and a prune before', async (t) => {
  // No version given: the flow asks Git (2.15 on the development Mac takes the older way).
  const { flow, root, env } = setup(t);
  const made = await flow.createWorktree(root, { taskId: 'task-9-zz', title: 'native remove' });
  write(made.path, 'untracked.txt', 'x\n');
  assert.deepEqual(await flow.removeWorktree(made.path, { force: true }), { removed: true, branch: 'scalemax/native-remove' });
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git(root, env, 'worktree', 'list', '--porcelain').includes(made.path), false);
  const native = realGitVersion[0] > 2 || (realGitVersion[0] === 2 && realGitVersion[1] >= 17);
  const help = spawnSync('git', ['worktree', 'remove'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(/usage: git worktree remove/.test(`${help.stdout}${help.stderr}`), native, 'the version check matches what this Git can do');
});

test('a merge that conflicts is undone at once: the main checkout is never left half-merged', async (t) => {
  const { flow, root, base, env } = setup(t);
  const made = await flow.createWorktree(root, { taskId: 'task-3-abc', title: 'conflicting' });
  write(made.path, 'src/app.js', 'export const answer = 1;\n');
  await flow.commit(made.path, { paths: ['src/app.js'], message: 'one' });
  write(root, 'src/app.js', 'export const answer = 2;\n');
  git(root, env, 'commit', '-q', '-am', 'two');
  await assert.rejects(flow.mergeWorktree(made.path, { base, into: root }), (error) => {
    assert.equal(error.code, 'MERGE_CONFLICTS');
    assert.match(error.message, /src\/app\.js/);
    return true;
  });
  const state = await flow.status(root);
  assert.equal(state.operation, null);
  assert.equal(state.files.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'export const answer = 2;\n');
});

test('a pull request: pushed first, then the GitHub CLI with the title, body and base (gh stubbed)', async (t) => {
  const stubDir = folder(t, 'sm-gf-gh-');
  const gh = path.join(stubDir, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_FILE"\ncat > "$GH_BODY_FILE"\npwd > "$GH_CWD_FILE"\necho "Creating pull request"\necho "https://github.com/example/demo/pull/7"\n', { mode: 0o755 });
  const files = { GH_ARGS_FILE: path.join(stubDir, 'args'), GH_BODY_FILE: path.join(stubDir, 'body'), GH_CWD_FILE: path.join(stubDir, 'cwd') };
  let ghEnvironment = null;
  const { flow, root, base, env } = setup(t, { gh, ghEnv: () => ({ ...ghEnvironment, ...files }) });
  ghEnvironment = env;
  const remote = folder(t, 'sm-gf-remote-');
  git(remote, env, 'init', '-q', '--bare');
  git(root, env, 'remote', 'add', 'origin', remote);
  await flow.push(root);
  write(root, 'src/app.js', 'export const answer = 42;\n');
  await flow.commit(root, { paths: ['src/app.js'], message: 'fix: answer', branch: 'scalemax/answer' });
  const created = await flow.createPullRequest(root, { title: '--fix: answer', body: 'Line one\n$(not run)', base });
  assert.deepEqual(created, { url: 'https://github.com/example/demo/pull/7', branch: 'scalemax/answer', base, pushed: true });
  assert.deepEqual(fs.readFileSync(files.GH_ARGS_FILE, 'utf8').trim().split('\n'),
    ['pr', 'create', '--title=--fix: answer', '--body-file', '-', '--head=scalemax/answer', `--base=${base}`]);
  assert.equal(fs.readFileSync(files.GH_BODY_FILE, 'utf8'), 'Line one\n$(not run)');
  assert.equal(fs.realpathSync(fs.readFileSync(files.GH_CWD_FILE, 'utf8').trim()), root);
  assert.equal(git(remote, env, 'rev-parse', 'refs/heads/scalemax/answer'), git(root, env, 'rev-parse', 'HEAD'), 'the branch was pushed first');

  await assert.rejects(flow.createPullRequest(root, { title: '' }), { code: 'INVALID_TITLE' });
  await assert.rejects(flow.createPullRequest(root, { title: 'x', base: 'scalemax/answer' }), { code: 'INVALID_BRANCH' });
  const missing = createGitFlow({ env, ghPath: () => null });
  await assert.rejects(missing.createPullRequest(root, { title: 'x' }), { code: 'GH_MISSING' });
  fs.writeFileSync(gh, '#!/bin/sh\necho "pull request create failed: GraphQL: No commits between main and x" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(flow.createPullRequest(root, { title: 'again' }), (error) => {
    assert.equal(error.code, 'GH_ERROR');
    assert.match(error.message, /No commits between/);
    return true;
  });
});

test('inside the sandbox: a task worktree in the app data folder works, the main checkout\'s Git folder stays closed', macSandbox, async (t) => {
  const { flow, root, appData } = setup(t);
  const made = await flow.createWorktree(root, { taskId: 'task-5-abc', title: 'sandboxed' });
  fs.writeFileSync(path.join(appData, 'state.json'), 'secret');
  const other = path.join(appData, 'worktrees', 'other-task');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'file.txt'), 'another task');
  const run = (command) => {
    const { file, args } = commandLine(command, { box: { project: made.path, network: true, appData } });
    return spawnSync(file, args, { cwd: made.path, encoding: 'utf8' });
  };
  const linked = sandbox.linkedGitDirs(made.path);
  assert.deepEqual(linked, { common: path.join(root, '.git'), admin: path.join(root, '.git', 'worktrees', path.basename(made.path)) });
  const { args } = commandLine('true', { box: { project: made.path, network: true, appData } });
  assert.ok(args.includes(`GITDIR=${path.join(root, '.git')}`));
  // Its own folder works although it is inside the app data folder.
  assert.equal(run('echo inside > made.txt && cat src/app.js').status, 0);
  assert.equal(run('git status --porcelain').status, 0);
  // The rest of ScaleMax's data, other worktrees included, stays closed.
  assert.notEqual(run(`cat ${JSON.stringify(path.join(appData, 'state.json'))}`).status, 0);
  assert.notEqual(run(`cat ${JSON.stringify(path.join(other, 'file.txt'))}`).status, 0);
  // The main checkout's Git folder is closed although /private/tmp is writable: hooks, config,
  // the worktree's admin folder (commondir, gitdir) and the history itself.
  for (const target of ['hooks/pre-commit', 'config', 'commondir', `worktrees/${path.basename(made.path)}/commondir`, `worktrees/${path.basename(made.path)}/gitdir`, 'refs/heads/sneaky']) {
    const refused = run(`echo x > ${JSON.stringify(path.join(root, '.git', target))}`);
    assert.notEqual(refused.status, 0, target);
    assert.match(refused.stderr, /operation not permitted/i, target);
  }
  const commit = run('git add made.txt && git commit -q -m sneaky');
  assert.notEqual(commit.status, 0, 'no commits from a sandboxed command in a worktree');
  assert.notEqual(run('echo gitdir: /private/tmp > .git').status, 0, 'the .git file cannot be redirected');
  // The user's own Commit button (outside the sandbox) can.
  assert.equal((await flow.commit(made.path, { paths: ['made.txt'], message: 'user commit' })).subject, 'user commit');
  assert.match(sandbox.refusalHint('Operation not permitted'), /separate worktree/);
});
