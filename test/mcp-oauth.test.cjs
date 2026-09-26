'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createMcpOAuth, parseChallenge, oauthConfig } = require('../lib/mcp-oauth.cjs');

const SERVER = 'https://mcp.example.com/mcp';
const ACCESS = 'at-live-0123456789abcdef';
const REFRESH = 'rt-live-0123456789abcdef';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const AS_META = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
};

// Routes stubbed https requests; unknown URLs answer 404. Every call is recorded.
function fakeNet(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body, redirect: init.redirect });
    const route = routes[`${init.method || 'GET'} ${url}`];
    if (!route) return json(404, { error: 'not_found' });
    return typeof route === 'function' ? route({ url, init, body }) : route.clone();
  };
  return { fetchImpl, calls };
}

function standardRoutes(overrides = {}) {
  return {
    [`POST ${SERVER}`]: () => new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"' },
    }),
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => json(200, {
      resource: SERVER, authorization_servers: ['https://auth.example.com'], scopes_supported: ['everything'],
    }),
    'GET https://auth.example.com/.well-known/oauth-authorization-server': () => json(200, AS_META),
    'POST https://auth.example.com/register': () => json(201, { client_id: 'client-123', token_endpoint_auth_method: 'none' }),
    'POST https://auth.example.com/token': ({ body }) => {
      const form = new URLSearchParams(body);
      return form.get('grant_type') === 'refresh_token'
        ? json(200, { access_token: 'at-new-0123456789abcdef', refresh_token: 'rt-new-0123456789abcdef', expires_in: 60 })
        : json(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer' });
    },
    ...overrides,
  };
}

// Plays the browser: checks the consent URL, then follows the redirect to the loopback callback.
function fakeBrowser(expect = () => {}) {
  const opened = [];
  const openExternal = async (address) => {
    opened.push(address);
    const url = new URL(address);
    expect(url);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'auth-code-xyz');
    callback.searchParams.set('state', url.searchParams.get('state'));
    setImmediate(() => { fetch(callback.href).then((response) => response.text()).catch(() => {}); });
  };
  return { openExternal, opened };
}

test('parseChallenge reads quoted and bare Bearer parameters', () => {
  assert.deepEqual(
    parseChallenge('Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="a b"'),
    { resourceMetadata: 'https://a.example/.well-known/oauth-protected-resource', scope: 'a b' },
  );
  assert.deepEqual(parseChallenge('Bearer scope=files.read'), { resourceMetadata: null, scope: 'files.read' });
  assert.deepEqual(parseChallenge(undefined), { resourceMetadata: null, scope: null });
});

test('signIn discovers, registers a public loopback client, and exchanges the code with PKCE and resource', async () => {
  const port = await freePort();
  const stub = fakeNet(standardRoutes());
  const client = createMcpOAuth({ fetchImpl: stub.fetchImpl, port, now: () => 1_000_000 });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  assert.equal(client.redirectUri, redirectUri);
  const browser = fakeBrowser((url) => {
    assert.equal(url.origin + url.pathname, 'https://auth.example.com/authorize');
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('resource'), SERVER);
    // The challenge's scope wins over the resource's scopes_supported.
    assert.equal(url.searchParams.get('scope'), 'read write');
  });

  const result = await client.signIn({ serverUrl: SERVER, openExternal: browser.openExternal });
  assert.equal(browser.opened.length, 1);
  assert.deepEqual(result, {
    required: true,
    auth: {
      type: 'oauth',
      issuer: 'https://auth.example.com/',
      resource: SERVER,
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-123',
      tokenAuth: 'none',
      scope: 'read write',
      expiresAt: 1_000_000 + 3_600_000,
      hasRefreshToken: true,
    },
    secrets: { clientSecret: '', accessToken: ACCESS, refreshToken: REFRESH },
  });

  const registration = stub.calls.find((call) => call.url === 'https://auth.example.com/register');
  assert.deepEqual(JSON.parse(registration.body), {
    client_name: 'ScaleMax',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'read write',
  });
  const exchange = new URLSearchParams(stub.calls.find((call) => call.url === 'https://auth.example.com/token').body);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code'), 'auth-code-xyz');
  assert.equal(exchange.get('redirect_uri'), redirectUri);
  assert.match(exchange.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchange.get('resource'), SERVER);
  assert.equal(exchange.get('client_id'), 'client-123');
  assert.equal(exchange.has('client_secret'), false);
  // No request ever follows a redirect.
  for (const call of stub.calls) assert.ok(call.redirect === 'manual' || call.redirect === 'error', call.url);

  const refreshed = await client.refresh(result.auth, result.secrets);
  assert.deepEqual(refreshed, {
    accessToken: 'at-new-0123456789abcdef', refreshToken: 'rt-new-0123456789abcdef', expiresAt: 1_000_000 + 60_000,
  });
  const refreshCall = new URLSearchParams(stub.calls.filter((call) => call.url === 'https://auth.example.com/token')[1].body);
  assert.equal(refreshCall.get('grant_type'), 'refresh_token');
  assert.equal(refreshCall.get('refresh_token'), REFRESH);
  assert.equal(refreshCall.get('resource'), SERVER);
});

test('confidential registrations send the issued secret the way the server asked', async () => {
  const port = await freePort();
  const stub = fakeNet(standardRoutes({
    'GET https://auth.example.com/.well-known/oauth-authorization-server': () => json(200, {
      ...AS_META, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    }),
    'POST https://auth.example.com/register': () => json(201, {
      client_id: 'client-456', client_secret: 'issued-secret-abcdef', token_endpoint_auth_method: 'client_secret_basic',
    }),
  }));
  const client = createMcpOAuth({ fetchImpl: stub.fetchImpl, port });
  const result = await client.signIn({ serverUrl: SERVER, openExternal: fakeBrowser().openExternal });
  assert.equal(result.auth.tokenAuth, 'client_secret_basic');
  assert.equal(result.secrets.clientSecret, 'issued-secret-abcdef');
  assert.equal(JSON.parse(stub.calls.find((call) => call.url.endsWith('/register')).body).token_endpoint_auth_method, 'client_secret_post');
  const exchange = stub.calls.find((call) => call.url === 'https://auth.example.com/token');
  assert.equal(exchange.headers.Authorization, `Basic ${Buffer.from('client-456:issued-secret-abcdef').toString('base64')}`);
  assert.equal(new URLSearchParams(exchange.body).has('client_secret'), false);
  assert.equal(oauthConfig(result.auth).tokenAuth, 'basic');
});

test('discovery falls back to legacy servers and path-based issuers', async () => {
  // No resource metadata at all: the server origin is the authorization server (MCP 2025-03-26).
  const legacy = fakeNet({
    [`POST ${SERVER}`]: () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
    'GET https://mcp.example.com/.well-known/oauth-authorization-server': () => json(200, {
      ...AS_META, issuer: 'https://mcp.example.com',
    }),
  });
  const found = await createMcpOAuth({ fetchImpl: legacy.fetchImpl }).discover(SERVER);
  assert.equal(found.issuer, 'https://mcp.example.com');
  assert.equal(found.resource, SERVER);
  assert.equal(found.scope, '');

  // An issuer with a path (Stripe-style), found through OpenID discovery with path insertion.
  const pathed = fakeNet({
    [`POST ${SERVER}`]: () => new Response(null, { status: 401 }),
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => json(200, {
      resource: 'https://mcp.example.com', authorization_servers: ['https://access.example.com/mcp'],
      scopes_supported: ['a', 'b'],
    }),
    'GET https://access.example.com/.well-known/openid-configuration/mcp': () => json(200, {
      ...AS_META, issuer: 'https://access.example.com/mcp',
    }),
  });
  const second = await createMcpOAuth({ fetchImpl: pathed.fetchImpl }).discover(SERVER);
  assert.equal(second.issuer, 'https://access.example.com/mcp');
  assert.equal(second.resource, 'https://mcp.example.com');
  assert.equal(second.scope, 'a b');
  assert.deepEqual(pathed.calls.map((call) => `${call.method} ${call.url}`), [
    `POST ${SERVER}`,
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    'GET https://access.example.com/.well-known/oauth-authorization-server/mcp',
    'GET https://access.example.com/.well-known/openid-configuration/mcp',
  ]);
});

test('servers that need no sign-in are reported as such', async () => {
  const open = fakeNet({ [`POST ${SERVER}`]: () => json(200, { jsonrpc: '2.0', id: 1, result: {} }) });
  const client = createMcpOAuth({ fetchImpl: open.fetchImpl });
  assert.deepEqual(await client.signIn({ serverUrl: SERVER, openExternal: () => {} }), { required: false });
});

test('refuses servers that cannot do a safe zero-setup sign-in', async () => {
  const cases = [
    [{ registration_endpoint: undefined }, 'REGISTRATION_UNSUPPORTED'],
    [{ code_challenge_methods_supported: ['plain'] }, 'PKCE_UNSUPPORTED'],
    [{ issuer: 'https://evil.example.com' }, 'DISCOVERY_FAILED'],
    [{ token_endpoint: 'http://auth.example.com/token' }, 'DISCOVERY_FAILED'],
    [{ token_endpoint_auth_methods_supported: ['private_key_jwt'] }, 'REGISTRATION_UNSUPPORTED'],
  ];
  for (const [patch, code] of cases) {
    const stub = fakeNet(standardRoutes({
      'GET https://auth.example.com/.well-known/oauth-authorization-server': () => json(200, { ...AS_META, ...patch }),
    }));
    await assert.rejects(
      () => createMcpOAuth({ fetchImpl: stub.fetchImpl }).signIn({ serverUrl: SERVER, openExternal: () => {} }),
      (error) => error.code === code,
      `expected ${code} for ${JSON.stringify(patch)}`,
    );
  }
  const refused = fakeNet(standardRoutes({ 'POST https://auth.example.com/register': () => json(403, { error: 'access_denied' }) }));
  await assert.rejects(
    () => createMcpOAuth({ fetchImpl: refused.fetchImpl }).signIn({ serverUrl: SERVER, openExternal: () => {} }),
    (error) => error.code === 'REGISTRATION_FAILED' && error.message.includes('(access_denied)'),
  );
  await assert.rejects(
    () => createMcpOAuth({ fetchImpl: refused.fetchImpl }).discover('http://mcp.example.com/mcp'),
    (error) => error.code === 'INVALID_URL',
  );
  const broken = fakeNet({ [`POST ${SERVER}`]: () => new Response(null, { status: 500 }) });
  await assert.rejects(
    () => createMcpOAuth({ fetchImpl: broken.fetchImpl }).discover(SERVER),
    /returned HTTP 500 before sign-in/,
  );
  const offline = createMcpOAuth({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => offline.discover(SERVER), (error) => error.code === 'NETWORK_ERROR');
});

test('a resource from another origin is ignored in favour of the server URL', async () => {
  const stub = fakeNet(standardRoutes({
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => json(200, {
      resource: 'https://other.example.com/', authorization_servers: ['https://auth.example.com'],
    }),
  }));
  const found = await createMcpOAuth({ fetchImpl: stub.fetchImpl }).discover(SERVER);
  assert.equal(found.resource, SERVER);
});

test('cancelling while the browser is open stops the sign-in and frees the port', async () => {
  const port = await freePort();
  const stub = fakeNet(standardRoutes());
  const client = createMcpOAuth({ fetchImpl: stub.fetchImpl, port });
  const controller = new AbortController();
  const running = client.signIn({
    serverUrl: SERVER, signal: controller.signal, openExternal: () => { setImmediate(() => controller.abort()); },
  });
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.equal(stub.calls.some((call) => call.url === 'https://auth.example.com/token'), false);
  // The callback port is free again.
  const probe = require('node:http').createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => probe.close(resolve));
});
