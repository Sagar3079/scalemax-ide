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
    'connected', 'connectedAt', 'hasToken', 'hint', 'identity', 'keyStorage', 'lastError', 'lastStatus',
    'oauth', 'oauthExpiresAt',
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

// ---------------------------------------------------------------------------
// OAuth sign-in (the OAuth engine is replaced by an in-memory fake)
// ---------------------------------------------------------------------------

const { OAUTH_PROVIDERS } = require('../lib/oauth-catalog.cjs');

const CLIENT_SECRET = 'oauth-client-secret-0123456789';
const ACCESS_TOKEN = 'gho_oauthaccess0123456789abcdef';
const REFRESH_TOKEN = 'ghr_oauthrefresh0123456789abcdef';
const REFRESHED_ACCESS = 'gho_refreshedaccess0123456789';
const ROTATED_REFRESH = 'ghr_rotated0123456789';
const T0 = 1_700_000_000_000;
const EXPIRED_MESSAGE = 'The OAuth session expired and could not be refreshed. Connect again.';

function oauthError(message, code) {
  return Object.assign(new Error(message), { name: 'OAuthError', code });
}

function fakeOAuth(overrides = {}) {
  const calls = [];
  return {
    calls,
    async authorize(config, options) {
      calls.push({ method: 'authorize', config, options });
      if (overrides.authorize) return overrides.authorize(config, options, calls);
      return { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresIn: 3600, scope: 'read:user' };
    },
    async refresh(config, options) {
      calls.push({ method: 'refresh', config, options });
      if (overrides.refresh) return overrides.refresh(config, options);
      return { accessToken: REFRESHED_ACCESS, refreshToken: ROTATED_REFRESH, expiresIn: 7200, scope: '' };
    },
    async fetchIdentity(config, token, options) {
      calls.push({ method: 'fetchIdentity', config, token, options });
      if (overrides.fetchIdentity) return overrides.fetchIdentity(config, token, options);
      return { status: 200, identity: 'octocat' };
    },
  };
}

function makeOAuthConnectors(overrides = {}) {
  const time = { now: T0 };
  const calls = [];
  const store = overrides.store || memoryStore();
  const oauth = overrides.oauth === undefined ? fakeOAuth() : overrides.oauth;
  const connectors = createConnectorStore({
    store,
    safeStorage: overrides.safeStorage === undefined ? ENCRYPTING_STORAGE : overrides.safeStorage,
    oauth,
    oauthConfigs: OAUTH_PROVIDERS,
    now: () => time.now,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (!overrides.respond) throw new Error('Unexpected fetch call.');
      return overrides.respond(url, options);
    },
  });
  return { connectors, store, oauth, time, calls };
}

function opener() {
  const opened = [];
  return { opened, openExternal: async (url) => { opened.push(url); } };
}

function decrypted(value) {
  return Buffer.from(value, 'base64').toString();
}

function methods(oauth) {
  return oauth.calls.map((call) => call.method);
}

async function connectGithub(connectors) {
  connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client', clientSecret: CLIENT_SECRET });
  return connectors.startOAuth({ id: 'github' }, opener());
}

test('saveOAuthConfig() validates the connector, client ID, secret mode and shop', () => {
  const { connectors, store } = makeOAuthConnectors();
  for (const id of ['docker-hub', 'constructor']) {
    assert.throws(
      () => connectors.saveOAuthConfig({ id, clientId: 'abc' }),
      (error) => error.code === 'CONNECTOR_ERROR' && error.message === 'This connector does not support OAuth sign-in.',
    );
  }
  assert.throws(() => connectors.saveOAuthConfig({ id: 'Not Valid', clientId: 'abc' }), /Connector id/);
  for (const clientId of [undefined, '', '   ', 'bad\nid', 'x'.repeat(513), 42]) {
    assert.throws(() => connectors.saveOAuthConfig({ id: 'github', clientId }), /OAuth client ID is required/);
  }
  for (const clientSecret of ['x'.repeat(1025), 'bad\nsecret', 42, null]) {
    assert.throws(() => connectors.saveOAuthConfig({ id: 'github', clientId: 'abc', clientSecret }), /client secret must be/);
  }
  for (const id of ['onedrive', 'microsoft-teams', 'slack', 'zoom']) {
    assert.throws(
      () => connectors.saveOAuthConfig({ id, clientId: 'abc', clientSecret: 'shh' }),
      (error) => error.message === `${id} desktop sign-in must not use a client secret; leave it blank.`,
    );
  }
  assert.equal(connectors.saveOAuthConfig({ id: 'onedrive', clientId: 'abc', clientSecret: '' }).hasSecret, false);
  const badShops = [
    undefined, '', 'evil.example.test', 'store.myshopify.com.evil.test', 'a_b.myshopify.com', '-store.myshopify.com',
    `${'a'.repeat(62)}.myshopify.com`, 'https://store.myshopify.com',
  ];
  for (const shop of badShops) {
    assert.throws(
      () => connectors.saveOAuthConfig({ id: 'shopify', clientId: 'abc', clientSecret: 'shh', shop }),
      /<store>\.myshopify\.com/,
    );
  }
  assert.equal(store.snapshot().connectorOAuthClients.onedrive.clientId, 'abc');
  assert.equal(store.snapshot().connectorOAuthClients.shopify, undefined);
  const shopify = connectors.saveOAuthConfig({ id: 'shopify', clientId: 'abc', clientSecret: 'shh', shop: '  My-Store.MyShopify.com ' });
  assert.equal(shopify.shop, 'my-store.myshopify.com');
  assert.equal(store.snapshot().connectorOAuthClients.shopify.shop, 'my-store.myshopify.com');
  // An omitted shop keeps the stored one; providers without {shop} never store one.
  assert.equal(connectors.saveOAuthConfig({ id: 'shopify', clientId: 'abc2' }).shop, 'my-store.myshopify.com');
  assert.equal(connectors.saveOAuthConfig({ id: 'github', clientId: 'abc', shop: 'my-store.myshopify.com' }).shop, null);
  assert.equal(store.snapshot().connectorOAuthClients.github.shop, null);
});

test('saveOAuthConfig() encrypts the client secret at rest and never returns it', () => {
  const { connectors, store } = makeOAuthConnectors();
  const saved = connectors.saveOAuthConfig({ id: 'github', clientId: ' Iv1.client ', clientSecret: CLIENT_SECRET });
  const stored = store.snapshot().connectorOAuthClients.github;
  assert.deepEqual(Object.keys(stored).sort(), ['clientId', 'encryptedSecret', 'secretStorage', 'shop', 'updatedAt']);
  assert.equal(stored.clientId, 'Iv1.client');
  assert.equal(stored.secretStorage, 'encrypted');
  assert.equal(stored.updatedAt, T0);
  assert.equal(decrypted(stored.encryptedSecret), `enc:${CLIENT_SECRET}`);
  assert.equal(JSON.stringify(store.snapshot()).includes(CLIENT_SECRET), false);
  for (const view of [saved, connectors.getOAuthConfig({ id: 'github' })]) {
    const text = JSON.stringify(view);
    assert.equal(text.includes(CLIENT_SECRET), false);
    assert.equal(text.includes(stored.encryptedSecret), false);
    assert.equal(view.hasSecret, true);
    assert.equal(view.secretStorage, 'encrypted');
    assert.equal(view.clientId, 'Iv1.client');
  }
  const kept = connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.renamed' });
  assert.equal(kept.hasSecret, true);
  assert.equal(store.snapshot().connectorOAuthClients.github.encryptedSecret, stored.encryptedSecret);
  const cleared = connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.renamed', clientSecret: '' });
  assert.equal(cleared.hasSecret, false);
  assert.equal(cleared.secretStorage, 'none');
  assert.equal('encryptedSecret' in store.snapshot().connectorOAuthClients.github, false);
  // The connector list never includes client registrations.
  assert.deepEqual(connectors.list(), {});
});

test('saveOAuthConfig() fails cleanly when secret encryption throws', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('keychain locked'); },
  };
  const { connectors, store } = makeOAuthConnectors({ safeStorage });
  assert.throws(
    () => connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client', clientSecret: CLIENT_SECRET }),
    (error) => error.message === 'OAuth client secret encryption failed; the settings were not saved.',
  );
  assert.equal(store.snapshot().connectorOAuthClients, undefined);
});

test('OAuth secrets and tokens stay in memory only when encryption is unavailable', async () => {
  const oauth = fakeOAuth();
  const safeStorage = { isEncryptionAvailable: () => false };
  const { connectors, store } = makeOAuthConnectors({ safeStorage, oauth });
  const saved = connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client', clientSecret: CLIENT_SECRET });
  assert.equal(saved.secretStorage, 'session');
  assert.equal(saved.hasSecret, true);
  const stored = store.snapshot().connectorOAuthClients.github;
  assert.equal(stored.secretStorage, 'session');
  assert.equal('encryptedSecret' in stored, false);

  const entry = await connectors.startOAuth({ id: 'github' }, opener());
  assert.equal(oauth.calls[0].options.clientSecret, CLIENT_SECRET);
  assert.equal(entry.keyStorage, 'session');
  assert.equal(entry.oauth, true);
  const record = store.snapshot().connectors.github;
  assert.equal(record.authType, 'oauth');
  assert.equal('encryptedToken' in record, false);
  assert.equal('encryptedOAuth' in record, false);
  const state = JSON.stringify(store.snapshot());
  for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN]) assert.equal(state.includes(secret), false);
  assert.equal(connectors.oauthStatus({ id: 'github' }).hasRefreshToken, true);

  // A restart loses the session secret and tokens but keeps the client ID.
  const restarted = createConnectorStore({ store, safeStorage, oauth, oauthConfigs: OAUTH_PROVIDERS });
  const view = restarted.getOAuthConfig({ id: 'github' });
  assert.equal(view.configured, true);
  assert.equal(view.hasSecret, false);
  assert.equal(view.secretStorage, 'none');
  assert.equal(restarted.list().github.connected, false);
  await assert.rejects(restarted.startOAuth({ id: 'github' }, opener()), /requires a client secret/);
});

test('getOAuthConfig() describes the provider setup and what is stored', () => {
  const { connectors } = makeOAuthConnectors();
  assert.deepEqual(connectors.getOAuthConfig({ id: 'docker-hub' }), { id: 'docker-hub', supported: false });
  const github = OAUTH_PROVIDERS.github;
  assert.deepEqual(connectors.getOAuthConfig({ id: 'github' }), {
    id: 'github',
    supported: true,
    configured: false,
    clientId: '',
    hasSecret: false,
    secretStorage: 'none',
    shop: null,
    secret: 'required',
    needsShop: false,
    redirectUri: 'http://127.0.0.1:53682/callback',
    loopback: 'yes',
    redirectNote: github.redirectNote,
    registerUrl: github.registerUrl,
    docsUrl: github.docsUrl,
    scopes: 'read:user',
  });
  const jira = connectors.getOAuthConfig({ id: 'jira' });
  assert.equal(jira.redirectUri, 'http://localhost:53682/callback');
  assert.equal(jira.loopback, 'localhost-only');
  assert.equal(connectors.getOAuthConfig({ id: 'shopify' }).needsShop, true);
  assert.equal(connectors.getOAuthConfig({ id: 'onedrive' }).secret, 'none');
  assert.equal(connectors.getOAuthConfig({ id: 'sentry' }).secret, 'optional');
  assert.equal(connectors.getOAuthConfig({ id: 'intercom' }).loopback, 'no');
  connectors.saveOAuthConfig({ id: 'shopify', clientId: 'shop-client', clientSecret: CLIENT_SECRET, shop: 'example.myshopify.com' });
  const shopify = connectors.getOAuthConfig({ id: 'shopify' });
  assert.equal(shopify.configured, true);
  assert.equal(shopify.clientId, 'shop-client');
  assert.equal(shopify.shop, 'example.myshopify.com');
  assert.equal(shopify.hasSecret, true);
  assert.throws(() => connectors.getOAuthConfig({ id: 'Bad Id' }), /Connector id/);
});

test('startOAuth() stores encrypted access and refresh tokens, identity and expiry', async () => {
  const oauth = fakeOAuth();
  const { connectors, store } = makeOAuthConnectors({ oauth });
  connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client', clientSecret: CLIENT_SECRET });
  const browser = opener();
  const entry = await connectors.startOAuth({ id: 'github' }, browser);
  assert.deepEqual(entry, {
    connected: true,
    hasToken: true,
    keyStorage: 'encrypted',
    hint: `••••${ACCESS_TOKEN.slice(-4)}`,
    connectedAt: T0,
    lastStatus: 'ok',
    lastError: null,
    oauth: true,
    oauthExpiresAt: T0 + 3_600_000,
    identity: 'octocat',
  });

  assert.deepEqual(methods(oauth), ['authorize', 'fetchIdentity']);
  const [authorizeCall, identityCall] = oauth.calls;
  assert.equal(authorizeCall.config, OAUTH_PROVIDERS.github);
  assert.equal(authorizeCall.options.clientId, 'Iv1.client');
  assert.equal(authorizeCall.options.clientSecret, CLIENT_SECRET);
  assert.equal(authorizeCall.options.port, 53682);
  assert.equal(authorizeCall.options.shop, '');
  assert.ok(authorizeCall.options.signal instanceof AbortSignal);
  assert.equal(identityCall.token, ACCESS_TOKEN);
  // The opener handed to the engine only ever lets https pages through.
  await assert.rejects(authorizeCall.options.openExternal('http://evil.example.test/'), /Only HTTPS/);
  await assert.rejects(authorizeCall.options.openExternal('file:///etc/passwd'), /Only HTTPS/);
  await assert.rejects(authorizeCall.options.openExternal('not a url'), /Only HTTPS/);
  await authorizeCall.options.openExternal('https://github.com/login/oauth/authorize?client_id=Iv1.client');
  assert.deepEqual(browser.opened, ['https://github.com/login/oauth/authorize?client_id=Iv1.client']);

  const record = store.snapshot().connectors.github;
  assert.equal(record.authType, 'oauth');
  assert.equal(decrypted(record.encryptedToken), `enc:${ACCESS_TOKEN}`);
  assert.equal(decrypted(record.encryptedOAuth), `enc:${REFRESH_TOKEN}`);
  assert.equal(record.identity, 'octocat');
  assert.equal(record.oauthExpiresAt, T0 + 3_600_000);
  const state = JSON.stringify(store.snapshot());
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) assert.equal(state.includes(secret), false);
  const listed = connectors.list();
  assert.equal(listed.github.oauth, true);
  const listedText = JSON.stringify(listed);
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, record.encryptedToken, record.encryptedOAuth]) {
    assert.equal(listedText.includes(secret), false);
  }
  assert.deepEqual(connectors.oauthStatus({ id: 'github' }), {
    id: 'github',
    pending: false,
    connected: true,
    oauth: true,
    identity: 'octocat',
    expiresAt: T0 + 3_600_000,
    expired: false,
    hasRefreshToken: true,
    lastError: null,
  });
  assert.equal(JSON.stringify(connectors.oauthStatus({ id: 'github' })).includes(ACCESS_TOKEN), false);

  // A new store instance (app restart) decrypts the persisted access token.
  const restartedOAuth = fakeOAuth();
  const restarted = createConnectorStore({
    store, safeStorage: ENCRYPTING_STORAGE, oauth: restartedOAuth, oauthConfigs: OAUTH_PROVIDERS, now: () => T0,
  });
  assert.equal((await restarted.test({ id: 'github' })).ok, true);
  assert.equal(restartedOAuth.calls[0].token, ACCESS_TOKEN);
});

test('startOAuth() passes the stored Shopify domain and never a secret for public clients', async () => {
  const oauth = fakeOAuth({ authorize: () => ({ accessToken: ACCESS_TOKEN, refreshToken: '', expiresIn: null }) });
  const { connectors, store } = makeOAuthConnectors({ oauth });
  connectors.saveOAuthConfig({ id: 'shopify', clientId: 'shop-client', clientSecret: CLIENT_SECRET, shop: 'example.myshopify.com' });
  const entry = await connectors.startOAuth({ id: 'shopify' }, opener());
  assert.equal(entry.oauthExpiresAt, null);
  assert.equal(oauth.calls[0].options.shop, 'example.myshopify.com');
  assert.equal(oauth.calls[1].options.shop, 'example.myshopify.com');
  assert.equal('encryptedOAuth' in store.snapshot().connectors.shopify, false);
  assert.equal(connectors.oauthStatus({ id: 'shopify' }).hasRefreshToken, false);
  connectors.saveOAuthConfig({ id: 'onedrive', clientId: 'ms-client' });
  await connectors.startOAuth({ id: 'onedrive' }, opener());
  assert.equal(oauth.calls[2].config, OAUTH_PROVIDERS.onedrive);
  assert.equal(oauth.calls[2].options.clientSecret, '');
});

test('startOAuth() checks every precondition before signing in', async () => {
  const oauth = fakeOAuth();
  const { connectors, store } = makeOAuthConnectors({ oauth });
  const browser = opener();
  await assert.rejects(
    connectors.startOAuth({ id: 'docker-hub' }, browser),
    (error) => error.message === 'This connector does not support OAuth sign-in.',
  );
  await assert.rejects(connectors.startOAuth({ id: 'github' }, browser), /Save an OAuth client ID/);
  connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client' });
  await assert.rejects(connectors.startOAuth({ id: 'github' }, browser), /requires a client secret/);
  connectors.saveOAuthConfig({ id: 'intercom', clientId: 'ic-client', clientSecret: CLIENT_SECRET });
  await assert.rejects(
    connectors.startOAuth({ id: 'intercom' }, browser),
    (error) => error.message === 'This provider only accepts HTTPS redirects, so desktop sign-in is unavailable. '
      + 'Connect with an access token instead.',
  );
  connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  await assert.rejects(connectors.startOAuth({ id: 'sentry' }, {}), /browser opener is required/);
  await assert.rejects(connectors.startOAuth({ id: 'sentry' }), /browser opener is required/);
  // A hand-edited state with an invalid shop is treated as having no shop.
  store.update((draft) => {
    draft.connectorOAuthClients.shopify = {
      clientId: 'shop-client',
      encryptedSecret: Buffer.from(`enc:${CLIENT_SECRET}`).toString('base64'),
      secretStorage: 'encrypted',
      shop: 'evil.example.test',
      updatedAt: 0,
    };
  });
  await assert.rejects(connectors.startOAuth({ id: 'shopify' }, browser), /Save the Shopify store domain/);
  assert.equal(oauth.calls.length, 0);
  assert.deepEqual(browser.opened, []);

  const withoutEngine = makeOAuthConnectors({ oauth: null });
  withoutEngine.connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  await assert.rejects(withoutEngine.connectors.startOAuth({ id: 'sentry' }, browser), /not available/);
});

test('startOAuth() passes engine error codes through and hides unexpected errors', async () => {
  let failure;
  const oauth = fakeOAuth({ authorize: () => { throw failure; } });
  const { connectors, store } = makeOAuthConnectors({ oauth });
  connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  failure = oauthError('OAuth callback port 53682 is already in use. Close the other app using it and try again.', 'PORT_IN_USE');
  await assert.rejects(
    connectors.startOAuth({ id: 'sentry' }, opener()),
    (error) => error.name === 'ConnectorError' && error.code === 'PORT_IN_USE' && error.message === failure.message,
  );
  assert.equal(connectors.oauthStatus({ id: 'sentry' }).lastError, failure.message);
  failure = new TypeError(`Invalid header value: Bearer ${ACCESS_TOKEN}`);
  await assert.rejects(
    connectors.startOAuth({ id: 'sentry' }, opener()),
    (error) => error.code === 'OAUTH_ERROR' && error.message === 'OAuth sign-in failed.',
  );
  assert.equal(JSON.stringify(connectors.oauthStatus({ id: 'sentry' })).includes(ACCESS_TOKEN), false);
  assert.equal(store.snapshot().connectors, undefined);
});

test('a second startOAuth() aborts the first and waits for it to release the port', async () => {
  const events = [];
  const oauth = fakeOAuth({
    authorize: (_config, options, calls) => {
      const attempt = calls.filter((call) => call.method === 'authorize').length;
      events.push(`authorize:${attempt}`);
      if (attempt === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            // The engine closes its listener asynchronously before it settles.
            setTimeout(() => {
              events.push('first-released');
              reject(oauthError('OAuth sign-in was cancelled.', 'CANCELLED'));
            }, 20);
          }, { once: true });
        });
      }
      return { accessToken: ACCESS_TOKEN, refreshToken: '', expiresIn: null, scope: '' };
    },
  });
  const { connectors } = makeOAuthConnectors({ oauth });
  connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.client', clientSecret: CLIENT_SECRET });
  connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  const first = connectors.startOAuth({ id: 'github' }, opener());
  await new Promise(setImmediate);
  assert.equal(connectors.oauthStatus({ id: 'github' }).pending, true);
  const second = connectors.startOAuth({ id: 'sentry' }, opener());
  assert.equal(connectors.oauthStatus({ id: 'sentry' }).pending, true);
  await assert.rejects(first, (error) => error.code === 'CANCELLED' && error.message === 'OAuth sign-in was cancelled.');
  const entry = await second;
  assert.deepEqual(events, ['authorize:1', 'first-released', 'authorize:2']);
  assert.equal(entry.oauth, true);
  assert.equal(connectors.list().github, undefined);
  assert.equal(connectors.oauthStatus({ id: 'github' }).pending, false);
  assert.equal(connectors.oauthStatus({ id: 'github' }).lastError, 'OAuth sign-in was cancelled.');
  assert.equal(connectors.oauthStatus({ id: 'sentry' }).pending, false);
  assert.equal(connectors.oauthStatus({ id: 'sentry' }).lastError, null);
});

test('disconnectOAuth() removes the tokens and keeps the client config unless forgetClient is set', async () => {
  const { connectors, store } = makeOAuthConnectors();
  await connectGithub(connectors);
  assert.deepEqual(connectors.disconnectOAuth({ id: 'github' }), { removed: true, clientForgotten: false });
  assert.deepEqual(connectors.list(), {});
  assert.equal(store.snapshot().connectors, undefined);
  const config = connectors.getOAuthConfig({ id: 'github' });
  assert.equal(config.configured, true);
  assert.equal(config.hasSecret, true);
  assert.deepEqual(connectors.oauthStatus({ id: 'github' }), {
    id: 'github',
    pending: false,
    connected: false,
    oauth: false,
    identity: null,
    expiresAt: null,
    expired: false,
    hasRefreshToken: false,
    lastError: null,
  });
  await assert.rejects(connectors.test({ id: 'github' }), /No stored token/);
  assert.deepEqual(connectors.disconnectOAuth({ id: 'github', forgetClient: true }), { removed: false, clientForgotten: true });
  assert.equal(connectors.getOAuthConfig({ id: 'github' }).configured, false);
  assert.equal(store.snapshot().connectorOAuthClients, undefined);
  assert.deepEqual(connectors.disconnectOAuth({ id: 'github', forgetClient: true }), { removed: false, clientForgotten: false });
  assert.throws(() => connectors.disconnectOAuth({ id: 'github', forgetClient: 'yes' }), /forgetClient/);
});

test('disconnectOAuth() cancels a pending sign-in so its tokens are never stored', async () => {
  const waiting = fakeOAuth({
    authorize: (_config, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(oauthError('OAuth sign-in was cancelled.', 'CANCELLED')), { once: true });
    }),
  });
  const first = makeOAuthConnectors({ oauth: waiting });
  first.connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  const pending = first.connectors.startOAuth({ id: 'sentry' }, opener());
  assert.equal(first.connectors.oauthStatus({ id: 'sentry' }).pending, true);
  assert.deepEqual(first.connectors.disconnectOAuth({ id: 'sentry' }), { removed: false, clientForgotten: false });
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
  assert.equal(first.store.snapshot().connectors, undefined);
  assert.equal(first.connectors.oauthStatus({ id: 'sentry' }).pending, false);

  // Tokens that arrive while the identity lookup is still running are discarded too.
  let releaseIdentity;
  const slowIdentity = fakeOAuth({
    fetchIdentity: () => new Promise((resolve) => { releaseIdentity = () => resolve({ status: 200, identity: 'late' }); }),
  });
  const second = makeOAuthConnectors({ oauth: slowIdentity });
  second.connectors.saveOAuthConfig({ id: 'sentry', clientId: 'sentry-client' });
  const racing = second.connectors.startOAuth({ id: 'sentry' }, opener());
  await new Promise(setImmediate);
  assert.deepEqual(methods(slowIdentity), ['authorize', 'fetchIdentity']);
  second.connectors.disconnectOAuth({ id: 'sentry' });
  releaseIdentity();
  await assert.rejects(racing, (error) => error.code === 'CANCELLED');
  assert.equal(second.store.snapshot().connectors, undefined);
});

test('disconnectOAuth({ pendingOnly }) cancels a re-sign-in but keeps the existing connection', async () => {
  let block = false;
  const oauth = fakeOAuth({
    authorize: (_config, { signal }) => (block
      ? new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(oauthError('OAuth sign-in was cancelled.', 'CANCELLED')), { once: true });
      })
      : { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresIn: 3600, scope: '' }),
  });
  const { connectors } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  block = true;
  const again = connectors.startOAuth({ id: 'github' }, opener());
  assert.equal(connectors.oauthStatus({ id: 'github' }).pending, true);
  assert.deepEqual(connectors.disconnectOAuth({ id: 'github', pendingOnly: true }),
    { removed: false, clientForgotten: false, cancelled: true });
  await assert.rejects(again, (error) => error.code === 'CANCELLED');
  const entry = connectors.list().github;
  assert.equal(entry.connected, true);
  assert.equal(entry.oauth, true);
  assert.equal(connectors.disconnectOAuth({ id: 'github', pendingOnly: true }).cancelled, false);
  assert.throws(() => connectors.disconnectOAuth({ id: 'github', pendingOnly: 'yes' }), /pendingOnly/);
});

test('saving an access token replaces an OAuth connection', async () => {
  const { connectors, store } = makeOAuthConnectors();
  await connectGithub(connectors);
  const entry = connectors.save({ id: 'github', token: TOKEN });
  assert.equal(entry.oauth, false);
  assert.equal(entry.oauthExpiresAt, null);
  const record = store.snapshot().connectors.github;
  assert.equal(record.authType, 'token');
  assert.equal('encryptedOAuth' in record, false);
  assert.equal(decrypted(record.encryptedToken), `enc:${TOKEN}`);
  assert.equal(connectors.oauthStatus({ id: 'github' }).hasRefreshToken, false);
  assert.equal(connectors.oauthStatus({ id: 'github' }).oauth, false);
});

test('test() refreshes an expiring OAuth token first and then validates it through fetchIdentity', async () => {
  const oauth = fakeOAuth({
    fetchIdentity: (_config, token) => ({ status: 200, identity: token === ACCESS_TOKEN ? 'octocat' : 'octocat-refreshed' }),
  });
  const { connectors, store, time, calls } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);

  time.now = T0 + 3_600_000 - 120_000;
  assert.equal((await connectors.test({ id: 'github' })).ok, true);
  assert.equal(methods(oauth).includes('refresh'), false);

  time.now = T0 + 3_600_000 - 30_000;
  oauth.calls.length = 0;
  const result = await connectors.test({ id: 'github' });
  assert.deepEqual(result, { ok: true, supported: true, status: 200, message: 'Connector token verified.' });
  assert.deepEqual(methods(oauth), ['refresh', 'fetchIdentity']);
  const [refreshCall, identityCall] = oauth.calls;
  assert.equal(refreshCall.config, OAUTH_PROVIDERS.github);
  assert.equal(refreshCall.options.refreshToken, REFRESH_TOKEN);
  assert.equal(refreshCall.options.clientId, 'Iv1.client');
  assert.equal(refreshCall.options.clientSecret, CLIENT_SECRET);
  assert.equal(refreshCall.options.shop, '');
  assert.equal(identityCall.token, REFRESHED_ACCESS);
  assert.equal(calls.length, 0);

  const record = store.snapshot().connectors.github;
  assert.equal(decrypted(record.encryptedToken), `enc:${REFRESHED_ACCESS}`);
  assert.equal(decrypted(record.encryptedOAuth), `enc:${ROTATED_REFRESH}`);
  assert.equal(record.oauthExpiresAt, time.now + 7_200_000);
  assert.equal(record.identity, 'octocat-refreshed');
  assert.equal(record.lastStatus, 'ok');
  assert.equal(record.connectedAt, T0);
  const entry = connectors.list().github;
  assert.equal(entry.hint, `••••${REFRESHED_ACCESS.slice(-4)}`);
  assert.equal(entry.identity, 'octocat-refreshed');
  const state = JSON.stringify(store.snapshot());
  for (const secret of [REFRESHED_ACCESS, ROTATED_REFRESH, ACCESS_TOKEN, REFRESH_TOKEN]) {
    assert.equal(state.includes(secret), false);
  }

  // Once the refreshed token has expired too, the rotated refresh token is the one spent next.
  time.now = record.oauthExpiresAt + 5_000;
  assert.equal(connectors.oauthStatus({ id: 'github' }).expired, true);
  oauth.calls.length = 0;
  assert.equal((await connectors.test({ id: 'github' })).ok, true);
  assert.deepEqual(methods(oauth), ['refresh', 'fetchIdentity']);
  assert.equal(oauth.calls[0].options.refreshToken, ROTATED_REFRESH);
});

test('a refresh that finishes after a reconnect never overwrites the new connection', async () => {
  let finishRefresh;
  const oauth = fakeOAuth({
    refresh: () => new Promise((resolve) => {
      finishRefresh = () => resolve({ accessToken: REFRESHED_ACCESS, refreshToken: ROTATED_REFRESH, expiresIn: 3600 });
    }),
  });
  const { connectors, store, time } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  time.now = T0 + 3_600_000;
  const stale = connectors.test({ id: 'github' });
  await new Promise(setImmediate);
  // The user disconnects and signs in again while the old refresh is still running.
  connectors.disconnectOAuth({ id: 'github' });
  await connectors.startOAuth({ id: 'github' }, opener());
  finishRefresh();
  await assert.rejects(stale, (error) => error.code === 'OAUTH_EXPIRED');
  const record = store.snapshot().connectors.github;
  assert.equal(decrypted(record.encryptedToken), `enc:${ACCESS_TOKEN}`);
  assert.equal(decrypted(record.encryptedOAuth), `enc:${REFRESH_TOKEN}`);
  assert.equal(record.lastStatus, 'ok');
  assert.equal(record.lastError, null);
});

test('an OAuth refresh keeps the stored refresh token when the provider returns none', async () => {
  const oauth = fakeOAuth({ refresh: () => ({ accessToken: REFRESHED_ACCESS, refreshToken: '', expiresIn: null }) });
  const { connectors, store, time } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  time.now = T0 + 3_600_000;
  assert.equal((await connectors.test({ id: 'github' })).ok, true);
  const record = store.snapshot().connectors.github;
  assert.equal(decrypted(record.encryptedOAuth), `enc:${REFRESH_TOKEN}`);
  assert.equal('oauthExpiresAt' in record, false);
});

test('test() reports an OAuth session that cannot be refreshed', async () => {
  const oauth = fakeOAuth({
    refresh: () => { throw oauthError('OAuth token exchange failed (invalid_grant).', 'TOKEN_EXCHANGE_FAILED'); },
  });
  const { connectors, time } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  time.now = T0 + 3_600_000 + 1;
  assert.equal(connectors.oauthStatus({ id: 'github' }).expired, true);
  await assert.rejects(
    connectors.test({ id: 'github' }),
    (error) => error.code === 'OAUTH_EXPIRED' && error.message === EXPIRED_MESSAGE,
  );
  const entry = connectors.list().github;
  assert.equal(entry.lastStatus, 'error');
  assert.equal(entry.lastError, EXPIRED_MESSAGE);
  assert.equal(connectors.oauthStatus({ id: 'github' }).lastError, EXPIRED_MESSAGE);
  // Only the identity lookup during sign-in ran; validation stopped at the failed refresh.
  assert.deepEqual(methods(oauth), ['authorize', 'fetchIdentity', 'refresh']);
});

test('concurrent requests share a single OAuth refresh', async () => {
  let finishRefresh;
  const oauth = fakeOAuth({
    refresh: () => new Promise((resolve) => {
      finishRefresh = () => resolve({ accessToken: REFRESHED_ACCESS, refreshToken: ROTATED_REFRESH, expiresIn: 3600 });
    }),
  });
  const { connectors, time } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  time.now = T0 + 3_600_000;
  const results = Promise.all([connectors.test({ id: 'github' }), connectors.test({ id: 'github' })]);
  await new Promise(setImmediate);
  finishRefresh();
  assert.deepEqual((await results).map((result) => result.ok), [true, true]);
  assert.equal(methods(oauth).filter((method) => method === 'refresh').length, 1);
});

test('test() maps OAuth identity failures to clean messages', async () => {
  let next = { status: 200, identity: 'octocat' };
  const oauth = fakeOAuth({ fetchIdentity: () => next });
  const { connectors, calls } = makeOAuthConnectors({ oauth });
  await connectGithub(connectors);
  const cases = [
    [401, 'Provider rejected the stored token.'],
    [403, 'Provider rejected the stored token.'],
    [500, 'Provider validation failed with HTTP status 500.'],
    [null, 'Could not reach the provider to validate the token.'],
  ];
  for (const [status, message] of cases) {
    next = { status, identity: null };
    const result = await connectors.test({ id: 'github' });
    assert.equal(result.ok, false);
    assert.equal(result.supported, true);
    assert.equal(result.message, message);
    assert.equal(result.status, status === null ? undefined : status);
    assert.equal(connectors.list().github.lastStatus, 'error');
    assert.equal(connectors.list().github.lastError, message);
  }
  next = { status: 204, identity: null };
  assert.equal((await connectors.test({ id: 'github' })).ok, true);
  // Identity stays as it was when the provider does not return one.
  assert.equal(connectors.list().github.identity, 'octocat');
  // OAuth connections never use the token-path validation endpoints.
  assert.equal(calls.length, 0);
});

test('test() rejects a 200 identity answer without identity for Slack-style providers', async () => {
  // Slack's auth.test (and GraphQL APIs) answer 200 with an error body for a bad token.
  let next = { status: 200, identity: 'U024BE7LH' };
  const oauth = fakeOAuth({ fetchIdentity: () => next });
  const { connectors } = makeOAuthConnectors({ oauth });
  connectors.saveOAuthConfig({ id: 'slack', clientId: 'slack.client' });
  await connectors.startOAuth({ id: 'slack' }, opener());
  assert.equal((await connectors.test({ id: 'slack' })).ok, true);
  next = { status: 200, identity: null };
  const result = await connectors.test({ id: 'slack' });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Provider rejected the stored token.');
  assert.equal(connectors.list().slack.lastStatus, 'error');
  for (const id of ['slack', 'linear', 'shopify']) assert.equal(OAUTH_PROVIDERS[id].identity.requireField, true, id);
});

test('fetch() refreshes an expired OAuth token before calling the provider', async () => {
  const { connectors, time, calls, oauth } = makeOAuthConnectors({
    respond: (url) => (url.endsWith('per_page=10') ? jsonResponse([]) : jsonResponse({ full_name: 'octocat/hello-world' })),
  });
  await connectGithub(connectors);
  time.now = T0 + 3_600_000;
  const result = await connectors.fetch({ id: 'github', action: 'repo', params: { owner: 'octocat', repo: 'hello-world' } });
  assert.equal(result.repo.fullName, 'octocat/hello-world');
  assert.equal(methods(oauth).filter((method) => method === 'refresh').length, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.headers.Authorization, `Bearer ${REFRESHED_ACCESS}`);
});

const NEW_VALIDATION_ENDPOINTS = [
  { id: 'airtable', method: 'GET', url: 'https://api.airtable.com/v0/meta/whoami' },
  { id: 'asana', method: 'GET', url: 'https://app.asana.com/api/1.0/users/me' },
  { id: 'cloudflare', method: 'GET', url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', reply: { success: true } },
  { id: 'vercel', method: 'GET', url: 'https://api.vercel.com/v2/user' },
  { id: 'netlify', method: 'GET', url: 'https://api.netlify.com/api/v1/user' },
  { id: 'figma', method: 'GET', url: 'https://api.figma.com/v1/me', header: ['X-Figma-Token', TOKEN] },
  { id: 'intercom', method: 'GET', url: 'https://api.intercom.io/me' },
  { id: 'hubspot', method: 'GET', url: 'https://api.hubapi.com/account-info/2026-09/details' },
  { id: 'sendgrid', method: 'GET', url: 'https://api.sendgrid.com/v3/user/profile' },
  { id: 'stripe', method: 'GET', url: 'https://api.stripe.com/v1/balance' },
  { id: 'discord', method: 'GET', url: 'https://discord.com/api/v10/users/@me', header: ['Authorization', `Bot ${TOKEN}`] },
  {
    id: 'dropbox',
    method: 'POST',
    url: 'https://api.dropboxapi.com/2/users/get_current_account',
    body: 'null',
    contentType: 'application/json',
  },
  { id: 'zoom', method: 'GET', url: 'https://api.zoom.us/v2/users/me' },
  { id: 'google-drive', method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user' },
  { id: 'google-calendar', method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary' },
  { id: 'gmail', method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' },
  { id: 'onedrive', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me' },
  { id: 'microsoft-teams', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me' },
  { id: 'supabase', method: 'GET', url: 'https://api.supabase.com/v1/projects' },
];

test('test() validates token connections against every newly supported endpoint', async () => {
  for (const expected of NEW_VALIDATION_ENDPOINTS) {
    const { connectors, calls } = makeConnectors({ respond: () => jsonResponse(expected.reply || { id: 'me' }) });
    connectors.save({ id: expected.id, token: TOKEN });
    const result = await connectors.test({ id: expected.id });
    assert.deepEqual(result, { ok: true, supported: true, status: 200, message: 'Connector token verified.' }, expected.id);
    assert.equal(calls.length, 1, expected.id);
    const [{ url, options }] = calls;
    assert.equal(url, expected.url, expected.id);
    assert.equal(options.method, expected.method, expected.id);
    assert.equal(options.redirect, 'error', expected.id);
    assert.equal(options.headers.Accept, 'application/json', expected.id);
    const [name, value] = expected.header || ['Authorization', `Bearer ${TOKEN}`];
    assert.equal(options.headers[name], value, expected.id);
    if (name !== 'Authorization') assert.equal(options.headers.Authorization, undefined, expected.id);
    assert.equal(options.body, expected.body, expected.id);
    assert.equal(options.headers['Content-Type'], expected.contentType, expected.id);
    assert.equal(connectors.list()[expected.id].lastStatus, 'ok', expected.id);
  }
});

test('test() requires success: true from the Cloudflare token verify endpoint', async () => {
  const { connectors } = makeConnectors({ respond: () => jsonResponse({ success: false, errors: [{ code: 1000 }] }) });
  connectors.save({ id: 'cloudflare', token: TOKEN });
  const result = await connectors.test({ id: 'cloudflare' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(connectors.list().cloudflare.lastStatus, 'error');
});
