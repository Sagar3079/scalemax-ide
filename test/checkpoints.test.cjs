'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools, SERVER_ID } = require('../lib/workspace-tools.cjs');
const { createCheckpoints } = require('../lib/checkpoints.cjs');

// A project with two files, an open workspace session on it, and a checkpoint store.
async function setup(t, { now } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cp-project-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cp-store-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "const answer = 41;\nconsole.log(answer);\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n');
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const checkpoints = createCheckpoints({ dir: store, ...(now ? { now } : {}) });
  return { root, store, workspace, checkpoints };
}
// Workspace tools that record into a new checkpoint for `requestId`.
function toolsFor(workspace, checkpoints, requestId) {
  const recorder = checkpoints.recorder({ requestId, folder: workspace.current() });
  const tools = createWorkspaceTools({ getWorkspace: () => workspace, onChange: (change) => recorder.record(change) });
  return { tools, recorder };
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a reply records the first version before and the last after, with line counts', async (t) => {
  const { root, store, workspace, checkpoints } = await setup(t);
  const { tools, recorder } = toolsFor(workspace, checkpoints, 'chat-task-1-100');
  assert.equal(recorder.summary(), null, 'nothing changed yet');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  await tools.call('edit_file', { path: 'src/app.js', old_text: 'console.log(answer);', new_text: 'console.log(answer);\nconsole.log("done");' });
  await tools.call('write_file', { path: 'notes/plan.md', content: '# Plan\n\n- ship it\n' });
  // Changed and changed back: no change at all.
  await tools.call('edit_file', { path: 'README.md', old_text: '# Demo', new_text: '# Demo!' });
  await tools.call('edit_file', { path: 'README.md', old_text: '# Demo!', new_text: '# Demo' });
  const summary = recorder.summary();
  assert.deepEqual(summary, {
    id: 'chat-task-1-100',
    folderName: path.basename(root),
    files: [
      { path: 'src/app.js', kind: 'modified', added: 2, removed: 1, status: 'changed' },
      { path: 'notes/plan.md', kind: 'created', added: 3, removed: 0, status: 'changed' },
    ],
  });
  assert.deepEqual(checkpoints.summary('chat-task-1-100'), summary, 'the same summary is read back from disk');
  // Stored privately, never inside the project.
  const saved = path.join(store, 'chat-task-1-100');
  assert.equal(fs.statSync(saved).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(saved, 'meta.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(summary).includes(root), false, 'the window never gets the absolute folder');
  assert.deepEqual(checkpoints.folderOf('chat-task-1-100'), { path: root, name: path.basename(root) });
});

test('the diff shows the change and how the file is now', async (t) => {
  const { root, workspace, checkpoints } = await setup(t);
  const { tools } = toolsFor(workspace, checkpoints, 'chat-diff');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  const diff = await checkpoints.diff('chat-diff', 'src/app.js', { workspace });
  assert.equal(diff.current, 'same');
  assert.deepEqual(diff.hunks[0].lines.map((line) => `${line.type}${line.text}`),
    ['-const answer = 41;', '+const answer = 42;', ' console.log(answer);']);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'rewritten by hand\n');
  assert.equal((await checkpoints.diff('chat-diff', 'src/app.js', { workspace })).current, 'changed');
  assert.equal((await checkpoints.diff('chat-diff', 'src/app.js')).current, 'unknown');
  await assert.rejects(checkpoints.diff('chat-diff', 'README.md'), { code: 'NOT_FOUND' });
  await assert.rejects(checkpoints.diff('chat-never', 'src/app.js'), { code: 'NO_CHECKPOINT' });
});

test('undo puts modified files back and deletes created ones, with backups', async (t) => {
  const { root, workspace, checkpoints } = await setup(t);
  const { tools } = toolsFor(workspace, checkpoints, 'chat-undo');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  await tools.call('write_file', { path: 'notes/plan.md', content: 'plan\n' });
  const { results, changes } = await checkpoints.undo('chat-undo', null, { workspace });
  assert.deepEqual(results, [{ path: 'src/app.js', ok: true }, { path: 'notes/plan.md', ok: true }]);
  assert.equal(read(root, 'src/app.js'), "const answer = 41;\nconsole.log(answer);\n");
  assert.equal(fs.existsSync(path.join(root, 'notes', 'plan.md')), false);
  assert.deepEqual(changes.files.map((file) => file.status), ['undone', 'undone']);
  // The versions the undo replaced are backed up like every save.
  const backups = fs.readdirSync(path.join(root, '.cache', 'editor-backups')).map((name) => fs.readFileSync(path.join(root, '.cache', 'editor-backups', name), 'utf8'));
  assert.ok(backups.includes('plan\n'));
  assert.ok(backups.includes("const answer = 42;\nconsole.log(answer);\n"));
  // Nothing left to undo; a second undo changes nothing.
  assert.deepEqual((await checkpoints.undo('chat-undo', null, { workspace })).results, []);
  assert.equal((await checkpoints.diff('chat-undo', 'src/app.js', { workspace })).current, 'original');
});

test('undo never overwrites later work, and kept files are not offered again', async (t) => {
  const { root, workspace, checkpoints } = await setup(t);
  const { tools } = toolsFor(workspace, checkpoints, 'chat-safe');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  await tools.call('write_file', { path: 'notes/plan.md', content: 'plan\n' });
  await tools.call('write_file', { path: 'notes/keep.md', content: 'keep\n' });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'edited by the user afterwards\n');
  fs.rmSync(path.join(root, 'notes', 'plan.md'));
  assert.deepEqual(checkpoints.keep('chat-safe', ['notes/keep.md']).files.map((file) => file.status), ['changed', 'changed', 'kept']);
  const { results, changes } = await checkpoints.undo('chat-safe', null, { workspace });
  assert.deepEqual(results.map((result) => [result.path, result.ok, result.code || '']), [
    ['src/app.js', false, 'CHANGED_SINCE'],
    // A created file that is already gone counts as undone.
    ['notes/plan.md', true, ''],
  ]);
  assert.match(results[0].message, /changed since this reply/);
  assert.equal(read(root, 'src/app.js'), 'edited by the user afterwards\n');
  assert.equal(read(root, 'notes/keep.md'), 'keep\n');
  assert.deepEqual(changes.files.map((file) => file.status), ['changed', 'undone', 'kept']);
});

test('undo of one file leaves the others; a later reply must be undone first', async (t) => {
  const { root, workspace, checkpoints } = await setup(t);
  const first = toolsFor(workspace, checkpoints, 'chat-first');
  await first.tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  await first.tools.call('edit_file', { path: 'README.md', old_text: '# Demo', new_text: '# Demo app' });
  const second = toolsFor(workspace, checkpoints, 'chat-second');
  await second.tools.call('edit_file', { path: 'src/app.js', old_text: '42', new_text: '43' });
  assert.equal((await checkpoints.undo('chat-first', ['src/app.js'], { workspace })).results[0].code, 'CHANGED_SINCE');
  assert.deepEqual((await checkpoints.undo('chat-second', null, { workspace })).results, [{ path: 'src/app.js', ok: true }]);
  assert.deepEqual((await checkpoints.undo('chat-first', ['src/app.js'], { workspace })).results, [{ path: 'src/app.js', ok: true }]);
  assert.equal(read(root, 'src/app.js'), "const answer = 41;\nconsole.log(answer);\n");
  assert.equal(read(root, 'README.md'), '# Demo app\n', 'the file that was not asked for stays');
});

test('limits: files past the limit are listed but not kept; odd ids are stored under a hash', async (t) => {
  const { workspace, checkpoints, store } = await setup(t);
  const recorder = checkpoints.recorder({ requestId: 'automation-x:1/../y', folder: workspace.current() });
  recorder.record({ path: 'a.txt', before: null, beforeRevision: null, after: 'a\n', afterRevision: 'a'.repeat(64) });
  const names = fs.readdirSync(store);
  assert.equal(names.length, 1);
  assert.match(names[0], /^h-[0-9a-f]{40}$/);
  assert.equal(checkpoints.summary('automation-x:1/../y').files.length, 1);
  assert.equal(checkpoints.recorder({ requestId: 'x', folder: null }), null);
  assert.equal(checkpoints.recorder({ requestId: 'bad\nid', folder: workspace.current() }), null);
  // Past 200 files the rest are listed without contents.
  const many = checkpoints.recorder({ requestId: 'chat-many', folder: workspace.current() });
  for (let index = 0; index < 202; index += 1) {
    many.record({ path: `f${index}.txt`, before: null, beforeRevision: null, after: `${index}\n`, afterRevision: String(index % 10).repeat(64) });
  }
  const files = many.summary().files;
  assert.equal(files.length, 202);
  assert.equal(files.filter((file) => file.untracked).length, 2);
  const diff = await checkpoints.diff('chat-many', 'f201.txt');
  assert.equal(diff.untracked, true);
  assert.deepEqual(diff.hunks, []);
});

test('prune keeps the newest checkpoints of the last 30 days; remove forgets them', async (t) => {
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const { workspace, checkpoints, store } = await setup(t, { now: () => clock });
  const make = (id) => checkpoints.recorder({ requestId: id, folder: workspace.current() })
    .record({ path: 'a.txt', before: null, beforeRevision: null, after: 'a\n', afterRevision: 'b'.repeat(64) });
  make('old');
  clock += 20 * 24 * 60 * 60 * 1000;
  make('mid');
  clock += 1000;
  make('new');
  clock += 15 * 24 * 60 * 60 * 1000;
  assert.equal(checkpoints.prune({ maxCount: 1 }), 2);
  assert.deepEqual(fs.readdirSync(store).sort(), ['new']);
  assert.equal(checkpoints.remove(['new', 'missing', 'bad\u0000']), 2);
  assert.deepEqual(fs.readdirSync(store), []);
});

test('the workspace can delete a file only with its current revision, and backs it up', async (t) => {
  const { root, workspace } = await setup(t);
  const file = await workspace.read('README.md');
  await assert.rejects(workspace.remove({ path: 'README.md', revision: 'f'.repeat(64) }), { code: 'CONFLICT' });
  await assert.rejects(workspace.remove({ path: '.env', revision: file.revision }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(workspace.remove({ path: '../outside', revision: file.revision }), { code: 'INVALID_PATH' });
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link.md'));
  await assert.rejects(workspace.remove({ path: 'link.md', revision: file.revision }), { code: 'SYMLINK' });
  assert.deepEqual(await workspace.remove({ path: 'README.md', revision: file.revision }), { path: 'README.md', removed: true });
  assert.equal(fs.existsSync(path.join(root, 'README.md')), false);
  const backups = fs.readdirSync(path.join(root, '.cache', 'editor-backups'));
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'editor-backups', backups[0]), 'utf8'), '# Demo\n');
  assert.equal(SERVER_ID, 'Workspace');
});

test('a file someone else changed between two edits of the reply is not undone', async (t) => {
  const { root, workspace, checkpoints } = await setup(t);
  const { tools } = toolsFor(workspace, checkpoints, 'chat-mixed');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  // The user saves a hand edit while the reply is still working...
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "const answer = 42;\nconsole.log(answer); // by hand\n");
  // ...and the reply edits the file again, on top of it.
  await tools.call('edit_file', { path: 'src/app.js', old_text: '42', new_text: '43' });
  const [file] = checkpoints.summary('chat-mixed').files;
  assert.equal(file.mixed, true);
  const { results } = await checkpoints.undo('chat-mixed', null, { workspace });
  assert.equal(results[0].code, 'MIXED');
  assert.match(read(root, 'src/app.js'), /by hand/, 'the hand edit is still there');
});

test('two sessions never both change the same version of a file', async (t) => {
  const { root, workspace } = await setup(t);
  const other = createWorkspace({ approve: async () => true });
  t.after(() => other.dispose());
  await other.select(root);
  const file = await workspace.read('README.md');
  const outcomes = await Promise.allSettled([
    workspace.write({ path: 'README.md', content: 'first writer\n', revision: file.revision }),
    other.write({ path: 'README.md', content: 'second writer\n', revision: file.revision }),
    other.remove({ path: 'README.md', revision: file.revision }).catch((error) => { throw error; }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected', 'rejected']);
  const refused = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason.code).sort();
  assert.ok(refused.every((code) => code === 'CONFLICT' || code === 'WRITE_BUSY'), `refused with ${refused}`);
  assert.equal(read(root, 'README.md'), 'first writer\n');
});

test('a session ended while a new file was being written still reports and records it', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cp-late-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cp-late-store-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let caught = false;
  // Holds the new file's flush to disk, the moment a stopped reply ends the session.
  const promises = {
    ...fs.promises,
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      if (!caught && String(args[0]).endsWith('late.md')) {
        caught = true;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await held; return sync(); };
      }
      return handle;
    },
  };
  const workspace = createWorkspace({ approve: async () => true, io: { ...fs, promises } });
  await workspace.select(root);
  const checkpoints = createCheckpoints({ dir: store });
  const { tools } = toolsFor(workspace, checkpoints, 'chat-late');
  const writing = tools.call('write_file', { path: 'late.md', content: 'late\n' });
  for (let index = 0; index < 400 && !caught; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  workspace.dispose();
  release();
  const result = await writing;
  assert.match(result.text, /Created late\.md/);
  assert.equal(await workspace.idle(), undefined);
  assert.deepEqual(checkpoints.summary('chat-late').files.map((file) => file.path), ['late.md']);
});

test('undo reports what it did even when its bookkeeping cannot be saved', async (t) => {
  const { root, workspace, store } = await setup(t);
  let failMeta = false;
  const io = { ...fs, renameSync: (from, to) => { if (failMeta && to.endsWith('meta.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.renameSync(from, to); } };
  const checkpoints = createCheckpoints({ dir: store, io });
  const { tools } = toolsFor(workspace, checkpoints, 'chat-full');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  failMeta = true;
  const { results } = await checkpoints.undo('chat-full', null, { workspace });
  assert.deepEqual(results, [{ path: 'src/app.js', ok: true }]);
  assert.equal(read(root, 'src/app.js'), "const answer = 41;\nconsole.log(answer);\n");
  assert.equal(fs.readdirSync(path.join(store, 'chat-full')).some((name) => name.endsWith('.tmp')), false, 'no temporary file left');
});

test('a damaged earlier version is never put back; past the size limit undo still works', async (t) => {
  const { root, workspace, store } = await setup(t);
  const checkpoints = createCheckpoints({ dir: store, limits: { maxBytes: 200 } });
  const { tools } = toolsFor(workspace, checkpoints, 'chat-limits');
  await tools.call('edit_file', { path: 'src/app.js', old_text: '41', new_text: '42' });
  // The second change pushes the stored versions past 200 bytes: no diff, but undo works.
  await tools.call('edit_file', { path: 'src/app.js', old_text: 'console.log(answer);', new_text: `console.log(answer, ${JSON.stringify('x'.repeat(150))});` });
  assert.equal((await checkpoints.diff('chat-limits', 'src/app.js', { workspace })).noDiff, true);
  const damaged = createCheckpoints({ dir: store });
  const blob = fs.readdirSync(path.join(store, 'chat-limits')).find((name) => name.endsWith('.before'));
  fs.writeFileSync(path.join(store, 'chat-limits', blob), 'tampered\n');
  assert.equal((await damaged.undo('chat-limits', null, { workspace })).results[0].code, 'NOT_KEPT');
  assert.match(read(root, 'src/app.js'), /xxxx/, 'left as the reply left it');
  fs.writeFileSync(path.join(store, 'chat-limits', blob), "const answer = 41;\nconsole.log(answer);\n");
  assert.deepEqual((await damaged.undo('chat-limits', null, { workspace })).results, [{ path: 'src/app.js', ok: true }]);
  assert.equal(read(root, 'src/app.js'), "const answer = 41;\nconsole.log(answer);\n");
});

test('a reused request id never overwrites the changes of the earlier reply', async (t) => {
  const { workspace, checkpoints } = await setup(t);
  const first = toolsFor(workspace, checkpoints, 'chat-same-id');
  await first.tools.call('write_file', { path: 'one.md', content: 'one\n' });
  const second = toolsFor(workspace, checkpoints, 'chat-same-id');
  await second.tools.call('write_file', { path: 'two.md', content: 'two\n' });
  assert.deepEqual(checkpoints.summary('chat-same-id').files.map((file) => file.path), ['one.md']);
  assert.equal(second.recorder.summary(), null);
});
