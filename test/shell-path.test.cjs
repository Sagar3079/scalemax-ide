'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { applyShellPath, readShellPath, mergePaths, DARWIN_FALLBACK } = require('../lib/shell-path.cjs');

function fakeSpawn(stdout, { error = null, never = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (never) return;
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('mergePaths keeps the first copy of every absolute folder', () => {
  assert.equal(mergePaths('/a:/b', ['/b', '/c', 'relative', ''], '/a:/d'), '/a:/b:/c:/d');
});

test('the login shell PATH is read between markers, ignoring startup noise', async () => {
  const { spawnImpl, calls } = fakeSpawn('Welcome to zsh!\n__SCALEMAX_PATH__/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:relative__SCALEMAX_PATH__');
  assert.equal(await readShellPath({ shell: '/bin/zsh', spawnImpl, platform: 'darwin' }), '/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin');
  assert.equal(calls[0].command, '/bin/zsh');
  assert.equal(calls[0].args[0], '-ilc');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
});

test('failures and timeouts give null; Windows is not asked', async () => {
  assert.equal(await readShellPath({ spawnImpl: fakeSpawn('', { error: new Error('ENOENT') }).spawnImpl, platform: 'darwin' }), null);
  assert.equal(await readShellPath({ spawnImpl: fakeSpawn('no markers here').spawnImpl, platform: 'linux' }), null);
  assert.equal(await readShellPath({ spawnImpl: fakeSpawn('', { never: true }).spawnImpl, platform: 'darwin', timeoutMs: 20 }), null);
  const windows = fakeSpawn('x');
  assert.equal(await readShellPath({ spawnImpl: windows.spawnImpl, platform: 'win32' }), null);
  assert.equal(windows.calls.length, 0);
});

test('applyShellPath puts the shell folders first, then the inherited ones, then the macOS fallback', async () => {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const result = await applyShellPath({ env, platform: 'darwin', read: async () => '/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin' });
  assert.equal(result, '/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/sbin:/usr/local/bin');
  assert.equal(env.PATH, result);
  // The shell could not be asked: the usual Homebrew folders are still added on macOS.
  const fallback = { PATH: '/usr/bin:/bin' };
  await applyShellPath({ env: fallback, platform: 'darwin', read: async () => null });
  assert.equal(fallback.PATH, ['/usr/bin', '/bin', ...DARWIN_FALLBACK].join(':'));
  const windows = { PATH: 'C:\\Windows' };
  assert.equal(await applyShellPath({ env: windows, platform: 'win32', read: async () => { throw new Error('not called'); } }), 'C:\\Windows');
});

test('the real login shell answers with absolute folders', { skip: process.platform === 'win32' }, async () => {
  const value = await readShellPath();
  if (value === null) return; // no usable login shell on this machine
  assert.ok(value.split(':').every((entry) => entry.startsWith('/')));
  assert.ok(value.split(':').includes('/usr/bin'));
});
