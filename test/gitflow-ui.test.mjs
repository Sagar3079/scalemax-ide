import test from 'node:test';
import assert from 'node:assert/strict';

// src/gitflow-ui.js touches the page only through document.querySelector; with no page there is
// nothing to draw, and what it remembers about tasks can be checked on its own.
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
globalThis.window ??= {};
const {
  syncWorktreeBranch, leftBehindNote, uniqueBranchName, pullMessage, fetchStateText, agoText, menuMove, removeQuestion, mergeQuestion,
} = await import('../src/gitflow-ui.js');

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

test('a suggested new branch is never one that exists', () => {
  const taken = new Set(['main', 'scalemax/add-health', 'scalemax/add-health-2']);
  assert.equal(uniqueBranchName('scalemax/fix-login', taken), 'scalemax/fix-login');
  assert.equal(uniqueBranchName('scalemax/add-health', taken), 'scalemax/add-health-3');
  assert.equal(uniqueBranchName('main', ['main']), 'main-2');
  assert.equal(uniqueBranchName('x', null), 'x');
});

test('Pull says what it did; the Git panel says when it last fetched', () => {
  assert.equal(pullMessage({ upstream: 'origin/main', pulled: 1 }), 'Pulled 1 commit from origin/main');
  assert.equal(pullMessage({ upstream: 'origin/main', pulled: 3 }), 'Pulled 3 commits from origin/main');
  assert.equal(pullMessage({ upstream: 'origin/main', pulled: 0, upToDate: true }), 'Already up to date with origin/main');
  assert.equal(pullMessage({ upstream: 'origin/main', pulled: null }), 'Pulled from origin/main');
  const now = 1_000_000_000;
  assert.equal(agoText(now - 5_000, now), 'just now');
  assert.equal(agoText(now - 3 * 60_000, now), '3 min ago');
  assert.equal(agoText(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(agoText(now - 30 * 3_600_000, now), 'over a day ago');
  assert.equal(fetchStateText(null), '');
  assert.equal(fetchStateText({ running: true, at: now }), 'Fetching…');
  assert.equal(fetchStateText({ at: now - 1000 }, now), 'Fetched just now');
  // A failure in a few words (Git's own message is the tooltip).
  assert.equal(fetchStateText({ at: now, error: 'Could not reach the remote: fatal: unable to access …', code: 'FETCH_OFFLINE' }, now), 'Could not fetch: the remote did not answer');
  assert.equal(fetchStateText({ error: 'Fetching needs you to sign in…', code: 'FETCH_AUTH' }), 'Could not fetch: the remote wants you to sign in');
  assert.equal(fetchStateText({ error: 'Could not fetch: fatal: something', code: 'GIT_ERROR' }), 'Could not fetch');
  assert.equal(fetchStateText({ none: true }), 'No remote to fetch from');
  assert.equal(fetchStateText({}), '');
});

test('the worktree "More" menu: arrow keys wrap, Home and End go to the ends, other keys do nothing', () => {
  // From the More button (-1): down to the first, up to the last.
  assert.equal(menuMove('ArrowDown', -1, 3), 0);
  assert.equal(menuMove('ArrowUp', -1, 3), 2);
  assert.equal(menuMove('ArrowDown', 0, 3), 1);
  assert.equal(menuMove('ArrowDown', 2, 3), 0);
  assert.equal(menuMove('ArrowUp', 0, 3), 2);
  assert.equal(menuMove('ArrowUp', 2, 3), 1);
  assert.equal(menuMove('Home', 2, 3), 0);
  assert.equal(menuMove('End', 0, 3), 2);
  assert.equal(menuMove('a', 0, 3), null);
  assert.equal(menuMove('ArrowDown', 0, 0), null);
});

test('Merge and Remove prompts name the worktree by project and branch and say what is kept', () => {
  const worktree = { path: '/Users/you/Library/Application Support/ScaleMax/worktrees/api-task-1792746527836-6goj6v', branch: 'feat/health', base: 'main', mainRoot: '/Users/you/api', mainName: 'api', createdAt: 1 };
  const clean = removeQuestion(worktree, { changed: 0, unmerged: 0, notes: false });
  assert.equal(clean.title, 'Remove this task\'s worktree?');
  assert.equal(clean.context, 'api · branch feat/health');
  assert.equal(clean.message, 'Its folder is deleted. The branch feat/health and its commits are kept.');
  assert.equal(clean.confirmLabel, 'Remove worktree');
  assert.equal(clean.danger, true);
  for (const text of [clean.title, clean.context, clean.message, clean.note]) {
    assert.equal(text.includes('api-task-'), false, 'never the generated folder name');
    assert.equal(text.includes('Application Support'), false, 'never the app data path');
  }
  const busy = removeQuestion(worktree, { changed: 2, unmerged: 3, notes: true, changedNames: 'src/a.js, src/b.js' }, { others: 1 });
  assert.equal(busy.message, 'Its folder is deleted. 2 uncommitted changes are lost with it: src/a.js, src/b.js. The branch feat/health is kept, with its 3 commits not merged into main.');
  assert.equal(busy.note, 'ScaleMax\'s project notes there go with it. 1 other task also works there.');
  assert.equal(busy.confirmLabel, 'Remove and lose changes');
  const merge = mergeQuestion(worktree, { unmerged: 2 });
  assert.equal(merge.title, 'Merge 2 commits into main?');
  assert.equal(merge.context, 'api · branch feat/health');
  assert.equal(merge.confirmLabel, 'Merge into main');
  assert.equal(merge.danger, undefined, 'a merge is not destructive: it is undone if it conflicts');
  assert.match(mergeQuestion(worktree, { unmerged: 0 }).note, /main already has everything from feat\/health/);
  assert.equal(mergeQuestion(worktree).title, 'Merge this worktree\'s branch into main?');
});
