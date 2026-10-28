'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, pickRelease, compareVersions, assetName, trustedHost, RELEASES_URL } = require('../lib/updates.cjs');

const BASE = 'https://github.com/Sagar3079/scalemax-ide/releases';
const FILE = Buffer.from('a new version of the app');
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');

function release(version, { prerelease = /-/.test(version), draft = false, files = null } = {}) {
  const tag = `v${version}`;
  const names = files || [assetName(version, { platform: 'darwin', arch: 'arm64' }), assetName(version, { platform: 'win32', arch: 'x64' })];
  return {
    tag_name: tag, draft, prerelease, html_url: `${BASE}/tag/${tag}`, published_at: '2026-10-28T10:00:00Z',
    assets: names.map((name) => ({ name, size: FILE.length, digest: `sha256:${SHA}`, browser_download_url: `${BASE}/download/${tag}/${name}` })),
  };
}

function response(body, { status = 200, url = '' } = {}) {
  const res = new Response(body, { status });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

function makeUpdater(t, { current = '1.0.0-beta.5', platform = 'darwin', arch = 'arm64', releases = [], file = FILE, downloadUrl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-updates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { fetch: [], opened: [], spawned: [], quit: 0, changes: [] };
  const updater = createUpdater({
    current, platform, arch, dir: path.join(dir, 'updates'),
    fetchImpl: async (url, options) => {
      calls.fetch.push({ url, options });
      if (url === RELEASES_URL) return response(JSON.stringify(releases));
      return response(file, { url: downloadUrl || 'https://release-assets.githubusercontent.com/github-production-release-asset/1' });
    },
    openPath: async (target) => { calls.opened.push(target); return ''; },
    spawnImpl: (command, args, options) => { calls.spawned.push({ command, args, options, bytes: fs.readFileSync(command) }); return { unref() {} }; },
    quit: () => { calls.quit += 1; },
    onChange: (state) => calls.changes.push(state.status),
    now: () => 1000,
  });
  return { updater, calls, dir: path.join(dir, 'updates') };
}

test('versions are ordered like semantic versions, a beta before its release', () => {
  const ordered = ['1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 1; i < ordered.length; i += 1) assert.ok(compareVersions(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareVersions('1.0.0-beta.5', '1.0.0-beta.5'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'));
});

test('the newest later release is picked, with this computer\'s file and its SHA-256', () => {
  const releases = [release('1.0.0-beta.4'), release('1.0.0-beta.7'), release('1.0.0-beta.6'), release('1.0.0-beta.8', { draft: true })];
  const mac = pickRelease(releases, { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.version, '1.0.0-beta.7');
  assert.equal(mac.page, `${BASE}/tag/v1.0.0-beta.7`);
  assert.deepEqual(mac.asset, { name: 'ScaleMax-IDE-1.0.0-beta.7-arm64.dmg', size: FILE.length, url: `${BASE}/download/v1.0.0-beta.7/ScaleMax-IDE-1.0.0-beta.7-arm64.dmg`, sha256: SHA });
  const win = pickRelease(releases, { current: '1.0.0-beta.5', platform: 'win32', arch: 'x64' });
  assert.equal(win.asset.name, 'ScaleMax-IDE-Setup-1.0.0-beta.7-x64.exe');
  assert.equal(pickRelease(releases, { current: '1.0.0-beta.7', platform: 'darwin', arch: 'arm64' }), null);
});

test('a stable version is not offered betas; a beta is offered the stable release', () => {
  const releases = [release('1.1.0-beta.1'), release('1.0.0', { prerelease: false })];
  assert.equal(pickRelease(releases, { current: '1.0.0', platform: 'darwin', arch: 'arm64' }), null);
  assert.equal(pickRelease(releases, { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' }).version, '1.1.0-beta.1');
  assert.equal(pickRelease([release('1.0.0', { prerelease: false })], { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' }).version, '1.0.0');
});

test('a release without a usable file for this computer is still found, with no download', () => {
  const noIntel = pickRelease([release('1.0.0-beta.6')], { current: '1.0.0-beta.5', platform: 'darwin', arch: 'x64' });
  assert.equal(noIntel.version, '1.0.0-beta.6');
  assert.equal(noIntel.asset, null);
  const unsigned = release('1.0.0-beta.6');
  delete unsigned.assets[0].digest;
  assert.equal(pickRelease([unsigned], { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' }).asset, null);
  const elsewhere = release('1.0.0-beta.6');
  elsewhere.assets[0].browser_download_url = 'https://example.com/ScaleMax-IDE-1.0.0-beta.6-arm64.dmg';
  assert.equal(pickRelease([elsewhere], { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' }).asset, null);
  assert.equal(pickRelease([release('1.0.0-beta.6')], { current: '1.0.0-beta.5', platform: 'linux', arch: 'x64' }).asset, null);
  assert.equal(pickRelease('not a list', { current: '1.0.0-beta.5', platform: 'darwin', arch: 'arm64' }), null);
});

test('only github.com and GitHub\'s download hosts are trusted', () => {
  assert.equal(trustedHost('https://github.com/x'), true);
  assert.equal(trustedHost('https://objects.githubusercontent.com/x'), true);
  assert.equal(trustedHost('http://github.com/x'), false);
  assert.equal(trustedHost('https://github.com.example.com/x'), false);
  assert.equal(trustedHost('https://evilgithubusercontent.com/x'), false);
});

test('check reports an update, or that this version is current, or why it failed', async (t) => {
  const { updater, calls } = makeUpdater(t, { releases: [release('1.0.0-beta.6')] });
  const found = await updater.check();
  assert.equal(found.status, 'available');
  assert.deepEqual(found.release, { version: '1.0.0-beta.6', page: `${BASE}/tag/v1.0.0-beta.6`, publishedAt: '2026-10-28T10:00:00Z', downloadable: true, size: FILE.length });
  assert.equal(calls.fetch[0].options.redirect, 'error');
  assert.deepEqual(calls.changes, ['checking', 'available']);

  assert.equal((await makeUpdater(t, { releases: [release('1.0.0-beta.5')] }).updater.check()).status, 'current');

  const limited = createUpdater({ current: '1.0.0-beta.5', dir: os.tmpdir(), fetchImpl: async () => response('{}', { status: 403 }), openPath: async () => '', spawnImpl: () => ({}), quit: () => {} });
  const result = await limited.check();
  assert.equal(result.status, 'error');
  assert.match(result.error, /limiting checks/);
  const offline = createUpdater({ current: '1.0.0-beta.5', dir: os.tmpdir(), fetchImpl: async () => { throw new TypeError('fetch failed'); }, openPath: async () => '', spawnImpl: () => ({}), quit: () => {} });
  assert.match((await offline.check()).error, /Could not reach GitHub/);
});

test('two checks at once make one request', async (t) => {
  const { updater, calls } = makeUpdater(t, { releases: [release('1.0.0-beta.6')] });
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(a.status, 'available');
  assert.equal(b.status, 'available');
  assert.equal(calls.fetch.length, 1);
});

test('on macOS Update now downloads the checked .dmg and opens it', async (t) => {
  const { updater, calls, dir } = makeUpdater(t, { releases: [release('1.0.0-beta.6')] });
  const done = await updater.install();
  assert.equal(done.status, 'opened');
  const file = path.join(dir, 'ScaleMax-IDE-1.0.0-beta.6-arm64.dmg');
  assert.deepEqual(calls.opened, [file]);
  assert.deepEqual(fs.readFileSync(file), FILE);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.equal(calls.quit, 0);
  assert.deepEqual(calls.changes.slice(0, 3), ['checking', 'available', 'downloading']);
});

test('on Windows Update now runs the installer silently and quits so it can replace the app', async (t) => {
  const { updater, calls, dir } = makeUpdater(t, { platform: 'win32', arch: 'x64', releases: [release('1.0.0-beta.6')] });
  await updater.check();
  const done = await updater.install();
  assert.equal(done.status, 'installing');
  assert.equal(calls.spawned.length, 1);
  assert.equal(calls.spawned[0].command, path.join(dir, 'ScaleMax-IDE-Setup-1.0.0-beta.6-x64.exe'));
  assert.deepEqual(calls.spawned[0].args, ['/S', '--updated', '--force-run']);
  assert.equal(calls.spawned[0].options.detached, true);
  assert.deepEqual(calls.spawned[0].bytes, FILE);
  assert.equal(calls.quit, 1);
  assert.equal(calls.opened.length, 0);
});

test('a download that does not match GitHub\'s checksum, or comes from elsewhere, is not used', async (t) => {
  const changed = makeUpdater(t, { releases: [release('1.0.0-beta.6')], file: Buffer.from('a new version of the apX') });
  const result = await changed.updater.install();
  assert.equal(result.status, 'error');
  assert.match(result.error, /does not match/);
  assert.equal(changed.calls.opened.length, 0);
  assert.deepEqual(fs.readdirSync(changed.dir), []);

  const longer = makeUpdater(t, { platform: 'win32', arch: 'x64', releases: [release('1.0.0-beta.6')], file: Buffer.concat([FILE, Buffer.from('!')]) });
  assert.match((await longer.updater.install()).error, /larger than GitHub said/);
  assert.equal(longer.calls.spawned.length, 0);
  assert.equal(longer.calls.quit, 0);

  const redirected = makeUpdater(t, { releases: [release('1.0.0-beta.6')], downloadUrl: 'https://example.com/file.dmg' });
  assert.match((await redirected.updater.install()).error, /somewhere other than GitHub/);
  assert.equal(redirected.calls.opened.length, 0);
});

test('Update now without a newer release, or without a file for this computer, says so', async (t) => {
  await assert.rejects(makeUpdater(t, { releases: [] }).updater.install(), /up to date/);
  await assert.rejects(makeUpdater(t, { arch: 'x64', releases: [release('1.0.0-beta.6')] }).updater.install(), /no download for this computer/);
});
