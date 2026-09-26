'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCliConnect, GITHUB_MCP_URL, DEVICE_URL } = require('../lib/cli-auth.cjs');

const EXISTING = `gho_${'a'.repeat(36)}`;
const FRESH = `gho_${'b'.repeat(36)}`;

function fakeGhBinary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-fake-gh-'));
  const file = path.join(dir, 'gh');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

// A scripted gh: `script(args, env, child)` drives each spawned process.
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, write() {}, end() {} };
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    child.finish = (code, stdout = '', stderr = '') => setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    calls.push({ command, args, env: options.env, child });
    script(args, options.env, child);
    return child;
  };
  return { spawnImpl, calls };
}

function fakeStores({ valid = [EXISTING, FRESH], mcpFails = false } = {}) {
  const state = { saved: [], removed: [], mcpSaved: [], mcpRemoved: [], token: null };
  const connectors = {
    save({ id, token }) { state.saved.push({ id, token }); state.token = token; return { id }; },
    async test() { return valid.includes(state.token) ? { ok: true, supported: true } : { ok: false, message: 'GitHub rejected the stored token.' }; },
    remove({ id }) { state.removed.push(id); state.token = null; return { removed: true }; },
  };
  const mcp = {
    list: () => [],
    save(input) { state.mcpSaved.push(input); return { id: 'github' }; },
    async test() {
      if (mcpFails) throw new Error('MCP server rejected the credentials (HTTP 403).');
      return { tools: [{ name: 'get_me' }, { name: 'search_repositories' }] };
    },
    remove({ id }) { state.mcpRemoved.push(id); return { removed: true }; },
  };
  return { connectors, mcp, state };
}

const LOGIN_OUTPUT = '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';

test('an existing gh login connects at once and feeds GitHub MCP', async (t) => {
  const gh = fakeGhBinary(t);
  const { spawnImpl, calls } = fakeSpawn((args, _env, child) => child.finish(0, `${EXISTING}\n`));
  const stores = fakeStores();
  const opened = [];
  const cli = createCliConnect({
    ...stores, spawnImpl, locations: [gh], platform: 'darwin',
    env: { PATH: '/usr/bin', GH_TOKEN: 'env-token-should-not-leak', HOME: '/Users/you' },
  });
  assert.deepEqual(cli.available(), { github: { installed: true } });
  const result = await cli.start({ id: 'github' }, { openExternal: (url) => opened.push(url) });
  assert.deepEqual(result, { status: 'connected', ok: true, source: 'existing', toolCount: 2, mcpError: null });
  assert.equal(opened.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, gh);
  assert.deepEqual(calls[0].args, ['auth', 'token', '--hostname', 'github.com']);
  assert.equal(calls[0].env.GH_TOKEN, undefined);
  assert.match(calls[0].env.PATH, /\/opt\/homebrew\/bin/);
  assert.deepEqual(stores.state.saved, [{ id: 'github', token: EXISTING }]);
  assert.deepEqual(stores.state.mcpSaved, [{
    name: 'GitHub', transport: 'http', url: GITHUB_MCP_URL,
    headers: { Authorization: `Bearer ${EXISTING}` }, connector: 'github', enabled: true,
  }]);
  // The token never appears in what the renderer receives.
  assert.equal(JSON.stringify(result).includes(EXISTING), false);
});

test('without a gh login, the device flow runs in a throwaway config and the code is shown', async (t) => {
  const gh = fakeGhBinary(t);
  let loginChild = null;
  const { spawnImpl, calls } = fakeSpawn((args, env, child) => {
    if (args[1] === 'token') {
      if (env.GH_CONFIG_DIR) child.finish(0, `${FRESH}\n`);
      else child.finish(1, '', 'no oauth token found for github.com\n');
      return;
    }
    loginChild = child;
    setImmediate(() => child.stderr.emit('data', Buffer.from(LOGIN_OUTPUT)));
  });
  const stores = fakeStores();
  const opened = [];
  const copied = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-cli-tmp-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const cli = createCliConnect({
    ...stores, spawnImpl, locations: [gh], platform: 'darwin', tmpDir, env: { PATH: '' },
    clipboard: { writeText: (value) => copied.push(value) },
  });
  const started = await cli.start({ id: 'github' }, { openExternal: (url) => opened.push(url) });
  assert.deepEqual(started, { status: 'code', code: 'AB12-CD34', verificationUri: DEVICE_URL, copied: true });
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.deepEqual(copied, ['AB12-CD34']);
  const login = calls.find((call) => call.args[1] === 'login');
  assert.deepEqual(login.args, [
    'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key', '--insecure-storage',
  ]);
  const configDir = login.env.GH_CONFIG_DIR;
  assert.ok(configDir.startsWith(path.join(tmpDir, 'scalemax-gh-')));
  assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
  assert.equal(login.env.GH_BROWSER, '/usr/bin/true');

  const waiting = cli.wait({ id: 'github' });
  loginChild.finish(0);
  const done = await waiting;
  assert.deepEqual(done, { status: 'connected', ok: true, source: 'login', toolCount: 2, mcpError: null });
  assert.deepEqual(stores.state.saved.map((entry) => entry.token), [FRESH]);
  // The throwaway config (which briefly held the token in plain text) is gone.
  assert.equal(fs.existsSync(configDir), false);
  await assert.rejects(() => cli.wait({ id: 'github' }), (error) => error.code === 'NOT_PENDING');
});

test('a stale gh login falls back to a fresh sign-in', async (t) => {
  const gh = fakeGhBinary(t);
  const { spawnImpl } = fakeSpawn((args, env, child) => {
    if (args[1] === 'token') child.finish(0, `${env.GH_CONFIG_DIR ? FRESH : EXISTING}\n`);
    else {
      setImmediate(() => child.stderr.emit('data', Buffer.from(LOGIN_OUTPUT)));
      setTimeout(() => child.finish(0), 20);
    }
  });
  const stores = fakeStores({ valid: [FRESH] });
  const cli = createCliConnect({ ...stores, spawnImpl, locations: [gh], env: { PATH: '' } });
  const started = await cli.start({ id: 'github' }, { openExternal() {} });
  assert.equal(started.status, 'code');
  assert.deepEqual(stores.state.removed, ['github']);
  assert.equal((await cli.wait({ id: 'github' })).source, 'login');
});

test('cancelling stops gh, removes the throwaway config and rejects the wait', async (t) => {
  const gh = fakeGhBinary(t);
  let loginChild = null;
  const { spawnImpl } = fakeSpawn((args, _env, child) => {
    if (args[1] === 'token') child.finish(1);
    else {
      loginChild = child;
      setImmediate(() => child.stderr.emit('data', Buffer.from(LOGIN_OUTPUT)));
    }
  });
  const stores = fakeStores();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-cli-cancel-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const cancellable = createCliConnect({ ...stores, spawnImpl, locations: [gh], env: { PATH: '' }, tmpDir });
  await cancellable.start({ id: 'github' }, { openExternal() {} });
  assert.equal(fs.readdirSync(tmpDir).length, 1);
  const waiting = cancellable.wait({ id: 'github' });
  assert.deepEqual(cancellable.cancel({ id: 'github' }), { cancelled: true });
  await assert.rejects(waiting, (error) => error.code === 'CANCELLED');
  assert.equal(loginChild.killed, true);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  assert.deepEqual(stores.state.saved, []);
  assert.deepEqual(cancellable.cancel({ id: 'github' }), { cancelled: false });
});

test('clean failures: gh missing, other connectors, rejected token, MCP unavailable', async (t) => {
  const stores = fakeStores();
  const missing = createCliConnect({ ...stores, spawnImpl: () => { throw new Error('unused'); }, locations: [], env: { PATH: '' } });
  assert.deepEqual(missing.available(), { github: { installed: false } });
  await assert.rejects(() => missing.start({ id: 'github' }, { openExternal() {} }), (error) => error.code === 'CLI_NOT_FOUND');
  await assert.rejects(() => missing.start({ id: 'gitlab' }, { openExternal() {} }), (error) => error.code === 'CLI_UNSUPPORTED');

  const gh = fakeGhBinary(t);
  // gh exits before printing a code (for example an old gh without --insecure-storage).
  const early = fakeSpawn((args, _env, child) => child.finish(1, '', 'unknown flag: --insecure-storage\n'));
  const old = createCliConnect({ ...stores, spawnImpl: early.spawnImpl, locations: [gh], env: { PATH: '' } });
  await assert.rejects(() => old.start({ id: 'github' }, { openExternal() {} }), /exited before showing a sign-in code/);

  // The token works but GitHub's MCP server does not: keep the token, report the missing tools.
  const failing = fakeStores({ mcpFails: true });
  const ok = fakeSpawn((args, _env, child) => child.finish(0, `${EXISTING}\n`));
  const cli = createCliConnect({ ...failing, spawnImpl: ok.spawnImpl, locations: [gh], env: { PATH: '' } });
  const result = await cli.start({ id: 'github' }, { openExternal() {} });
  assert.equal(result.status, 'connected');
  assert.equal(result.toolCount, 0);
  assert.match(result.mcpError, /HTTP 403/);
  assert.deepEqual(failing.state.mcpRemoved, ['github']);
  assert.equal(failing.state.token, EXISTING);
});
