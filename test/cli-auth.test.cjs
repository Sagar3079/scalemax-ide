'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createCliConnect, verifyGithubSignature, CliAuthError, GITHUB_MCP_URL, DEVICE_URL } = require('../lib/cli-auth.cjs');

const EXISTING = `gho_${'a'.repeat(36)}`;
const FRESH = `gho_${'b'.repeat(36)}`;
const LOGIN_OUTPUT = '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
const LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'];

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeGhBinary(t) {
  const file = path.join(tempDir(t, 'scalemax-fake-gh-'), 'gh');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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

// gh with no login until `gh auth login` succeeds; `loginDone()` finishes the browser approval.
function loginScript({ before = null } = {}) {
  const state = { loggedIn: false, loginChild: null };
  const script = (args, _env, child) => {
    if (args[1] === 'token') {
      const token = state.loggedIn ? FRESH : before;
      if (token) child.finish(0, `${token}\n`);
      else child.finish(1, '', 'no oauth token found for github.com\n');
      return;
    }
    state.loginChild = child;
    setImmediate(() => child.stderr.emit('data', Buffer.from(LOGIN_OUTPUT)));
  };
  state.loginDone = () => {
    state.loggedIn = true;
    state.loginChild.finish(0);
  };
  return { script, state };
}

// `check(token)` can answer for GitHub instead (an outage, a timeout); by default `valid` tokens
// pass and the rest get a 401.
function fakeStores({ valid = [EXISTING, FRESH], mcpFails = false, check = null, stored = null } = {}) {
  const state = { saved: [], removed: [], checked: [], mcpSaved: [], mcpRemoved: [], token: stored };
  const connectors = {
    // Like lib/connectors.cjs: the token replaces the stored one only once GitHub accepted it.
    async saveVerified({ id, token }) {
      state.checked.push(token);
      const outcome = check?.(token) || (valid.includes(token)
        ? { ok: true, supported: true, status: 200, message: 'Connector token verified.' }
        : { ok: false, supported: true, status: 401, message: 'Provider rejected the stored token.' });
      if (outcome.ok) {
        state.saved.push({ id, token });
        state.token = token;
      }
      return outcome;
    },
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

test('an existing gh login connects at once and feeds GitHub MCP', async (t) => {
  const gh = fakeGhBinary(t);
  const { spawnImpl, calls } = fakeSpawn((args, _env, child) => child.finish(0, `${EXISTING}\n`));
  const stores = fakeStores();
  const opened = [];
  const cli = createCliConnect({
    ...stores, spawnImpl, locations: [gh], platform: 'darwin', toolsDir: tempDir(t, 'scalemax-tools-'),
    env: { PATH: '/usr/bin', GH_TOKEN: 'env-token-should-not-leak', HOME: '/Users/you' },
  });
  assert.deepEqual(cli.available(), { github: { installed: true, installable: true } });
  const result = await cli.start({ id: 'github' }, { openExternal: (url) => opened.push(url) });
  assert.deepEqual(result, { status: 'connected', installed: false, ok: true, source: 'existing', toolCount: 2, mcpError: null });
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
  assert.deepEqual(cli.status({ id: 'github' }), { phase: 'idle' });
});

test('without a gh login, the CLI itself is logged in and the code is shown', async (t) => {
  const gh = fakeGhBinary(t);
  const flow = loginScript();
  const { spawnImpl, calls } = fakeSpawn(flow.script);
  const stores = fakeStores();
  const opened = [];
  const copied = [];
  const cli = createCliConnect({
    ...stores, spawnImpl, locations: [gh], platform: 'darwin', env: { PATH: '', GH_CONFIG_DIR: '/Users/you/.config/gh' },
    clipboard: { writeText: (value) => copied.push(value) },
  });
  const started = await cli.start({ id: 'github' }, { openExternal: (url) => opened.push(url) });
  assert.deepEqual(started, { status: 'code', code: 'AB12-CD34', verificationUri: DEVICE_URL, copied: true, installed: false });
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.deepEqual(copied, ['AB12-CD34']);
  assert.deepEqual(cli.status({ id: 'github' }), { phase: 'approve' });
  const login = calls.find((call) => call.args[1] === 'login');
  assert.deepEqual(login.args, LOGIN_ARGS);
  // A normal, persistent gh login: the user's own gh config, keychain storage, no browser from gh.
  assert.equal(login.env.GH_CONFIG_DIR, '/Users/you/.config/gh');
  assert.equal(login.args.includes('--insecure-storage'), false);
  assert.equal(login.env.GH_BROWSER, '/usr/bin/true');

  const waiting = cli.wait({ id: 'github' });
  flow.state.loginDone();
  const done = await waiting;
  assert.deepEqual(done, { status: 'connected', installed: false, ok: true, source: 'login', toolCount: 2, mcpError: null });
  assert.deepEqual(stores.state.saved.map((entry) => entry.token), [FRESH]);
  await assert.rejects(() => cli.wait({ id: 'github' }), (error) => error.code === 'NOT_PENDING');
});

test('a stale gh login is replaced by a fresh CLI login', async (t) => {
  const gh = fakeGhBinary(t);
  const flow = loginScript({ before: EXISTING });
  const { spawnImpl } = fakeSpawn(flow.script);
  const stores = fakeStores({ valid: [FRESH] });
  const cli = createCliConnect({ ...stores, spawnImpl, locations: [gh], env: { PATH: '' } });
  const started = await cli.start({ id: 'github' }, { openExternal() {} });
  assert.equal(started.status, 'code');
  // The rejected token was checked but never stored; nothing stored was removed.
  assert.deepEqual(stores.state.checked, [EXISTING]);
  assert.deepEqual(stores.state.saved, []);
  assert.deepEqual(stores.state.removed, []);
  const waiting = cli.wait({ id: 'github' });
  flow.state.loginDone();
  assert.equal((await waiting).source, 'login');
  assert.deepEqual(stores.state.saved.map((entry) => entry.token), [FRESH]);
});

test('GitHub being unreachable keeps the stored connection and reports the error instead of a new login', async (t) => {
  const gh = fakeGhBinary(t);
  const flow = loginScript({ before: EXISTING });
  const { spawnImpl, calls } = fakeSpawn(flow.script);
  for (const outcome of [
    { ok: false, supported: true, message: 'Connector validation timed out after 15 seconds.' },
    { ok: false, supported: true, status: 503, message: 'Provider validation failed with HTTP status 503.' },
  ]) {
    const stores = fakeStores({ stored: 'gho_working_token_stored_before', check: () => outcome });
    const cli = createCliConnect({ ...stores, spawnImpl, locations: [gh], env: { PATH: '' } });
    await assert.rejects(
      () => cli.start({ id: 'github' }, { openExternal() {} }),
      (error) => error instanceof CliAuthError && error.code === 'VALIDATION_FAILED' && error.message === outcome.message,
    );
    assert.equal(stores.state.token, 'gho_working_token_stored_before');
    assert.deepEqual(stores.state.removed, []);
    assert.deepEqual(cli.status({ id: 'github' }), { phase: 'idle' });
  }
  assert.equal(calls.some((call) => call.args[1] === 'login'), false, 'no device-code login was started');

  // The same after a fresh login: the error is reported, and the stored connection stays.
  const fresh = loginScript();
  const offline = fakeStores({ stored: 'gho_working_token_stored_before', check: () => ({ ok: false, supported: true, message: 'Could not reach the provider to validate the token.' }) });
  const cli = createCliConnect({ ...offline, spawnImpl: fakeSpawn(fresh.script).spawnImpl, locations: [gh], env: { PATH: '' } });
  await cli.start({ id: 'github' }, { openExternal() {} });
  const waiting = cli.wait({ id: 'github' });
  fresh.state.loginDone();
  await assert.rejects(waiting, (error) => error.code === 'VALIDATION_FAILED' && /Could not reach/.test(error.message));
  assert.equal(offline.state.token, 'gho_working_token_stored_before');
});

test('a login that fails right after showing the code still reports its error to wait()', async (t) => {
  const gh = fakeGhBinary(t);
  const { spawnImpl } = fakeSpawn((args, _env, child) => {
    if (args[1] === 'token') {
      child.finish(1, '', 'no oauth token found for github.com\n');
      return;
    }
    // gh prints the code, then exits with an error before the user could approve anything.
    child.finish(1, '', LOGIN_OUTPUT);
  });
  const cli = createCliConnect({ ...fakeStores(), spawnImpl, locations: [gh], env: { PATH: '' } });
  const started = await cli.start({ id: 'github' }, { openExternal() {} });
  assert.equal(started.status, 'code');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(cli.status({ id: 'github' }), { phase: 'idle' });
  await assert.rejects(() => cli.wait({ id: 'github' }), (error) => error.code !== 'NOT_PENDING' && /did not complete/.test(error.message));
  // Reported once; after that nothing is in progress.
  await assert.rejects(() => cli.wait({ id: 'github' }), (error) => error.code === 'NOT_PENDING');
});

test('cancelling stops the gh login and rejects the wait', async (t) => {
  const gh = fakeGhBinary(t);
  const flow = loginScript();
  const { spawnImpl } = fakeSpawn(flow.script);
  const stores = fakeStores();
  const cli = createCliConnect({ ...stores, spawnImpl, locations: [gh], env: { PATH: '' } });
  await cli.start({ id: 'github' }, { openExternal() {} });
  const waiting = cli.wait({ id: 'github' });
  assert.deepEqual(cli.cancel({ id: 'github' }), { cancelled: true });
  await assert.rejects(waiting, (error) => error.code === 'CANCELLED');
  assert.equal(flow.state.loginChild.killed, true);
  assert.deepEqual(stores.state.saved, []);
  assert.deepEqual(cli.cancel({ id: 'github' }), { cancelled: false });
});

test('clean failures: other connectors, gh exiting early, rejected token, MCP unavailable', async (t) => {
  const stores = fakeStores();
  const cli0 = createCliConnect({ ...stores, spawnImpl: () => { throw new Error('unused'); }, locations: [], env: { PATH: '' } });
  await assert.rejects(() => cli0.start({ id: 'gitlab' }, { openExternal() {} }), (error) => error.code === 'CLI_UNSUPPORTED');

  const gh = fakeGhBinary(t);
  const early = fakeSpawn((args, _env, child) => child.finish(1, '', 'unknown flag\n'));
  const old = createCliConnect({ ...stores, spawnImpl: early.spawnImpl, locations: [gh], env: { PATH: '' } });
  await assert.rejects(() => old.start({ id: 'github' }, { openExternal() {} }), /exited before showing a sign-in code/);
  assert.deepEqual(old.status({ id: 'github' }), { phase: 'idle' });
  await assert.rejects(() => old.wait({ id: 'github' }), (error) => error.code === 'NOT_PENDING');

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

// ---- Automatic GitHub CLI install --------------------------------------------

const VERSION = '9.9.9';
const ZIP_NAME = `gh_${VERSION}_macOS_arm64.zip`;
const BASE = `https://github.com/cli/cli/releases/download/v${VERSION}`;

// A release zip laid out like the official one, with a gh that prints its version.
function buildRelease(t) {
  const dir = tempDir(t, 'scalemax-release-');
  const folder = path.join(dir, `gh_${VERSION}_macOS_arm64`);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'gh'), `#!/bin/sh\necho "gh version ${VERSION} (test)"\n`, { mode: 0o755 });
  const zip = path.join(dir, ZIP_NAME);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', folder, zip]);
  const bytes = fs.readFileSync(zip);
  return { bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function withUrl(response, url) {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function releaseFetch(release, { checksum = release.sha, zipHost = 'release-assets.githubusercontent.com' } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://api.github.com/repos/cli/cli/releases/latest') {
      return withUrl(new Response(JSON.stringify({ tag_name: `v${VERSION}` }), { status: 200 }), url);
    }
    if (url === `${BASE}/gh_${VERSION}_checksums.txt`) {
      const text = `${'0'.repeat(64)}  gh_${VERSION}_linux_amd64.tar.gz\n${checksum}  ${ZIP_NAME}\n`;
      return withUrl(new Response(text, { status: 200 }), 'https://release-assets.githubusercontent.com/sums');
    }
    if (url === `${BASE}/${ZIP_NAME}`) {
      return withUrl(new Response(release.bytes, { status: 200, headers: { 'content-length': String(release.bytes.length) } }),
        `https://${zipHost}/zip`);
    }
    return withUrl(new Response('not found', { status: 404 }), url);
  };
  return { fetchImpl, calls };
}

const onMacOS = process.platform === 'darwin';

test('a missing gh is downloaded, verified, installed, then logged in', { skip: !onMacOS }, async (t) => {
  const release = buildRelease(t);
  const toolsDir = tempDir(t, 'scalemax-tools-');
  const net = releaseFetch(release);
  const verified = [];
  const flow = loginScript();
  const { spawnImpl, calls } = fakeSpawn(flow.script);
  const stores = fakeStores();
  const cli = createCliConnect({
    ...stores, spawnImpl, locations: [], platform: 'darwin', arch: 'arm64', env: { PATH: '' }, toolsDir,
    fetchImpl: net.fetchImpl,
    verifyBinary: async (file) => { verified.push(file); },
  });
  assert.deepEqual(cli.available(), { github: { installed: false, installable: true } });
  const started = await cli.start({ id: 'github' }, { openExternal() {} });
  assert.equal(started.status, 'code');
  assert.equal(started.installed, true);
  const installed = path.join(toolsDir, 'gh', VERSION, 'bin', 'gh');
  assert.ok(fs.statSync(installed).isFile());
  assert.equal(verified.length, 1);
  assert.match(verified[0], new RegExp(`gh_${VERSION}_macOS_arm64/bin/gh$`));
  // The installed copy is the gh that logs in; no staging folders are left behind.
  assert.ok(calls.every((call) => call.command === installed));
  assert.deepEqual(fs.readdirSync(path.join(toolsDir, 'gh')), [VERSION]);
  assert.deepEqual(cli.available(), { github: { installed: true, installable: true } });
  const waiting = cli.wait({ id: 'github' });
  flow.state.loginDone();
  assert.equal((await waiting).installed, true);

  // Next time the installed copy is used without downloading again.
  const again = createCliConnect({
    ...fakeStores(), spawnImpl: fakeSpawn((args, _env, child) => child.finish(0, `${EXISTING}\n`)).spawnImpl,
    locations: [], platform: 'darwin', arch: 'arm64', env: { PATH: '' }, toolsDir,
    fetchImpl: async () => { throw new Error('should not download'); },
  });
  assert.equal((await again.start({ id: 'github' }, { openExternal() {} })).installed, false);
});

test('a download that fails a check is never installed or run', { skip: !onMacOS }, async (t) => {
  const release = buildRelease(t);
  const cases = [
    [{ checksum: 'f'.repeat(64) }, null, 'CLI_UNTRUSTED'],
    [{ zipHost: 'evil.example.com' }, null, 'DOWNLOAD_FAILED'],
    [{}, async () => { throw new CliAuthError('unsigned', 'CLI_UNTRUSTED'); }, 'CLI_UNTRUSTED'],
  ];
  for (const [options, verifyBinary, code] of cases) {
    const toolsDir = tempDir(t, 'scalemax-tools-');
    const { spawnImpl, calls } = fakeSpawn(() => { throw new Error('gh must not run'); });
    const cli = createCliConnect({
      ...fakeStores(), spawnImpl, locations: [], platform: 'darwin', arch: 'arm64', env: { PATH: '' }, toolsDir,
      fetchImpl: releaseFetch(release, options).fetchImpl,
      verifyBinary: verifyBinary || (async () => {}),
    });
    await assert.rejects(() => cli.start({ id: 'github' }, { openExternal() {} }), (error) => error.code === code,
      `expected ${code} for ${JSON.stringify(options)}`);
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(toolsDir, 'gh')), []);
    assert.equal(cli.available().github.installed, false);
  }
});

test('automatic install is macOS-only; the real signature check refuses unsigned binaries', { skip: !onMacOS }, async (t) => {
  const linux = createCliConnect({ ...fakeStores(), locations: [], platform: 'linux', arch: 'x64', env: { PATH: '' } });
  assert.deepEqual(linux.available(), { github: { installed: false, installable: false } });
  await assert.rejects(() => linux.start({ id: 'github' }, { openExternal() {} }), (error) => error.code === 'CLI_NOT_FOUND');
  await assert.rejects(() => verifyGithubSignature(fakeGhBinary(t)), (error) => error.code === 'CLI_UNTRUSTED');
});
