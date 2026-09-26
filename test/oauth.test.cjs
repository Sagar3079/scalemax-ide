'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {
  authorize, tokenRequest, refresh, fetchIdentity, verifier, challenge,
} = require('../lib/oauth.cjs');
const { OAUTH_PROVIDERS } = require('../lib/oauth-catalog.cjs');

const SUCCESS_TEXT = 'ScaleMax received the authorization. You can close this tab.';
const CLIENT_ID = 'client-123';
const CLIENT_SECRET = 'secret-456';

const CONFIG = {
  authorizeUrl: 'https://auth.example.test/oauth/authorize',
  tokenUrl: 'https://auth.example.test/oauth/token',
  tokenAuth: 'post',
  tokenFormat: 'form',
  scopes: 'read write',
  scopeSeparator: ' ',
  pkce: true,
  secret: 'optional',
  extraParams: { audience: 'api.example.test' },
  identity: null,
  loopback: 'yes',
  redirectHost: '127.0.0.1',
};

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const DEFAULT_TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'read write' };

function tokenEndpoint(respond = () => jsonResponse(DEFAULT_TOKENS)) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

async function listenOn(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// An ephemeral high port that is free right now.
async function freePort() {
  const server = net.createServer();
  const port = await listenOn(server, 0, '127.0.0.1');
  await closeServer(server);
  return port;
}

async function assertPortFree(port) {
  const server = net.createServer();
  await listenOn(server, port, '127.0.0.1');
  await closeServer(server);
}

async function ipv6LoopbackAvailable() {
  const server = net.createServer();
  try {
    await listenOn(server, 0, '::1');
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
}

// Builds the provider redirect back to the redirect_uri found in the authorize URL.
function callbackUrl(authorizeUrl, params) {
  const target = new URL(new URL(authorizeUrl).searchParams.get('redirect_uri'));
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.href;
}

function stateOf(authorizeUrl) {
  return new URL(authorizeUrl).searchParams.get('state');
}

// A fake browser: records the authorize URL, then runs `visit` against the loopback server.
function fakeBrowser(visit) {
  const browser = { url: null, done: null };
  browser.openExternal = (url) => {
    browser.url = new URL(url);
    browser.done = visit(url);
    return browser.done;
  };
  return browser;
}

function formBody(call) {
  return new URLSearchParams(call.init.body);
}

test('authorize() runs the loopback flow end to end with PKCE and body client credentials', async () => {
  const port = await freePort();
  const { calls, fetchImpl } = tokenEndpoint();
  const redirects = [];
  const browser = fakeBrowser((url) => get(callbackUrl(url, { code: 'code-789', state: stateOf(url) })));
  const tokens = await authorize(CONFIG, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port,
    fetchImpl,
    openExternal: browser.openExternal,
    onRedirect: (uri) => redirects.push(uri),
  });
  const page = await browser.done;
  assert.deepEqual(tokens, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, scope: 'read write' });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const params = browser.url.searchParams;
  assert.equal(`${browser.url.origin}${browser.url.pathname}`, CONFIG.authorizeUrl);
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('redirect_uri'), redirectUri);
  assert.equal(params.get('response_type'), 'code');
  assert.match(params.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.get('scope'), 'read write');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(params.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.get('audience'), 'api.example.test');
  assert.equal(browser.url.href.includes(CLIENT_SECRET), false);
  assert.deepEqual(redirects, [redirectUri]);

  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.body, SUCCESS_TEXT);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, CONFIG.tokenUrl);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(call.init.headers.Authorization, undefined);
  const body = formBody(call);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'code-789');
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge(body.get('code_verifier')), params.get('code_challenge'));
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('client_secret'), CLIENT_SECRET);
  await assertPortFree(port);
});

test('authorize() sends HTTP Basic credentials and a JSON body when the provider asks for them', async () => {
  const port = await freePort();
  const config = {
    ...CONFIG,
    tokenAuth: 'basic',
    tokenFormat: 'json',
    pkce: false,
    scopes: '',
    // Provider extras can add parameters but never replace the core ones.
    extraParams: { owner: 'user', state: 'fixed-state', redirect_uri: 'https://evil.example.test/' },
  };
  const { calls, fetchImpl } = tokenEndpoint();
  const browser = fakeBrowser((url) => get(callbackUrl(url, { code: 'code-789', state: stateOf(url) })));
  await authorize(config, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, port, fetchImpl, openExternal: browser.openExternal });
  await browser.done;
  const params = browser.url.searchParams;
  assert.equal(params.has('scope'), false);
  assert.equal(params.has('code_challenge'), false);
  assert.equal(params.has('code_challenge_method'), false);
  assert.equal(params.get('owner'), 'user');
  assert.notEqual(params.get('state'), 'fixed-state');
  assert.equal(params.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);

  const [call] = calls;
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.deepEqual(JSON.parse(call.init.body), {
    grant_type: 'authorization_code',
    code: 'code-789',
    redirect_uri: `http://127.0.0.1:${port}/callback`,
  });
});

test('authorize() ignores stray callback requests and completes with the matching one', async () => {
  const port = await freePort();
  const { calls, fetchImpl } = tokenEndpoint();
  const pages = {};
  const browser = fakeBrowser(async (url) => {
    pages.wrongState = await get(callbackUrl(url, { code: 'stray-code', state: 'not-the-state' }));
    pages.missingState = await get(callbackUrl(url, { code: 'stray-code' }));
    pages.otherPath = await get(`http://127.0.0.1:${port}/favicon.ico`);
    pages.valid = await get(callbackUrl(url, { code: 'code-789', state: stateOf(url) }));
  });
  const tokens = await authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, openExternal: browser.openExternal });
  await browser.done;
  assert.equal(tokens.accessToken, 'access-1');
  assert.equal(pages.wrongState.status, 400);
  assert.equal(pages.wrongState.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(pages.missingState.status, 400);
  assert.equal(pages.otherPath.status, 404);
  assert.equal(pages.valid.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(formBody(calls[0]).get('code'), 'code-789');
  // No secret configured: only the client id is sent.
  assert.equal(formBody(calls[0]).get('client_id'), CLIENT_ID);
  assert.equal(formBody(calls[0]).has('client_secret'), false);
});

test('authorize() accepts only the first valid callback', async () => {
  const port = await freePort();
  const { calls, fetchImpl } = tokenEndpoint();
  const browser = fakeBrowser((url) => Promise.all(['code-a', 'code-b'].map((code) => (
    get(callbackUrl(url, { code, state: stateOf(url) })).then(
      (page) => ({ code, status: page.status }),
      // The listener may already be closing when the second request lands.
      () => ({ code, status: 'closed' }),
    )
  ))));
  await authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, openExternal: browser.openExternal });
  const results = await browser.done;
  const accepted = results.filter((result) => result.status === 200);
  assert.equal(accepted.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(formBody(calls[0]).get('code'), accepted[0].code);
  const other = results.find((result) => result !== accepted[0]);
  assert.ok(other.status === 409 || other.status === 'closed');
});

test('authorize() rejects when the provider reports an error and sanitises the code', async () => {
  const port = await freePort();
  const { calls, fetchImpl } = tokenEndpoint();
  const browser = fakeBrowser((url) => get(callbackUrl(url, {
    error: 'access_denied', error_description: 'The user said no', state: stateOf(url),
  })));
  await assert.rejects(
    authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, openExternal: browser.openExternal }),
    (error) => error.code === 'DENIED' && error.message === 'Authorization was denied (access_denied).',
  );
  assert.equal((await browser.done).status, 400);
  assert.equal(calls.length, 0);
  await assertPortFree(port);

  const noisy = fakeBrowser((url) => get(callbackUrl(url, {
    error: `Server Error: <b>x</b>${'a'.repeat(100)}`, state: stateOf(url),
  })));
  await assert.rejects(
    authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, openExternal: noisy.openExternal }),
    (error) => error.message === `Authorization was denied (servererrorbxb${'a'.repeat(50)}).`,
  );
  await noisy.done;
});

test('authorize() cancels through its signal and frees the port for the next attempt', async () => {
  const port = await freePort();
  const { fetchImpl } = tokenEndpoint();
  const controller = new AbortController();
  await assert.rejects(
    authorize(CONFIG, {
      clientId: CLIENT_ID, port, fetchImpl, signal: controller.signal,
      openExternal: async () => { controller.abort(); },
    }),
    (error) => error.code === 'CANCELLED' && error.message === 'OAuth sign-in was cancelled.',
  );

  let opened = false;
  await assert.rejects(
    authorize(CONFIG, {
      clientId: CLIENT_ID, port, fetchImpl, signal: controller.signal,
      openExternal: async () => { opened = true; },
    }),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(opened, false);

  const browser = fakeBrowser((url) => get(callbackUrl(url, { code: 'code-2', state: stateOf(url) })));
  const tokens = await authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, openExternal: browser.openExternal });
  assert.equal((await browser.done).status, 200);
  assert.equal(tokens.accessToken, 'access-1');
  await assertPortFree(port);
});

test('authorize() cancels a token exchange that is still running', async () => {
  const port = await freePort();
  const controller = new AbortController();
  const fetchImpl = () => {
    controller.abort();
    return new Promise(() => {});
  };
  const browser = fakeBrowser((url) => get(callbackUrl(url, { code: 'code-789', state: stateOf(url) })));
  await assert.rejects(
    authorize(CONFIG, { clientId: CLIENT_ID, port, fetchImpl, signal: controller.signal, openExternal: browser.openExternal }),
    (error) => error.code === 'CANCELLED',
  );
  await browser.done;
  await assertPortFree(port);
});

test('authorize() reports PORT_IN_USE when the callback port is taken', async () => {
  const blocker = net.createServer();
  const port = await listenOn(blocker, 0, '127.0.0.1');
  let opened = false;
  try {
    await assert.rejects(
      authorize(CONFIG, {
        clientId: CLIENT_ID, port, fetchImpl: tokenEndpoint().fetchImpl,
        openExternal: async () => { opened = true; },
      }),
      (error) => error.code === 'PORT_IN_USE'
        && error.message === `OAuth callback port ${port} is already in use. Close the other app using it and try again.`,
    );
  } finally {
    await closeServer(blocker);
  }
  assert.equal(opened, false);
});

test('authorize() uses a localhost redirect for localhost-only providers', async () => {
  const port = await freePort();
  const ipv6 = await ipv6LoopbackAvailable();
  const { calls, fetchImpl } = tokenEndpoint();
  const pages = {};
  const browser = fakeBrowser(async (url) => {
    // The IPv6 loopback answers too, because browsers may resolve localhost to ::1.
    if (ipv6) pages.ipv6 = await get(`http://[::1]:${port}/callback?state=not-the-state&code=x`);
    pages.valid = await get(callbackUrl(url, { code: 'code-local', state: stateOf(url) }));
  });
  const tokens = await authorize({ ...CONFIG, redirectHost: 'localhost' }, {
    clientId: CLIENT_ID, port, fetchImpl, openExternal: browser.openExternal,
  });
  await browser.done;
  const redirectUri = `http://localhost:${port}/callback`;
  assert.equal(browser.url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(pages.valid.status, 200);
  if (ipv6) assert.equal(pages.ipv6.status, 400);
  assert.equal(formBody(calls[0]).get('redirect_uri'), redirectUri);
  assert.equal(tokens.accessToken, 'access-1');
  await assertPortFree(port);
});

test('authorize() times out, and reports a browser that cannot be opened', async () => {
  const port = await freePort();
  await assert.rejects(
    authorize(CONFIG, {
      clientId: CLIENT_ID, port, timeoutMs: 50, fetchImpl: tokenEndpoint().fetchImpl, openExternal: async () => {},
    }),
    (error) => error.code === 'TIMEOUT' && error.message === 'OAuth sign-in timed out.',
  );
  await assertPortFree(port);
  await assert.rejects(
    authorize(CONFIG, {
      clientId: CLIENT_ID, port, fetchImpl: tokenEndpoint().fetchImpl,
      openExternal: async () => { throw new Error('no browser'); },
    }),
    (error) => error.message === 'Could not open the browser for sign-in.',
  );
  await assertPortFree(port);
});

test('authorize() refuses non-HTTPS URLs and validates the Shopify store before substituting it', async () => {
  const port = await freePort();
  let opened = 0;
  const openExternal = async () => { opened += 1; };
  await assert.rejects(
    authorize({ ...CONFIG, authorizeUrl: 'http://auth.example.test/authorize' }, { clientId: CLIENT_ID, port, openExternal }),
    /non-HTTPS/,
  );
  await assert.rejects(
    authorize({ ...CONFIG, authorizeUrl: 'javascript:alert(1)' }, { clientId: CLIENT_ID, port, openExternal }),
    /non-HTTPS/,
  );
  const shopConfig = {
    ...CONFIG,
    authorizeUrl: 'https://{shop}/admin/oauth/authorize',
    tokenUrl: 'https://{shop}/admin/oauth/access_token',
  };
  for (const shop of ['', 'evil.example.test', 'store.myshopify.com.evil.test', 'Store.myshopify.com', 'a/b.myshopify.com']) {
    await assert.rejects(
      authorize(shopConfig, { clientId: CLIENT_ID, port, shop, openExternal }),
      (error) => error.code === 'INVALID_SHOP',
    );
  }
  assert.equal(opened, 0);

  const { calls, fetchImpl } = tokenEndpoint();
  const browser = fakeBrowser((url) => get(callbackUrl(url, { code: 'code-shop', state: stateOf(url) })));
  await authorize(shopConfig, {
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, port, shop: 'example-store.myshopify.com', fetchImpl,
    openExternal: browser.openExternal,
  });
  await browser.done;
  assert.equal(browser.url.host, 'example-store.myshopify.com');
  assert.equal(calls[0].url, 'https://example-store.myshopify.com/admin/oauth/access_token');
});

test('verifier() and challenge() implement PKCE S256', () => {
  const value = verifier();
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier(), value);
  // RFC 7636 appendix B test vector.
  assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('tokenRequest() reads a nested token at tokenPath together with its refresh data', async () => {
  const { fetchImpl } = tokenEndpoint(() => jsonResponse({
    ok: true,
    access_token: 'xoxb-bot-token',
    authed_user: { access_token: 'xoxp-user-token', refresh_token: 'xoxe-refresh', expires_in: 43200, scope: 'channels:read' },
  }));
  const result = await tokenRequest(
    { ...CONFIG, tokenPath: 'authed_user.access_token' },
    { grant_type: 'authorization_code', code: 'code-1' },
    { fetchImpl, clientId: CLIENT_ID },
  );
  assert.deepEqual(result, {
    accessToken: 'xoxp-user-token', refreshToken: 'xoxe-refresh', expiresIn: 43200, scope: 'channels:read',
  });
});

test('tokenRequest() treats ok: false, error fields and HTTP failures as failures without echoing the response', async () => {
  const cases = [
    // Slack answers 200 with ok: false.
    [jsonResponse({ ok: false, error: 'invalid_code' }), 'invalid_code'],
    // GitHub answers 200 with an error field.
    [jsonResponse({ error: 'bad_verification_code', error_description: 'code-1 is wrong', access_token: 'ignored' }), 'bad_verification_code'],
    [jsonResponse({ error: 'invalid_grant', error_description: `secret ${CLIENT_SECRET}` }, { status: 400 }), 'invalid_grant'],
    // Figma uses error: true; HubSpot has no error field at all.
    [jsonResponse({ error: true, status: 400, message: 'Invalid code' }, { status: 400 }), 'http_400'],
    [jsonResponse({ status: 'BAD_AUTH_CODE', message: 'code-1 expired' }, { status: 400 }), 'http_400'],
    [new Response('<html>Bad gateway</html>', { status: 502 }), 'http_502'],
    [jsonResponse({ ok: false }), 'unknown_error'],
    [jsonResponse(['not', 'an', 'object']), 'invalid_response'],
  ];
  for (const [response, code] of cases) {
    const { fetchImpl } = tokenEndpoint(() => response);
    await assert.rejects(
      tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      (error) => {
        assert.equal(error.message, `OAuth token exchange failed (${code}).`);
        assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
        for (const secret of ['code-1', CLIENT_SECRET, 'wrong', 'expired', 'Bad gateway']) {
          assert.equal(error.message.includes(secret), false);
        }
        return true;
      },
    );
  }
});

test('tokenRequest() sanitises provider error codes to at most 64 [a-z0-9_] characters', async () => {
  const { fetchImpl } = tokenEndpoint(() => jsonResponse({ error: `Invalid-Grant<script>"${'X'.repeat(80)}` }, { status: 400 }));
  await assert.rejects(
    tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID }),
    (error) => error.message === `OAuth token exchange failed (invalidgrantscript${'x'.repeat(46)}).`,
  );
});

test('tokenRequest() accepts form-encoded token responses', async () => {
  const { fetchImpl } = tokenEndpoint(() => new Response('access_token=gho_formtoken&scope=read%3Auser&token_type=bearer', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
  const result = await tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID });
  assert.deepEqual(result, { accessToken: 'gho_formtoken', refreshToken: '', expiresIn: null, scope: 'read:user' });
});

test('tokenRequest() rejects oversized responses by declared length and while streaming', async () => {
  const declared = tokenEndpoint(() => new Response('{}', {
    headers: { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) },
  }));
  await assert.rejects(
    tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl: declared.fetchImpl, clientId: CLIENT_ID }),
    (error) => error.code === 'RESPONSE_TOO_LARGE' && /256 KB/.test(error.message),
  );
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let pulled = 0;
  const streamed = tokenEndpoint(() => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
      if (pulled > 20) controller.close();
    },
  })));
  await assert.rejects(
    tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl: streamed.fetchImpl, clientId: CLIENT_ID }),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.ok(pulled <= 6, `read ${pulled} chunks after the cap`);
});

test('tokenRequest() rejects a response without a usable access token', async () => {
  for (const payload of [{}, { access_token: '' }, { access_token: 42 }, { access_token: 'line\nbreak' }, { access_token: 'x'.repeat(4097) }]) {
    const { fetchImpl } = tokenEndpoint(() => jsonResponse(payload));
    await assert.rejects(
      tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID }),
      (error) => error.message === 'OAuth token exchange failed (missing_access_token).',
    );
  }
  const { fetchImpl } = tokenEndpoint(() => jsonResponse({ access_token: 'x'.repeat(4096), expires_in: -5, refresh_token: 'bad\u0000token' }));
  const result = await tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID });
  assert.equal(result.accessToken.length, 4096);
  assert.equal(result.expiresIn, null);
  assert.equal(result.refreshToken, '');
});

test('tokenRequest() never sends a secret for public clients and falls back to body client_id for Basic without a secret', async () => {
  const publicClient = tokenEndpoint();
  await tokenRequest({ ...CONFIG, secret: 'none' }, { grant_type: 'authorization_code', code: 'code-1' }, {
    fetchImpl: publicClient.fetchImpl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  assert.equal(formBody(publicClient.calls[0]).get('client_id'), CLIENT_ID);
  assert.equal(formBody(publicClient.calls[0]).has('client_secret'), false);
  assert.equal(publicClient.calls[0].init.headers.Authorization, undefined);
  assert.equal(publicClient.calls[0].init.body.includes(CLIENT_SECRET), false);

  // Airtable: Basic when a secret exists, body client_id otherwise.
  const airtable = OAUTH_PROVIDERS.airtable;
  const noSecret = tokenEndpoint();
  await tokenRequest(airtable, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl: noSecret.fetchImpl, clientId: CLIENT_ID });
  assert.equal(noSecret.calls[0].url, 'https://airtable.com/oauth2/v1/token');
  assert.equal(noSecret.calls[0].init.headers.Authorization, undefined);
  assert.equal(formBody(noSecret.calls[0]).get('client_id'), CLIENT_ID);
  const withSecret = tokenEndpoint();
  await tokenRequest(airtable, { grant_type: 'authorization_code', code: 'code-1' }, {
    fetchImpl: withSecret.fetchImpl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  assert.equal(withSecret.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.equal(formBody(withSecret.calls[0]).has('client_id'), false);
  assert.equal(formBody(withSecret.calls[0]).has('client_secret'), false);
});

test('tokenRequest() maps network failures and timeouts to fixed messages and refuses plain HTTP', async () => {
  const failing = async () => { throw new Error(`connect ECONNREFUSED with ${CLIENT_SECRET}`); };
  await assert.rejects(
    tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl: failing, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    (error) => error.message === 'Could not reach the OAuth token endpoint.' && !error.message.includes(CLIENT_SECRET),
  );
  await assert.rejects(
    tokenRequest(CONFIG, { grant_type: 'authorization_code', code: 'code-1' }, {
      fetchImpl: () => new Promise(() => {}), clientId: CLIENT_ID, timeoutMs: 20,
    }),
    (error) => error.code === 'TIMEOUT' && error.message === 'OAuth token exchange timed out.',
  );
  const { calls, fetchImpl } = tokenEndpoint();
  await assert.rejects(
    tokenRequest({ ...CONFIG, tokenUrl: 'http://auth.example.test/token' }, { grant_type: 'authorization_code', code: 'code-1' }, { fetchImpl, clientId: CLIENT_ID }),
    /non-HTTPS/,
  );
  assert.equal(calls.length, 0);
});

test('refresh() posts to refreshUrl and keeps the old refresh token when none is returned', async () => {
  const { calls, fetchImpl } = tokenEndpoint(() => jsonResponse({ access_token: 'figd_access-2', expires_in: '7776000' }));
  const result = await refresh(OAUTH_PROVIDERS.figma, {
    refreshToken: 'refresh-1', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
  });
  assert.deepEqual(result, { accessToken: 'figd_access-2', refreshToken: 'refresh-1', expiresIn: 7776000, scope: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.figma.com/v1/oauth/refresh');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  const body = formBody(calls[0]);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-1');
});

test('refresh() uses tokenUrl without a refreshUrl and returns a rotated refresh token', async () => {
  const { calls, fetchImpl } = tokenEndpoint(() => jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));
  const result = await refresh(CONFIG, { refreshToken: 'refresh-1', clientId: CLIENT_ID, fetchImpl });
  assert.equal(calls[0].url, CONFIG.tokenUrl);
  assert.equal(result.refreshToken, 'refresh-2');
  assert.equal(result.accessToken, 'access-2');
  await assert.rejects(refresh(CONFIG, { refreshToken: '', clientId: CLIENT_ID, fetchImpl }), (error) => error.code === 'NO_REFRESH_TOKEN');
});

test('fetchIdentity() resolves dot paths with array indexes and sends a Bearer token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ result: [{ name: '  Acme\u0007 Corp\u202e ' }, { name: 'Second account' }] });
  };
  const result = await fetchIdentity(OAUTH_PROVIDERS.cloudflare, 'cf-access', { fetchImpl });
  assert.deepEqual(result, { status: 200, identity: 'Acme Corp' });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cf-access');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal('body' in calls[0].init, false);
});

test('fetchIdentity() substitutes {access_token} and {shop} and then sends no Authorization header', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { shop: { name: 'Example Store', myshopifyDomain: 'example.myshopify.com' } } });
  };
  const config = OAUTH_PROVIDERS.shopify;
  const result = await fetchIdentity(config, 'shpat_token', { fetchImpl, shop: 'example.myshopify.com' });
  assert.deepEqual(result, { status: 200, identity: 'Example Store' });
  assert.equal(calls[0].url, 'https://example.myshopify.com/admin/api/2026-07/graphql.json');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Shopify-Access-Token'], 'shpat_token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === 'authorization'), false);
  assert.equal(calls[0].init.body, config.identity.body);
});

test('fetchIdentity() keeps provider headers, stringifies numbers and bounds the identity', async () => {
  const calls = [];
  const respond = (payload) => async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(payload);
  };
  const github = await fetchIdentity(OAUTH_PROVIDERS.github, 'gho_token', { fetchImpl: respond({ login: 'octocat' }) });
  assert.deepEqual(github, { status: 200, identity: 'octocat' });
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gho_token');

  const numeric = { identity: { method: 'GET', url: 'https://api.example.test/me', field: 'user.id' } };
  assert.deepEqual(await fetchIdentity(numeric, 'token', { fetchImpl: respond({ user: { id: 12345 } }) }), { status: 200, identity: '12345' });
  const long = await fetchIdentity(numeric, 'token', { fetchImpl: respond({ user: { id: `  ${'n'.repeat(300)}` } }) });
  assert.equal(long.identity, 'n'.repeat(128));
  assert.deepEqual(await fetchIdentity(numeric, 'token', { fetchImpl: respond({ user: { id: { nested: true } } }) }), { status: 200, identity: null });
  assert.deepEqual(await fetchIdentity(numeric, 'token', { fetchImpl: respond({ user: { id: '   ' } }) }), { status: 200, identity: null });
  assert.deepEqual(await fetchIdentity(numeric, 'token', { fetchImpl: respond({ other: 1 }) }), { status: 200, identity: null });
});

test('fetchIdentity() returns nulls instead of throwing', async () => {
  let called = 0;
  const counting = async () => { called += 1; return jsonResponse({ email: 'a@example.test' }); };
  const config = { identity: { method: 'GET', url: 'https://api.example.test/me', field: 'email' } };
  assert.deepEqual(await fetchIdentity({ identity: null }, 'token', { fetchImpl: counting }), { status: null, identity: null });
  assert.deepEqual(await fetchIdentity(config, '', { fetchImpl: counting }), { status: null, identity: null });
  assert.deepEqual(await fetchIdentity(config, 'bad\ntoken', { fetchImpl: counting }), { status: null, identity: null });
  assert.deepEqual(await fetchIdentity(OAUTH_PROVIDERS.shopify, 'token', { fetchImpl: counting, shop: 'evil.example.test' }), { status: null, identity: null });
  assert.deepEqual(await fetchIdentity({ identity: { ...config.identity, url: 'http://api.example.test/me' } }, 'token', { fetchImpl: counting }), { status: null, identity: null });
  assert.equal(called, 0);

  const failing = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: failing }), { status: null, identity: null });
  const hanging = () => new Promise(() => {});
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: hanging, timeoutMs: 20 }), { status: null, identity: null });
  const rejected = async () => jsonResponse({ message: 'Bad credentials' }, { status: 401 });
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: rejected }), { status: 401, identity: null });
  const notJson = async () => new Response('<html></html>', { status: 200 });
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: notJson }), { status: 200, identity: null });
  const oversized = async () => new Response('{}', { headers: { 'content-length': String(300 * 1024) } });
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: oversized }), { status: 200, identity: null });
  const redirected = async () => {
    const response = jsonResponse({ email: 'a@example.test' });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  assert.deepEqual(await fetchIdentity(config, 'token', { fetchImpl: redirected }), { status: null, identity: null });
});
