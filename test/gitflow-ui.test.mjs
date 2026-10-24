import test from 'node:test';
import assert from 'node:assert/strict';

// src/gitflow-ui.js touches the page only through document.querySelector; with no page there is
// nothing to draw, and what it remembers about tasks can be checked on its own.
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
globalThis.window ??= {};
const { syncWorktreeBranch, leftBehindNote } = await import('../src/gitflow-ui.js');

function fakeApp(tasks) {
  return { tasks, persisted: [], notices: 0, persist(key) { this.persisted.push(key); return Promise.resolve(); }, renderTaskFolderNotice() { this.notices += 1; } };
}
const worktree = (overrides = {}) => ({
  path: '/wt/api-task-1', branch: 'scalemax/add-health', base: 'main', mainRoot: '/repo/api', mainName: 'api', createdAt: 1, ...overrides,
});

test('a task worktree that moved to another branch is remembered on that branch, by every task working there', () => {
  const app = fakeApp([
    { id: 't1', worktree: worktree() },
    { id: 't2', worktree: worktree() },
    { id: 't3', worktree: worktree({ path: '/wt/api-task-3', branch: 'scalemax/other' }) },
    { id: 't4' },
  ]);
  assert.equal(syncWorktreeBranch(app, '/wt/api-task-1', 'feature/health'), true);
  assert.deepEqual(app.tasks.map((task) => task.worktree?.branch), ['feature/health', 'feature/health', 'scalemax/other', undefined]);
  assert.equal(app.tasks[0].worktree.base, 'main', 'the rest of what it knows stays');
  assert.deepEqual(app.persisted, ['tasks']);
  assert.equal(app.notices, 1, 'the notice after removal names the branch Git has');
  // Nothing to change: no save.
  assert.equal(syncWorktreeBranch(app, '/wt/api-task-1', 'feature/health'), false);
  // A detached HEAD (no branch) or a name that is no branch changes nothing.
  assert.equal(syncWorktreeBranch(app, '/wt/api-task-1', null), false);
  assert.equal(syncWorktreeBranch(app, '/wt/api-task-1', 'has space'), false);
  assert.deepEqual(app.persisted, ['tasks']);
});

test('the commit says what became of the branch a new one replaced', () => {
  assert.equal(leftBehindNote({ branch: 'feature/health' }), '');
  assert.equal(leftBehindNote({ branch: 'feature/health', previous: { branch: 'scalemax/add-health', deleted: true, commits: 0 } }),
    'scalemax/add-health had no commits of its own, so it was deleted.');
  assert.equal(leftBehindNote({ branch: 'feature/health', previous: { branch: 'scalemax/add-health', deleted: false, commits: 2 } }),
    'scalemax/add-health is kept: its 2 commits are on feature/health too.');
  assert.equal(leftBehindNote({ branch: 'feature/health', previous: { branch: 'scalemax/add-health', deleted: false, commits: 0, pushed: true } }),
    'scalemax/add-health is kept: it was pushed.');
  assert.equal(leftBehindNote({ branch: 'feature/health', previous: { branch: 'scalemax/add-health', deleted: false, commits: null } }),
    'scalemax/add-health is kept.');
});
