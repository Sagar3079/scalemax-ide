'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { applyShellPath, readShellPath, readShellEnvironment, mergePaths, DARWIN_FALLBACK, DEFAULT_LANG } = require('../lib/shell-path.cjs');

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

test('the login shell\'s locale is read with its PATH; odd values are not taken', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    'motd\n__SCALEMAX_PATH__/opt/homebrew/bin:/usr/bin__SCALEMAX_PATH__',
    '__SCALEMAX_LOCALE__LANG=de_DE.UTF-8__SCALEMAX_LOCALE__',
    '__SCALEMAX_LOCALE__LC_ALL=__SCALEMAX_LOCALE__',
    '__SCALEMAX_LOCALE__LC_CTYPE=$(evil) x__SCALEMAX_LOCALE__',
  ].join(''));
  assert.deepEqual(await readShellEnvironment({ shell: '/bin/zsh', spawnImpl, platform: 'darwin' }), { PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'de_DE.UTF-8' });
  // PATH comes first and on its own, so a shell that stops at an unset variable still gives it.
  assert.match(calls[0].args[1], /^printf '%s%s%s' '__SCALEMAX_PATH__' "\$PATH" '__SCALEMAX_PATH__'; printf .*"\$LANG"/);
  assert.equal(await readShellPath({ spawnImpl: fakeSpawn('__SCALEMAX_LOCALE__LANG=C__SCALEMAX_LOCALE__').spawnImpl, platform: 'darwin' }), null);
});

test('an app started without a locale takes the shell\'s, else LANG=en_US.UTF-8 on macOS; one it was given stays', async () => {
  const fromFinder = { PATH: '/usr/bin' };
  await applyShellPath({ env: fromFinder, platform: 'darwin', read: async () => ({ PATH: '/opt/homebrew/bin', LC_CTYPE: 'UTF-8' }) });
  assert.deepEqual([fromFinder.LANG, fromFinder.LC_ALL, fromFinder.LC_CTYPE], [DEFAULT_LANG, undefined, 'UTF-8']);
  const shellLang = { PATH: '/usr/bin' };
  await applyShellPath({ env: shellLang, platform: 'darwin', read: async () => ({ LANG: 'fr_FR.UTF-8', LC_ALL: 'bad value' }) });
  assert.deepEqual([shellLang.LANG, shellLang.LC_ALL], ['fr_FR.UTF-8', undefined]);
  const noShell = { PATH: '/usr/bin' };
  await applyShellPath({ env: noShell, platform: 'darwin', read: async () => null });
  assert.equal(noShell.LANG, DEFAULT_LANG);
  const fromTerminal = { PATH: '/usr/bin', LC_ALL: 'C' };
  await applyShellPath({ env: fromTerminal, platform: 'darwin', read: async () => ({ LANG: 'fr_FR.UTF-8' }) });
  assert.deepEqual([fromTerminal.LANG, fromTerminal.LC_ALL], [undefined, 'C'], 'a locale the app was started with is left alone');
  const linux = { PATH: '/usr/bin' };
  await applyShellPath({ env: linux, platform: 'linux', read: async () => null });
  assert.equal(linux.LANG, undefined, 'the default is for macOS apps only');
});

test('the real login shell answers with absolute folders', { skip: process.platform === 'win32' }, async () => {
  const value = await readShellPath();
  if (value === null) return; // no usable login shell on this machine
  assert.ok(value.split(':').every((entry) => entry.startsWith('/')));
  assert.ok(value.split(':').includes('/usr/bin'));
});
