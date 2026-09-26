'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorStore } = require('../lib/connectors.cjs');

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

const ENCRYPTING_STORAGE = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
};

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    readAll: () => structuredClone(state),
    update(mutator) {
      const draft = structuredClone(state);
      const result = mutator(draft);
      state = result === undefined ? draft : result;
      return structuredClone(state);
    },
    snapshot: () => structuredClone(state),
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeConnectors(overrides = {}) {
  const calls = [];
  const store = overrides.store || memoryStore();
  const connectors = createConnectorStore({
    store,
    safeStorage: overrides.safeStorage,
    now: overrides.now || (() => 1_700_000_000_000),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (!overrides.respond) throw new Error('Unexpected fetch call.');
      return overrides.respond(url, options);
    },
  });
  return { connectors, store, calls };
}

test('encrypts the token when safeStorage is available and persists no plaintext', () => {
  const { connectors, store } = makeConnectors({ safeStorage: ENCRYPTING_STORAGE });
  const entry = connectors.save({ id: 'github', token: TOKEN });
  const record = store.snapshot().connectors.github;
  assert.equal(entry.connected, true);
  assert.equal(entry.hasToken, true);
  assert.equal(entry.keyStorage, 'encrypted');
  assert.equal(entry.hint, `••••${TOKEN.slice(-4)}`);
  assert.equal(entry.connectedAt, 1_700_000_000_000);
  assert.equal(record.schemaVersion, 2);
  assert.match(record.encryptedToken, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(record.encryptedToken, 'base64').toString(), `enc:${TOKEN}`);
  assert.equal(JSON.stringify(store.snapshot()).includes(TOKEN), false);
  assert.equal('token' in entry, false);
});

test('keeps the token in memory only when encryption is unavailable', () => {
  const { connectors, store } = makeConnectors({
    safeStorage: { isEncryptionAvailable: () => false },
  });
  const entry = connectors.save({ id: 'sentry', token: TOKEN });
  assert.equal(entry.keyStorage, 'session');
  assert.equal(entry.hasToken, true);
  const record = store.snapshot().connectors.sentry;
  assert.equal(record.encryptedToken, undefined);
  assert.equal(record.tokenHint, `••••${TOKEN.slice(-4)}`);
  assert.equal(JSON.stringify(store.snapshot()).includes(TOKEN), false);
});

test('list() never exposes the token or the ciphertext', () => {
  const { connectors, store } = makeConnectors({ safeStorage: ENCRYPTING_STORAGE });
  connectors.save({ id: 'github', token: TOKEN });
  const listed = connectors.list();
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(store.snapshot().connectors.github.encryptedToken), false);
  assert.deepEqual(Object.keys(listed.github).sort(), [
    'connected', 'connectedAt', 'hasToken', 'hint', 'keyStorage', 'lastError', 'lastStatus',
  ]);
});

test('rejects invalid connector ids, non-printable tokens and long labels', () => {
  const { connectors } = makeConnectors();
  for (const id of ['', 'GitHub', 'a b', '-leading', 'github!', '__proto__', 'x'.repeat(65)]) {
    assert.throws(
      () => connectors.save({ id, token: TOKEN }),
      (error) => error.code === 'CONNECTOR_ERROR' && /Connector id/.test(error.message),
    );
  }
  for (const token of ['', '   ', 'bad\ntoken', 'unicode\u2022', 'x'.repeat(4097)]) {
    assert.throws(
      () => connectors.save({ id: 'github', token }),
      (error) => error.code === 'CONNECTOR_ERROR' && /printable ASCII/.test(error.message),
    );
  }
  assert.throws(() => connectors.save({ id: 'github', token: TOKEN, label: 'x'.repeat(65) }), /label/);
  assert.throws(() => connectors.save({ id: 'github', token: TOKEN, label: 'bad\nlabel' }), /label/);
});

test('fails cleanly when encryption throws', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('keychain locked'); },
  };
  const { connectors, store } = makeConnectors({ safeStorage });
  assert.throws(
    () => connectors.save({ id: 'github', token: TOKEN }),
    (error) => error.code === 'CONNECTOR_ERROR' && /encryption failed/.test(error.message),
  );
  assert.equal(store.snapshot().connectors, undefined);
});

test('remove deletes the record and the in-memory token', () => {
  const { connectors, store } = makeConnectors({ safeStorage: ENCRYPTING_STORAGE });
  connectors.save({ id: 'slack', token: TOKEN });
  assert.equal(connectors.remove({ id: 'slack' }).removed, true);
  assert.deepEqual(connectors.list(), {});
  assert.equal(store.snapshot().connectors, undefined);
  assert.equal(connectors.remove({ id: 'slack' }).removed, false);
});

test('caps stored connectors at 100', () => {
  const { connectors } = makeConnectors();
  for (let index = 0; index < 100; index += 1) {
    connectors.save({ id: `connector-${index}`, token: TOKEN });
  }
  assert.throws(() => connectors.save({ id: 'connector-100', token: TOKEN }), /At most 100/);
  assert.equal(connectors.save({ id: 'connector-0', token: TOKEN }).connected, true);
});

test('test() verifies a stored github token against the GitHub API', async () => {
  const { connectors, calls } = makeConnectors({
    respond: () => jsonResponse({ login: 'octocat' }),
  });
  connectors.save({ id: 'github', token: TOKEN });
  const result = await connectors.test({ id: 'github' });
  assert.deepEqual(result, {
    ok: true, supported: true, status: 200, message: 'Connector token verified.',
  });
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(connectors.list().github.lastStatus, 'ok');
  assert.equal(connectors.list().github.lastError, null);
});

test('test() records a clean failure when the provider rejects the token', async () => {
  const { connectors } = makeConnectors({
    respond: () => jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
  });
  connectors.save({ id: 'github', token: TOKEN });
  const result = await connectors.test({ id: 'github' });
  assert.equal(result.ok, false);
  assert.equal(result.supported, true);
  assert.equal(result.status, 401);
  assert.match(result.message, /rejected the stored token/);
  const entry = connectors.list().github;
  assert.equal(entry.lastStatus, 'error');
  assert.equal(entry.lastError, result.message);
});

test('test() reports unsupported connectors without calling the network', async () => {
  const { connectors, calls } = makeConnectors();
  connectors.save({ id: 'docker-hub', token: TOKEN });
  const result = await connectors.test({ id: 'docker-hub' });
  assert.deepEqual(result, {
    ok: false,
    supported: false,
    message: 'No validation endpoint is configured for this connector yet.',
  });
  assert.equal(calls.length, 0);
  assert.equal(connectors.list()['docker-hub'].lastStatus, 'unsupported');
});

test('test() requires a stored token', async () => {
  const { connectors } = makeConnectors();
  await assert.rejects(
    () => connectors.test({ id: 'github' }),
    (error) => error.code === 'CONNECTOR_ERROR' && /No stored token/.test(error.message),
  );
});

test('test() sends the provider-specific headers and bodies', async () => {
  // Linear answers 200 only with a viewer payload; the stub mirrors both shapes.
  const { connectors, calls } = makeConnectors({
    respond: (url) => url.includes('linear')
      ? jsonResponse({ data: { viewer: { id: 'u_1' } } })
      : jsonResponse({ ok: true }),
  });
  connectors.save({ id: 'notion', token: TOKEN });
  connectors.save({ id: 'linear', token: TOKEN });
  assert.equal((await connectors.test({ id: 'notion' })).ok, true);
  assert.equal(calls[0].url, 'https://api.notion.com/v1/users/me');
  assert.equal(calls[0].options.headers['Notion-Version'], '2022-06-28');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal((await connectors.test({ id: 'linear' })).ok, true);
  assert.equal(calls[1].url, 'https://api.linear.app/graphql');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, TOKEN);
  assert.deepEqual(JSON.parse(calls[1].options.body), { query: '{ viewer { id } }' });
});

test('test() fails when slack reports ok: false', async () => {
  const { connectors } = makeConnectors({ respond: () => jsonResponse({ ok: false }) });
  connectors.save({ id: 'slack', token: TOKEN });
  const result = await connectors.test({ id: 'slack' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(connectors.list().slack.lastStatus, 'error');
});

test('test() decrypts a persisted token for a new store instance', async () => {
  const store = memoryStore();
  const first = createConnectorStore({ store, safeStorage: ENCRYPTING_STORAGE });
  first.save({ id: 'github', token: TOKEN });
  const calls = [];
  const second = createConnectorStore({
    store,
    safeStorage: ENCRYPTING_STORAGE,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ login: 'octocat' });
    },
  });
  const result = await second.test({ id: 'github' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test('the hint never contains more than the last four characters of the token', () => {
  const { connectors } = makeConnectors({ safeStorage: ENCRYPTING_STORAGE });
  const entry = connectors.save({ id: 'linear', token: 'lin_api_0123456789abcdef' });
  assert.equal(entry.hint, '••••cdef');
  assert.equal(entry.hint.includes('lin_api_'), false);
  assert.equal(entry.hint.replace(/^•+/, '').length, 4);
});

test('fetch() returns a bounded repo summary and sends the Bearer header to both endpoints', async () => {
  const { connectors, calls } = makeConnectors({
    respond: (url) => url.endsWith('/issues?state=open&per_page=10')
      ? jsonResponse([
        { number: 2, title: 'Second issue', state: 'open' },
        { number: 1, title: 't'.repeat(250), state: 'open' },
      ])
      : jsonResponse({
        full_name: 'octocat/hello-world',
        description: 'd'.repeat(250),
        language: 'JavaScript',
        stargazers_count: 42,
        open_issues_count: 2,
        pushed_at: '2026-09-01T00:00:00Z',
        html_url: 'https://github.com/octocat/hello-world',
      }),
  });
  connectors.save({ id: 'github', token: TOKEN });
  const result = await connectors.fetch({
    id: 'github', action: 'repo', params: { owner: 'octocat', repo: 'hello-world' },
  });
  assert.deepEqual(result, {
    repo: {
      fullName: 'octocat/hello-world',
      description: 'd'.repeat(200),
      language: 'JavaScript',
      stars: 42,
      openIssues: 2,
      pushedAt: '2026-09-01T00:00:00Z',
      url: 'https://github.com/octocat/hello-world',
    },
    issues: [
      { number: 2, title: 'Second issue', state: 'open' },
      { number: 1, title: 't'.repeat(200), state: 'open' },
    ],
  });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/octocat/hello-world');
  assert.equal(calls[1].url, 'https://api.github.com/repos/octocat/hello-world/issues?state=open&per_page=10');
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.options.headers.Accept, 'application/vnd.github+json');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(connectors.list().github.lastStatus, 'never');
});

test('fetch() rejects a missing repository with a clean error', async () => {
  const { connectors, calls } = makeConnectors({
    respond: () => jsonResponse({ message: 'Not Found' }, { status: 404 }),
  });
  connectors.save({ id: 'github', token: TOKEN });
  await assert.rejects(
    () => connectors.fetch({ id: 'github', action: 'repo', params: { owner: 'octocat', repo: 'missing' } }),
    (error) => error.code === 'CONNECTOR_ERROR' && error.message === 'Repository not found.',
  );
  assert.equal(calls.length, 1);
});

test('fetch() requires a connected service', async () => {
  const { connectors, calls } = makeConnectors();
  await assert.rejects(
    () => connectors.fetch({ id: 'github', action: 'repo', params: { owner: 'octocat', repo: 'hello-world' } }),
    (error) => error.code === 'CONNECTOR_ERROR' && error.message === 'Connect this service first in Experts & resources.',
  );
  assert.equal(calls.length, 0);
});

test('fetch() rejects oversized params before touching the network', async () => {
  const { connectors, calls } = makeConnectors({ respond: () => jsonResponse({}) });
  connectors.save({ id: 'github', token: TOKEN });
  await assert.rejects(
    () => connectors.fetch({ id: 'github', action: 'repo', params: { owner: 'x'.repeat(201), repo: 'hello-world' } }),
    (error) => error.code === 'CONNECTOR_ERROR' && /at most 200 printable/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('fetch() rejects connectors without fetch actions', async () => {
  const { connectors, calls } = makeConnectors();
  connectors.save({ id: 'docker-hub', token: TOKEN });
  await assert.rejects(
    () => connectors.fetch({ id: 'docker-hub', action: 'repo', params: { owner: 'octocat', repo: 'hello-world' } }),
    (error) => error.code === 'CONNECTOR_ERROR' && error.message === 'This connector has no fetch actions yet.',
  );
  assert.equal(calls.length, 0);
});

test('the store can be built without an injected fetch implementation', () => {
  // Guards the `fetchImpl = fetch` default: a body-level `fetch` declaration
  // would shadow it with a TDZ binding and crash construction.
  const connectors = createConnectorStore({ store: memoryStore(), safeStorage: ENCRYPTING_STORAGE });
  assert.equal(typeof connectors.fetch, 'function');
});
