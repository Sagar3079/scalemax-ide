import test from 'node:test';
import assert from 'node:assert/strict';

// The browser preview's stand-in for preload.js (src/web-shim.js) installs itself on `window`
// when no Electron bridge is there.
const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  },
  setTimeout,
};
const info = console.info;
console.info = () => {};
await import('../src/web-shim.js');
console.info = info;
const api = window.scalemaxAPI;

test('the preview offers an in-memory folder, shaped like preload.js answers', async () => {
  const before = await api.workspace.current();
  assert.equal(before.ok, true);
  assert.equal(before.data.root, '', 'no folder is open until one is picked');
  assert.deepEqual(before.data.recent, [{ name: 'demo-project', path: '/preview/demo-project' }]);
  assert.deepEqual((await api.workspace.list()).error.code, 'NO_WORKSPACE');

  const picked = await api.dialog.openFolder();
  assert.deepEqual(picked, { ok: true, data: { path: '/preview/demo-project' } });
  assert.equal((await api.workspace.select('/somewhere/else')).ok, false);
  const opened = await api.workspace.select(picked.data.path);
  assert.equal(opened.ok, true);
  assert.equal(opened.data.root, '/preview/demo-project');
  assert.deepEqual(opened.data.files.map((entry) => `${entry.type}:${entry.path}`),
    ['directory:src', 'file:package.json', 'file:README.md']);
  assert.equal(storage.get('scalemax-preview-folder'), '/preview/demo-project', 'reopened at the next start');

  const src = await api.workspace.list('src');
  assert.deepEqual(src.data, {
    root: '/preview/demo-project',
    files: [{ name: 'index.js', path: 'src/index.js', type: 'file' }, { name: 'styles.css', path: 'src/styles.css', type: 'file' }],
  });
  assert.equal((await api.workspace.list('nope')).error.code, 'ENOENT');
  assert.deepEqual((await api.workspace.find('STYLE')).data, { files: ['src/styles.css'], complete: true });
  assert.deepEqual((await api.workspace.gitStatus()).data, { isRepo: false, branch: null, files: [] });
  assert.deepEqual((await api.workspace.gitDiff('')).data, { diff: '' });
});

test('the preview folder can be edited, with the same conflict rule as a real save', async () => {
  const read = await api.workspace.read('README.md');
  assert.equal(read.ok, true);
  assert.match(read.data.revision, /^[a-f0-9]{64}$/);
  const saved = await api.workspace.write({ path: 'README.md', content: '# Changed\n', revision: read.data.revision });
  assert.equal(saved.ok, true);
  assert.notEqual(saved.data.revision, read.data.revision);
  assert.equal((await api.workspace.read('README.md')).data.content, '# Changed\n');
  const stale = await api.workspace.write({ path: 'README.md', content: 'x', revision: read.data.revision });
  assert.equal(stale.error.code, 'CONFLICT');
  assert.equal((await api.workspace.read('missing.md')).error.code, 'ENOENT');
  assert.equal((await api.workspace.run({ command: 'ls' })).ok, false, 'commands need the desktop app');
});

test('the preview stands in for automations and MCP listings without running anything', async () => {
  assert.deepEqual(await api.automations.state(), { ok: true, data: { running: [], background: true } });
  assert.equal((await api.automations.runNow({ id: 'a1' })).error.code, 'UNAVAILABLE');
  assert.equal((await api.automations.setContext({})).ok, true);
  assert.equal(typeof api.automations.onChanged(() => {}), 'function');
  for (const method of ['resources', 'prompts', 'getPrompt']) assert.equal((await api.mcp[method]({ id: 'x' })).error.code, 'UNAVAILABLE', method);
  assert.equal(api.mcp.list, undefined, 'the MCP view still says it needs the desktop app');
});
