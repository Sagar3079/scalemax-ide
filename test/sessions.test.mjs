import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  rewindPlan, rewoundTask, undoOrder, rewindReport, forkedTask, sharedChangeIds, unsharedChangeIds, sessionResults,
  transcriptMarkdown, slugify, normalizeWorktree,
} from '../src/sessions.mjs';

const require = createRequire(import.meta.url);
const gitFlow = require('../lib/git-flow.cjs');

const FOLDER = { name: 'project', path: '/Users/you/project' };
const changes = (id, files) => ({ id, folderName: 'project', files: files.map(([path, status = 'changed', extra = {}]) => ({ path, kind: 'modified', added: 1, removed: 0, status, ...extra })) });
// A conversation of three turns; the second and third replies changed files.
function task() {
  return {
    id: 'task-1', title: 'Fix the parser', createdAt: 1, updatedAt: 9, folder: { ...FOLDER },
    messages: [
      { role: 'user', text: 'What does the parser do?', time: 1 },
      { role: 'assistant', text: 'It reads **config** files.', time: 2 },
      { role: 'user', text: 'Fix the empty input crash', time: 3, images: [{ id: 'm-0123456789abcdef', name: 'shot.png' }] },
      { role: 'assistant', text: 'Fixed it.', time: 4, changes: changes('chat-a', [['src/parser.js'], ['notes.md', 'kept']]), steps: [{ type: 'tool', title: 'Edited src/parser.js', server: 'Workspace', tool: 'edit_file', ok: true }] },
      { role: 'user', text: 'Add a test too', time: 5 },
      { role: 'assistant', text: 'Added.', time: 6, changes: changes('chat-b', [['src/parser.js'], ['test/parser.test.js'], ['README.md', 'undone']]) },
    ],
  };
}

test('rewind: back to just before a user message, with the later replies\' changes to undo', () => {
  const source = task();
  const plan = rewindPlan(source, 2);
  assert.equal(plan.text, 'Fix the empty input crash');
  assert.deepEqual(plan.images, [{ id: 'm-0123456789abcdef', name: 'shot.png' }]);
  assert.equal(plan.keep, 2);
  assert.equal(plan.removed, 4);
  assert.deepEqual(plan.replies, [
    { id: 'chat-a', files: ['src/parser.js'], kept: ['notes.md'] },
    { id: 'chat-b', files: ['src/parser.js', 'test/parser.test.js'], kept: [] },
  ]);
  assert.equal(plan.files, 2, 'a file two replies changed counts once');
  assert.equal(plan.compaction, null);
  // Undo goes newest first, so src/parser.js goes back one reply at a time.
  assert.deepEqual(undoOrder(plan).map((reply) => reply.id), ['chat-b', 'chat-a']);
  // Only at a user message.
  for (const index of [1, 3, -1, 6, 1.5, '2']) assert.equal(rewindPlan(source, index), null, String(index));
  // Rewinding to the latest message removes just it (no replies after it yet).
  const last = rewindPlan(source, 4);
  assert.equal(last.removed, 2);
  assert.deepEqual(last.replies.map((reply) => reply.id), ['chat-b']);

  const next = rewoundTask(source, 2, 100);
  assert.deepEqual(next.messages.map((message) => message.text), ['What does the parser do?', 'It reads **config** files.']);
  assert.equal(next.updatedAt, 100);
  assert.equal(source.messages.length, 6, 'the task itself is not changed by planning');
  assert.deepEqual(rewoundTask(source, 0).messages, []);
  assert.equal(rewoundTask(source, 1), null);
});

test('rewind and fork keep the summary of older turns only while it covers turns that stay', () => {
  const source = { ...task(), compaction: { summary: 'Earlier: the parser reads config.', through: 2, model: 'm', time: 5 } };
  assert.equal(rewindPlan(source, 4).compaction, 'kept');
  assert.deepEqual(rewoundTask(source, 4).compaction.summary, 'Earlier: the parser reads config.');
  // Back to the summary's own edge or before it: it would describe messages that are gone.
  assert.equal(rewindPlan(source, 2).compaction, 'dropped');
  assert.equal(rewoundTask(source, 2).compaction, null);
  assert.equal(rewoundTask(source, 0).compaction, null);
  assert.equal(forkedTask(source, 4, { id: 'task-2' }).compaction.through, 2);
  assert.equal('compaction' in forkedTask(source, 2, { id: 'task-2' }), false);
});

test('what a rewind put back, and what it left as it is (and why)', () => {
  const report = rewindReport([
    { id: 'chat-b', ok: true, results: [{ path: 'src/parser.js', ok: true }, { path: 'test/parser.test.js', ok: false, message: 'test/parser.test.js has changed since this reply, so it was left as it is.' }], kept: [] },
    { id: 'chat-a', ok: true, results: [{ path: 'src/parser.js', ok: true }], kept: ['notes.md'] },
    { id: 'chat-c', ok: false, error: 'A reply is working in this folder.' },
  ]);
  assert.deepEqual(report.restored, ['src/parser.js']);
  assert.deepEqual(report.notRestored, [
    { path: 'test/parser.test.js', message: 'test/parser.test.js has changed since this reply, so it was left as it is.' },
    { path: 'notes.md', message: 'notes.md was kept after that reply, so it was left as it is.' },
    { path: '', message: 'A reply is working in this folder.' },
  ]);
  // A file put back by the newer reply but refused for the older one is not "back".
  const partial = rewindReport([
    { id: 'b', ok: true, results: [{ path: 'a.js', ok: true }] },
    { id: 'a', ok: true, results: [{ path: 'a.js', ok: false, message: 'a.js has changed since this reply, so it was left as it is.' }] },
  ]);
  assert.deepEqual(partial.restored, []);
  assert.deepEqual(rewindReport(null), { restored: [], notRestored: [] });
});

test('fork: a deep copy of the conversation before the message, in the same folder and worktree', () => {
  const source = { ...task(), worktree: { path: '/data/worktrees/project-task-1', branch: 'scalemax/fix-the-parser', base: 'main', mainRoot: FOLDER.path, mainName: 'project', createdAt: 5 } };
  const fork = forkedTask(source, 4, { id: 'task-2', now: 50 });
  assert.equal(fork.id, 'task-2');
  assert.equal(fork.title, 'Fix the parser (fork)');
  assert.deepEqual(fork.folder, FOLDER);
  assert.equal(fork.worktree.branch, 'scalemax/fix-the-parser');
  assert.equal(fork.createdAt, 50);
  assert.equal(fork.updatedAt, 50);
  assert.deepEqual(fork.messages.map((message) => message.text), ['What does the parser do?', 'It reads **config** files.', 'Fix the empty input crash', 'Fixed it.']);
  // Nothing is shared with the original.
  fork.messages[3].changes.files[0].status = 'undone';
  fork.messages[0].text = 'changed';
  assert.equal(source.messages[3].changes.files[0].status, 'changed');
  assert.equal(source.messages[0].text, 'What does the parser do?');
  assert.equal(forkedTask(source, 3, { id: 'x' }), null, 'only at a user message');
  assert.equal(forkedTask(source, 2, {}), null, 'a new task needs its id');
  assert.equal(forkedTask({ ...source, title: 'x'.repeat(80) }, 2, { id: 'y' }).title, `${'x'.repeat(60)}… (fork)`);
});

test('a fork shares its replies\' changes: they are forgotten only with the last task that shows them', () => {
  const source = task();
  const fork = forkedTask(source, 4, { id: 'task-2' });
  const tasks = [source, fork];
  assert.deepEqual([...sharedChangeIds(tasks, source)], ['chat-a']);
  // Deleting the original: chat-a stays (the fork shows it), chat-b goes.
  assert.deepEqual(unsharedChangeIds(tasks, source, source.messages), ['chat-b']);
  // Rewinding the fork past chat-a forgets nothing the original still shows.
  assert.deepEqual(unsharedChangeIds(tasks, fork, fork.messages.slice(2)), []);
  assert.deepEqual(unsharedChangeIds([source], source, source.messages), ['chat-a', 'chat-b']);
});

test('Recent sessions: newest first, found by title or by any message, with a snippet', () => {
  const tasks = [
    { id: 'old', title: 'Old notes', updatedAt: 10, folder: FOLDER, messages: [{ role: 'user', text: 'Remember the deploy key rotation' }] },
    { id: 'new', title: 'Parser crash', updatedAt: 30, messages: [{ role: 'user', text: 'x '.repeat(80) + 'the DEPLOY script fails' }, { role: 'assistant', text: 'Fixed.' }] },
    { id: 'empty', title: 'New Task', updatedAt: 40, messages: [] },
    { id: 'mid', title: 'Deploy pipeline', updatedAt: 20, messages: [{ role: 'user', text: 'set up CI' }] },
  ];
  const all = sessionResults(tasks);
  assert.deepEqual(all.map((item) => item.id), ['new', 'mid', 'old'], 'empty tasks are left out');
  assert.equal(all[0].snippet, 'Fixed.', 'without a query: the latest message');
  assert.equal(all[2].folderName, 'project');
  assert.equal(all[0].folderName, '');
  const found = sessionResults(tasks, '  deploy ');
  assert.deepEqual(found.map((item) => [item.id, item.matched]), [['new', 'message'], ['mid', 'title'], ['old', 'message']]);
  assert.match(found[0].snippet, /^….*the DEPLOY script fails$/);
  assert.equal(found[0].snippet.length <= 142, true);
  assert.equal(found[1].snippet, 'set up CI');
  assert.deepEqual(sessionResults(tasks, 'nothing like this'), []);
  assert.equal(sessionResults(tasks, '', { limit: 1 }).length, 1);
  assert.deepEqual(sessionResults(null), []);
});

test('a transcript as Markdown: who wrote what and when, what replies did, changed and cost', () => {
  const source = {
    ...task(),
    worktree: { path: '/data/worktrees/p', branch: 'scalemax/fix', base: 'main', mainRoot: '/p', mainName: 'p' },
  };
  source.messages[5].notice = 'Stopped before the reply was finished.';
  source.messages[5].metrics = { usage: { inputTokens: 3500, outputTokens: 109 }, costStatus: 'priced', costMicroUsd: 720 };
  const markdown = transcriptMarkdown(source, { now: Date.UTC(2026, 9, 16, 12, 0) });
  const lines = markdown.split('\n');
  assert.equal(lines[0], '# Fix the parser');
  assert.ok(lines.includes('- Folder: /Users/you/project'));
  assert.ok(lines.includes('- Worktree branch: scalemax/fix (from main)'));
  assert.ok(lines.includes('- Messages: 6'));
  assert.equal(lines.filter((line) => /^## You · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(line)).length, 3);
  assert.equal(lines.filter((line) => /^## ScaleMax · /.test(line)).length, 3);
  assert.ok(lines.includes('It reads **config** files.'), 'replies stay Markdown');
  assert.ok(lines.includes('*A picture was attached.*'));
  assert.ok(lines.includes('*1 step · Edited a file*'));
  assert.ok(lines.includes('*2 files changed · +2 · 1 kept*'));
  assert.ok(lines.includes('*3 files changed · +3 · 1 undone*'));
  assert.ok(lines.includes('*Stopped before the reply was finished.*'));
  assert.ok(lines.includes('*3.5k in · 109 out · <$0.01*'));
  assert.equal(/\n{3,}/.test(markdown), false);
  assert.ok(markdown.endsWith('\n'));
  assert.match(transcriptMarkdown({ title: '', messages: [] }), /^# Task\n/);
});

test('branch names: the window and main make the same slug from a title', () => {
  for (const title of ['Fix the login form!', '  Ünïcode — café  ', '!!!', 'a very long title that keeps going and going well past forty characters', 'API v2: add /users endpoint', '日本語']) {
    assert.equal(slugify(title), gitFlow.slugify(title), title);
  }
});

test('a task\'s worktree is kept only when it is usable', () => {
  const good = { path: '/data/worktrees/p-task-1', branch: 'scalemax/fix', base: 'main', mainRoot: '/Users/you/p', mainName: 'p', createdAt: 5 };
  assert.deepEqual(normalizeWorktree(good), good);
  assert.deepEqual(normalizeWorktree({ ...good, removed: true, extra: 'x' }), { ...good, removed: true });
  assert.equal(normalizeWorktree({ ...good, base: 'bad base' }).base, null);
  assert.equal(normalizeWorktree({ ...good, mainName: '' }).mainName, 'p');
  for (const broken of [{ ...good, path: 'relative' }, { ...good, branch: 'has space' }, { ...good, mainRoot: null }, null, 'x']) {
    assert.equal(normalizeWorktree(broken), null);
  }
});
