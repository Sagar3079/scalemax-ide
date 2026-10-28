// Windows: how commands, MCP servers and key names are written there (lib/commands.cjs,
// src/shortcuts.mjs). These run on every system; CI also runs the whole suite on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { otherKeys, keyLabel } from '../src/shortcuts.mjs';

const require = createRequire(import.meta.url);
const { shellArgv, commandLine, platformEnvironment, windowsProgram } = require('../lib/commands.cjs');

test('a command line goes to cmd.exe in quotes, spawned verbatim so its own quotes survive', () => {
  assert.deepEqual(shellArgv('echo "a b" & dir', { platform: 'win32' }), ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '"echo "a b" & dir"']);
  assert.deepEqual(commandLine('dir', { platform: 'win32' }), { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"dir"'], windowsVerbatimArguments: true });
  assert.equal(commandLine('ls', { platform: 'darwin' }).windowsVerbatimArguments, false);
});

test('commands keep the variables Windows programs need, whatever case they are stored in', () => {
  const env = { SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', userprofile: 'C:\\Users\\a', TEMP: 'C:\\Temp', API_TOKEN: 'secret' };
  assert.deepEqual(platformEnvironment({ platform: 'win32', env }), {
    SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\a', TEMP: 'C:\\Temp',
  });
  assert.deepEqual(platformEnvironment({ platform: 'darwin', env }), {});
});

test('npx (a .cmd script) starts through cmd.exe with every argument quoted and escaped', () => {
  const env = { Path: 'C:\\nodejs;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const exists = (file) => ['C:\\nodejs\\npx.cmd', 'C:\\nodejs\\node.exe'].includes(file);
  const npx = windowsProgram('npx', ['-y', '@scope/server', 'a&b', 'say "hi"'], { platform: 'win32', env, exists });
  assert.equal(npx.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(npx.windowsVerbatimArguments, true);
  assert.deepEqual(npx.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(npx.args[3], '"C:\\nodejs\\npx.cmd ^"-y^" ^"@scope/server^" ^"a^&b^" ^"say^ \\^"hi\\^"^""');
  // A real program runs directly, by its full path.
  assert.deepEqual(windowsProgram('node', ['x.js'], { platform: 'win32', env, exists }), { file: 'C:\\nodejs\\node.exe', args: ['x.js'], windowsVerbatimArguments: false });
  // Not found: left to spawn, which reports it. Elsewhere nothing changes.
  assert.deepEqual(windowsProgram('nope', [], { platform: 'win32', env, exists }), { file: 'nope', args: [], windowsVerbatimArguments: false });
  assert.deepEqual(windowsProgram('npx', ['-y'], { platform: 'darwin' }), { file: 'npx', args: ['-y'], windowsVerbatimArguments: false });
});

test('a shim in node_modules\\.bin is escaped twice, as it runs through cmd.exe again', () => {
  const env = { PATH: 'C:\\p\\node_modules\\.bin', PATHEXT: '.CMD' };
  const shim = windowsProgram('tool', ['a&b'], { platform: 'win32', env, exists: (file) => file === 'C:\\p\\node_modules\\.bin\\tool.cmd' });
  assert.equal(shim.args[3], '"C:\\p\\node_modules\\.bin\\tool.cmd ^^^"a^^^&b^^^""');
});

test('hints written with Mac keys read as Ctrl, Shift and Enter elsewhere', () => {
  assert.equal(otherKeys('Recent sessions (⌘⇧O)'), 'Recent sessions (Ctrl+Shift+O)');
  assert.equal(otherKeys('⌘S save · ⌘F find · ⌘/ comment'), 'Ctrl+S save · Ctrl+F find · Ctrl+/ comment');
  assert.equal(otherKeys('one line (⌘↩ commits)'), 'one line (Ctrl+Enter commits)');
  assert.equal(otherKeys('↩ open · ⇧↩ new line'), 'Enter open · Shift+Enter new line');
  assert.equal(otherKeys('No keys here.'), 'No keys here.');
  assert.equal(keyLabel({ mod: true, shift: true, key: 'O' }, { mac: false }), 'Ctrl+Shift+O');
});
