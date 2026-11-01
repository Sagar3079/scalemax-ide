'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReporter, osLabel, REPORT_URL } = require('../lib/bug-report.cjs');

const RELAY = 'https://relay.example/report';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE = 'The editor froze after Undo all.';

// The two calls lib/state.cjs's store offers that the reporter uses.
function memoryStore(initial = {}) {
  let data = { ...initial };
  return {
    readAll: () => data,
    update: (change) => { const draft = structuredClone(data); change(draft); data = draft; return data; },
    get data() { return data; },
  };
}
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function reporter(overrides = {}) {
  const calls = [];
  const store = overrides.store || memoryStore();
  const fetchImpl = overrides.fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    return answer(200, { ok: true, remaining: 2, resetAt: '2026-11-02T10:00:00.000Z' });
  });
  const made = createReporter({
    url: RELAY, version: '1.0.0-beta.8', platform: 'darwin', arch: 'arm64', systemVersion: '15.1.0', release: '24.1.0',
    ...overrides, fetchImpl, store,
  });
  return { made, calls, store };
}

test('the system is named the way people know it', () => {
  assert.equal(osLabel({ platform: 'darwin', arch: 'arm64', systemVersion: '15.1.0' }), 'macOS 15.1 (arm64)');
  assert.equal(osLabel({ platform: 'darwin', arch: 'arm64', systemVersion: '14.7.1' }), 'macOS 14.7.1 (arm64)');
  assert.equal(osLabel({ platform: 'win32', arch: 'x64', systemVersion: '10.0.22631' }), 'Windows 11 (build 22631, x64)');
  assert.equal(osLabel({ platform: 'win32', arch: 'x64', systemVersion: '10.0.19045' }), 'Windows 10 (build 19045, x64)');
  assert.equal(osLabel({ platform: 'linux', arch: 'x64', systemVersion: '6.8.0-45-generic', release: '6.8.0-45-generic' }), 'linux 6.8.0-45-generic (x64)');
});

test('a report posts the message, the version and the system, with an install ID made once', async () => {
  const { made, calls, store } = reporter();
  assert.deepEqual(made.get(), { available: true, osLabel: 'macOS 15.1 (arm64)' });
  assert.equal(store.data.reportInstallId, undefined, 'no ID before the first report');
  assert.deepEqual(await made.send(`  ${MESSAGE}  `), { sent: true, remaining: 2, resetAt: '2026-11-02T10:00:00.000Z' });
  const id = store.data.reportInstallId;
  assert.match(id, UUID_V4);
  assert.equal(calls[0].url, RELAY);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['user-agent'], 'ScaleMax-IDE/1.0.0-beta.8');
  assert.deepEqual(JSON.parse(calls[0].init.body), { installId: id, message: MESSAGE, version: '1.0.0-beta.8', os: 'macOS 15.1 (arm64)' });
  await made.send('A second report from the same install.');
  assert.equal(JSON.parse(calls[1].init.body).installId, id);
});

test('a saved install ID is reused, and a damaged one replaced', async () => {
  const saved = '3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f';
  const kept = reporter({ store: memoryStore({ reportInstallId: saved }) });
  await kept.made.send(MESSAGE);
  assert.equal(JSON.parse(kept.calls[0].init.body).installId, saved);
  const damaged = reporter({ store: memoryStore({ reportInstallId: 'nope' }) });
  await damaged.made.send(MESSAGE);
  assert.match(damaged.store.data.reportInstallId, UUID_V4);
});

test('a message under 10 or over 2,000 characters is not sent', async () => {
  const { made, calls } = reporter();
  assert.deepEqual(await made.send('   short   '), { sent: false, code: 'INVALID' });
  assert.deepEqual(await made.send('x'.repeat(2001)), { sent: false, code: 'INVALID' });
  assert.deepEqual(await made.send(null), { sent: false, code: 'INVALID' });
  assert.equal(calls.length, 0);
});

test("the relay's refusals come back with their code and time", async () => {
  for (const [status, body, expected] of [
    [429, { ok: false, code: 'LIMIT', resetAt: '2026-11-02T10:00:00.000Z' }, { sent: false, code: 'LIMIT', resetAt: '2026-11-02T10:00:00.000Z' }],
    [429, { ok: false, code: 'NETWORK_LIMIT', resetAt: '2026-11-02T11:00:00.000Z' }, { sent: false, code: 'NETWORK_LIMIT', resetAt: '2026-11-02T11:00:00.000Z' }],
    [429, { ok: false, code: 'BUSY', resetAt: 'not a date' }, { sent: false, code: 'BUSY', resetAt: null }],
    [502, { ok: false, code: 'TELEGRAM' }, { sent: false, code: 'TELEGRAM', resetAt: null }],
    [400, { ok: false, code: 'INVALID' }, { sent: false, code: 'INVALID', resetAt: null }],
    [500, { ok: false, code: 'SOMETHING_ELSE' }, { sent: false, code: 'NETWORK', resetAt: null }],
    // The relay's own failures are not the person's to fix: they read as no connection (relay/README.md).
    [503, { ok: false, code: 'RELAY_ERROR' }, { sent: false, code: 'NETWORK', resetAt: null }],
    [503, { ok: false, code: 'MISCONFIGURED' }, { sent: false, code: 'NETWORK', resetAt: null }],
    [415, { ok: false, code: 'UNSUPPORTED_TYPE' }, { sent: false, code: 'NETWORK', resetAt: null }],
  ]) {
    const { made } = reporter({ fetchImpl: async () => answer(status, body) });
    assert.deepEqual(await made.send(MESSAGE), expected, body.code);
  }
  const { made } = reporter({ fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
  assert.deepEqual(await made.send(MESSAGE), { sent: false, code: 'NETWORK', resetAt: null });
});

test('no answer in time, or no network, is NETWORK', async () => {
  const hanging = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const slow = reporter({ fetchImpl: hanging, timeoutMs: 20 });
  assert.deepEqual(await slow.made.send(MESSAGE), { sent: false, code: 'NETWORK' });
  const offline = reporter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await offline.made.send(MESSAGE), { sent: false, code: 'NETWORK' });
});

test('without a relay URL reports are off and nothing is sent', async () => {
  const { made, calls } = reporter({ url: '' });
  assert.equal(made.get().available, false);
  assert.deepEqual(await made.send(MESSAGE), { sent: false, code: 'UNAVAILABLE' });
  assert.equal(calls.length, 0);
  assert.ok(REPORT_URL === '' || /^https:\/\/[^/]+\/report$/.test(REPORT_URL), 'the relay URL is https and ends in /report');
});

test('a local failure to save the install ID is an error, not a network problem', async () => {
  let fetched = 0;
  const failing = {
    readAll: () => ({}),
    update: () => { throw new Error('State could not be saved.'); },
  };
  const { made } = reporter({ store: failing, fetchImpl: async () => { fetched += 1; return answer(200, { ok: true, remaining: 2, resetAt: null }); } });
  await assert.rejects(made.send('A message that is long enough.'), /State could not be saved/);
  assert.equal(fetched, 0, 'nothing is sent when the install ID could not be kept');
});
