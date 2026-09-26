'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMcpManager, McpError } = require('../lib/mcp.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.cjs');
const SECRET = 'sk-live-super-secret-value-123456';
const MISSING_COMMAND = '/private/tmp/scalemax-mcp-missing-command';

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

function makeManager(overrides = {}) {
  const store = overrides.store || memoryStore();
  const pids = [];
  const spawnCalls = [];
  const mcp = createMcpManager({
    store,
    safeStorage: overrides.safeStorage,
    now: overrides.now || (() => 1_700_000_000_000),
    env: overrides.env || process.env,
    platform: overrides.platform || process.platform,
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = spawn(command, args, options);
      if (child.pid) pids.push(child.pid);
      return child;
    },
  });
  return { mcp, store, pids, spawnCalls };
}

function stdioInput(extra = {}) {
  return { name: 'Fake', transport: 'stdio', command: process.execPath, args: [FIXTURE], ...extra };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startHttpServer(handle) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
    requests.push(entry);
    handle(entry, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const HTTP_TOOLS = [
  { name: 'echo', description: 'Echo over HTTP.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

function sendJson(res, payload, headers = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

// A small Streamable HTTP MCP server: JSON for initialize and tools/list, SSE
// for tools/call (with a server ping and list_changed in the stream), 202 for
// notifications and client responses, 404 for unknown sessions.
function httpMcpHandler({ tools = HTTP_TOOLS, protocolVersion = '2025-06-18' } = {}) {
  const state = {
    sessions: new Set(), initializeCount: 0, notifications: [], clientResponses: [], streamsClosed: 0, deletes: [],
  };
  function handle({ method, headers, body }, res) {
    if (method === 'DELETE') {
      state.deletes.push(headers['mcp-session-id']);
      res.writeHead(204);
      res.end();
      return;
    }
    if (body?.method === 'initialize') {
      state.initializeCount += 1;
      const sessionId = `session-${state.initializeCount}`;
      state.sessions.add(sessionId);
      sendJson(res, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion,
          serverInfo: { name: 'http-fake', version: '2.0.0' },
          capabilities: { tools: { listChanged: true } },
        },
      }, { 'mcp-session-id': sessionId });
      return;
    }
    if (!state.sessions.has(headers['mcp-session-id'])) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (typeof body.method !== 'string') {
      state.clientResponses.push(body);
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.id === undefined) {
      state.notifications.push(body.method);
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === 'tools/list') {
      sendJson(res, { jsonrpc: '2.0', id: body.id, result: { tools } });
      return;
    }
    if (body.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.on('close', () => { state.streamsClosed += 1; });
      res.write(': keep-alive comment\n\n');
      res.write(`event: message\nid: 1\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-ping-1', method: 'ping' })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            { type: 'text', text: `echo:${body.params.arguments.text}` },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'resource_link', uri: 'file:///private/tmp/report.txt', name: 'report' },
          ],
        },
      });
      // The response spans two data lines (joined with '\n') and CRLF endings;
      // the stream then stays open until the client cancels it.
      const cut = response.indexOf(',"result"') + 1;
      res.write(`data: ${response.slice(0, cut)}\r\ndata: ${response.slice(cut)}\r\n\r\n`);
      return;
    }
    sendJson(res, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  }
  return { state, handle };
}

test('save encrypts env secrets and list() exposes key names only', () => {
  const { mcp, store } = makeManager({ safeStorage: ENCRYPTING_STORAGE });
  const entry = mcp.save(stdioInput({ name: 'My Server!', env: { API_TOKEN: SECRET, REGION: 'eu-west-1' } }));
  assert.deepEqual(entry, {
    id: 'my-server',
    name: 'My Server!',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    cwd: null,
    url: null,
    enabled: true,
    envKeys: ['API_TOKEN', 'REGION'],
    headerKeys: [],
    secretStorage: 'encrypted',
    lastStatus: 'never',
    lastError: null,
    toolCount: 0,
    connected: false,
    serverInfo: null,
    updatedAt: 1_700_000_000_000,
  });
  const record = store.snapshot().mcpServers['my-server'];
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.createdAt, 1_700_000_000_000);
  assert.deepEqual(record.secretKeys, { env: ['API_TOKEN', 'REGION'], headers: [] });
  assert.match(record.encryptedSecrets, /^[A-Za-z0-9+/]+={0,2}$/);
  const decrypted = Buffer.from(record.encryptedSecrets, 'base64').toString().replace(/^enc:/, '');
  assert.deepEqual(JSON.parse(decrypted), { env: { API_TOKEN: SECRET, REGION: 'eu-west-1' }, headers: {} });
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET), false);
  for (const value of [SECRET, 'eu-west-1', record.encryptedSecrets]) {
    assert.equal(JSON.stringify(mcp.list()).includes(value), false);
  }
  // Same name again: the derived id stays unique.
  assert.equal(mcp.save(stdioInput({ name: 'My Server!' })).id, 'my-server-2');
  assert.deepEqual(mcp.list().map((item) => item.id), ['my-server', 'my-server-2']);
});

test('keeps secrets in memory only when encryption is unavailable', async (t) => {
  const store = memoryStore();
  const noEncryption = { isEncryptionAvailable: () => false };
  const { mcp } = makeManager({ store, safeStorage: noEncryption });
  t.after(() => mcp.closeAll());
  const entry = mcp.save(stdioInput({ env: { FAKE_MCP_ECHO_PREFIX: 'session-secret-prefix:' } }));
  assert.equal(entry.secretStorage, 'session');
  assert.equal(store.snapshot().mcpServers.fake.encryptedSecrets, undefined);
  assert.equal(JSON.stringify(store.snapshot()).includes('session-secret-prefix'), false);
  const echoed = await mcp.callTool({ id: 'fake', name: 'echo', arguments: { text: 'hi' } });
  assert.equal(echoed.text, 'session-secret-prefix:hi');
  // After a restart the values are gone; connecting says so instead of
  // launching the server without them.
  const restarted = makeManager({ store, safeStorage: noEncryption });
  assert.equal(restarted.mcp.list()[0].secretStorage, 'session');
  assert.deepEqual(restarted.mcp.list()[0].envKeys, ['FAKE_MCP_ECHO_PREFIX']);
  await assert.rejects(
    () => restarted.mcp.test({ id: 'fake' }),
    (error) => error instanceof McpError && /previous session/.test(error.message),
  );
  assert.equal(restarted.spawnCalls.length, 0);
  assert.equal(restarted.mcp.list()[0].lastStatus, 'error');
});

test('updates keep omitted secrets, replace provided ones, and clear with {}', () => {
  const { mcp, store } = makeManager({ safeStorage: ENCRYPTING_STORAGE });
  mcp.save(stdioInput({ env: { API_TOKEN: SECRET } }));
  const blob = store.snapshot().mcpServers.fake.encryptedSecrets;
  const renamed = mcp.save(stdioInput({ id: 'fake', name: 'Renamed', enabled: false }));
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.enabled, false);
  assert.deepEqual(renamed.envKeys, ['API_TOKEN']);
  assert.equal(store.snapshot().mcpServers.fake.encryptedSecrets, blob);
  // Omitting `enabled` on update keeps the current value.
  assert.equal(mcp.save(stdioInput({ id: 'fake' })).enabled, false);
  const replaced = mcp.save(stdioInput({ id: 'fake', env: { OTHER_TOKEN: 'another-secret-value' } }));
  assert.deepEqual(replaced.envKeys, ['OTHER_TOKEN']);
  assert.notEqual(store.snapshot().mcpServers.fake.encryptedSecrets, blob);
  const cleared = mcp.save(stdioInput({ id: 'fake', env: {} }));
  assert.equal(cleared.secretStorage, 'none');
  assert.deepEqual(cleared.envKeys, []);
  assert.equal(store.snapshot().mcpServers.fake.encryptedSecrets, undefined);
  // Switching transports drops secrets that no longer apply.
  mcp.save(stdioInput({ id: 'fake', env: { API_TOKEN: SECRET } }));
  const remote = mcp.save({ id: 'fake', name: 'Remote', transport: 'http', url: 'https://mcp.example.com/mcp' });
  assert.equal(remote.command, null);
  assert.deepEqual(remote.args, []);
  assert.equal(remote.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(remote.envKeys, []);
  assert.equal(remote.secretStorage, 'none');
  assert.equal(JSON.stringify(store.snapshot()).includes('enc:'), false);
  assert.equal(mcp.list().length, 1);
  assert.equal(store.snapshot().mcpServers.fake.createdAt, 1_700_000_000_000);
});

test('accepts HTTPS and exact loopback HTTP URLs', () => {
  const { mcp } = makeManager();
  const urls = [
    'https://mcp.example.com/mcp?team=core',
    'http://127.0.0.1:8080/mcp',
    'http://localhost:3000/mcp',
    'http://[::1]:9000/mcp',
  ];
  for (const [index, url] of urls.entries()) {
    assert.equal(mcp.save({ name: `Server ${index}`, transport: 'http', url }).url, new URL(url).href);
  }
  assert.equal(mcp.list().length, urls.length);
});

test('rejects invalid server settings with clean errors', () => {
  const { mcp } = makeManager();
  const web = (extra) => ({ name: 'Web', transport: 'http', url: 'https://example.com/mcp', ...extra });
  const many = (count, key, value) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${key}${i}`, value]));
  const cases = [
    [stdioInput({ name: '' }), /name must be 1-64 printable/],
    [stdioInput({ name: 'x'.repeat(65) }), /name must be 1-64 printable/],
    [stdioInput({ name: 'bad\nname' }), /name must be 1-64 printable/],
    [stdioInput({ transport: 'sse' }), /transport must be/],
    [stdioInput({ command: '' }), /command must be/],
    [stdioInput({ command: 'node\n--evil' }), /command must be/],
    [stdioInput({ command: 'x'.repeat(1025) }), /command must be/],
    [stdioInput({ args: 'not-an-array' }), /args must be an array/],
    [stdioInput({ args: Array.from({ length: 65 }, () => 'a') }), /at most 64 strings/],
    [stdioInput({ args: ['ok', 'bad\0arg'] }), /Each MCP server arg/],
    [stdioInput({ cwd: 'relative/dir' }), /absolute path/],
    [stdioInput({ env: { 'BAD-KEY': 'x' } }), /Environment variable names/],
    [stdioInput({ env: { TOKEN: `${SECRET}\ninjected` } }), /Environment variable values/],
    [stdioInput({ env: { TOKEN: 'x'.repeat(8193) } }), /Environment variable values/],
    [stdioInput({ env: many(65, 'K', 'v') }), /At most 64/],
    [stdioInput({ env: null }), /environment variables must be an object/],
    [stdioInput({ enabled: 'yes' }), /enabled flag/],
    [stdioInput({ id: 'Bad_Id' }), /server id must be/],
    [stdioInput({ id: 'constructor' }), /server id must be/],
    [web({ url: 'http://example.com/mcp' }), /allowed only for 127\.0\.0\.1/],
    [web({ url: 'http://127.0.0.2/mcp' }), /allowed only for/],
    [web({ url: 'http://localhost.evil.com/mcp' }), /allowed only for/],
    [web({ url: 'https://user:pw@example.com/mcp' }), /without credentials/],
    [web({ url: 'https://example.com/mcp#frag' }), /without credentials or a fragment/],
    [web({ url: 'ftp://example.com/mcp' }), /must be an https/],
    [web({ url: `https://example.com/${'a'.repeat(2048)}` }), /at most 2048/],
    [web({ headers: { Host: 'evil.example.com' } }), /Host header is managed by ScaleMax/],
    [web({ headers: { 'content-type': 'text/plain' } }), /content-type header is managed/],
    [web({ headers: { 'Mcp-Session-Id': 'x' } }), /Mcp-Session-Id header is managed/],
    [web({ headers: { 'MCP-Protocol-Version': '2025-06-18' } }), /header is managed/],
    [web({ headers: { 'Keep-Alive': 'timeout=5' } }), /header is managed/],
    [web({ headers: { 'X Bad': 'x' } }), /Header names must be/],
    [web({ headers: { Authorization: `Bearer ${SECRET}\u2022` } }), /printable ASCII/],
    [web({ headers: { 'X-A': '1', 'x-a': '2' } }), /unique/],
    [web({ headers: many(33, 'X-H', 'v') }), /At most 32/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => mcp.save(input),
      (error) => error instanceof McpError && error.code === 'MCP_ERROR' && pattern.test(error.message)
        && !error.message.includes(SECRET),
      `expected ${pattern} for ${JSON.stringify(input).slice(0, 120)}`,
    );
  }
  assert.deepEqual(mcp.list(), []);
});

test('caps configured servers at 20 and ignores invalid stored records', () => {
  const { mcp, store } = makeManager();
  for (let index = 0; index < 20; index += 1) mcp.save(stdioInput({ name: `Server ${index}` }));
  assert.throws(() => mcp.save(stdioInput({ name: 'One too many' })), /At most 20 MCP servers/);
  assert.equal(mcp.save(stdioInput({ id: 'server-0', name: 'Still updatable' })).name, 'Still updatable');

  const valid = store.snapshot().mcpServers['server-0'];
  const damaged = makeManager({
    store: memoryStore({
      mcpServers: {
        good: valid,
        'Bad Id': valid,
        broken: { ...valid, command: 'bad\ncommand' },
        weird: { ...valid, transport: 'carrier-pigeon' },
      },
    }),
  });
  assert.deepEqual(damaged.mcp.list().map((entry) => entry.id), ['good']);
  const corrupt = makeManager({ store: memoryStore({ mcpServers: ['not', 'an', 'object'] }) });
  assert.throws(() => corrupt.mcp.list(), (error) => error instanceof McpError && /invalid/.test(error.message));
});

test('test() initializes a stdio server and lists its tools', async (t) => {
  const { mcp, store } = makeManager();
  t.after(() => mcp.closeAll());
  const { id } = mcp.save(stdioInput());
  const result = await mcp.test({ id });
  assert.deepEqual(result, {
    ok: true,
    serverInfo: { name: 'fake-mcp', version: '1.0.0' },
    protocolVersion: '2025-06-18',
    tools: [
      { name: 'echo', title: 'Echo', description: 'Echo the provided text back.', readOnly: true },
      { name: 'add', title: 'add', description: 'Add two numbers.', readOnly: false },
    ],
  });
  const entry = mcp.list()[0];
  assert.equal(entry.lastStatus, 'ok');
  assert.equal(entry.lastError, null);
  assert.equal(entry.toolCount, 2);
  assert.equal(entry.connected, true);
  assert.deepEqual(entry.serverInfo, { name: 'fake-mcp', version: '1.0.0' });
  assert.equal(store.snapshot().mcpServers.fake.toolCount, 2);
  await mcp.closeAll();
  assert.equal(mcp.list()[0].connected, false);
});

test('callTool returns text, structured content and tool errors over one connection', async (t) => {
  const { mcp, spawnCalls } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput());
  assert.deepEqual(await mcp.callTool({ id: 'fake', name: 'echo', arguments: { text: 'hello' } }), {
    isError: false, text: 'hello', contentTypes: ['text'],
  });
  assert.deepEqual(await mcp.callTool({ id: 'fake', name: 'add', arguments: { a: 2, b: 3 } }), {
    isError: false, text: '5', structured: { sum: 5 }, contentTypes: ['text'],
  });
  const unknown = await mcp.callTool({ id: 'fake', name: 'nope' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown tool: nope/);
  assert.equal((await mcp.listTools({ id: 'fake' })).length, 2);
  assert.equal(spawnCalls.length, 1);
  await assert.rejects(
    () => mcp.callTool({ id: 'fake', name: 'echo', arguments: ['not', 'an', 'object'] }),
    (error) => error instanceof McpError && /arguments must be an object/.test(error.message),
  );
  await assert.rejects(
    () => mcp.callTool({ id: 'missing', name: 'echo' }),
    (error) => error instanceof McpError && error.code === 'MCP_NOT_FOUND',
  );
  mcp.save(stdioInput({ id: 'fake', enabled: false }));
  await assert.rejects(() => mcp.callTool({ id: 'fake', name: 'echo' }), /disabled/);
});

test('listTools follows nextCursor pagination', async (t) => {
  const { mcp } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput({ env: { FAKE_MCP_PAGINATE: '1' } }));
  const tools = await mcp.listTools({ id: 'fake' });
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'add']);
  assert.equal(mcp.list()[0].toolCount, 2);
});

test('passes the merged environment and extends PATH on macOS only', async (t) => {
  const darwin = makeManager({ env: { PATH: '/usr/bin:/bin', HOME: '/private/tmp' }, platform: 'darwin' });
  t.after(() => darwin.mcp.closeAll());
  darwin.mcp.save(stdioInput({ env: { FAKE_MCP_ECHO_PREFIX: 'prefix-from-env:' } }));
  const echoed = await darwin.mcp.callTool({ id: 'fake', name: 'echo', arguments: { text: 'x' } });
  assert.equal(echoed.text, 'prefix-from-env:x');
  const { options } = darwin.spawnCalls[0];
  assert.equal(options.env.PATH, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(options.env.HOME, '/private/tmp');
  assert.equal(options.env.FAKE_MCP_ECHO_PREFIX, 'prefix-from-env:');
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, null);

  const linux = makeManager({ env: { PATH: '/usr/bin:/bin' }, platform: 'linux' });
  t.after(() => linux.mcp.closeAll());
  linux.mcp.save(stdioInput({ cwd: '/private/tmp' }));
  await linux.mcp.test({ id: 'fake' });
  assert.equal(linux.spawnCalls[0].options.env.PATH, '/usr/bin:/bin');
  assert.equal(linux.spawnCalls[0].options.cwd, '/private/tmp');
});

test('a crashing server fails cleanly with a redacted stderr excerpt', async (t) => {
  const { mcp, store } = makeManager({ safeStorage: ENCRYPTING_STORAGE });
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput({ env: { FAKE_MCP_CRASH: '1', FAKE_MCP_LEAK: SECRET } }));
  await assert.rejects(() => mcp.test({ id: 'fake' }), (error) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'MCP_ERROR');
    assert.match(error.message, /exited with code 3/);
    assert.match(error.message, /Server output: boom/);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  const entry = mcp.list()[0];
  assert.equal(entry.lastStatus, 'error');
  assert.match(entry.lastError, /boom/);
  assert.equal(entry.connected, false);
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET), false);
});

test('a missing command or working directory fails with a clean error', async (t) => {
  const { mcp } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput({ command: MISSING_COMMAND, args: [] }));
  await assert.rejects(
    () => mcp.test({ id: 'fake' }),
    (error) => error instanceof McpError && error.message === `Command not found: ${MISSING_COMMAND}`,
  );
  assert.equal(mcp.list()[0].lastError, `Command not found: ${MISSING_COMMAND}`);
  mcp.save(stdioInput({ id: 'fake', cwd: '/private/tmp/scalemax-mcp-missing-dir' }));
  await assert.rejects(() => mcp.listTools({ id: 'fake' }), /Working directory not found/);
});

test('a stdout line over 4 MiB fails the connection', async (t) => {
  const { mcp, pids } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput({ env: { FAKE_MCP_HUGE_LINE: '1' } }));
  await assert.rejects(() => mcp.test({ id: 'fake' }), /larger than the 4 MB limit/);
  await waitFor(() => !isAlive(pids[0]));
});

test('closeAll terminates the server process', async () => {
  const { mcp, pids } = makeManager();
  mcp.save(stdioInput());
  await mcp.listTools({ id: 'fake' });
  assert.equal(pids.length, 1);
  assert.equal(isAlive(pids[0]), true);
  await mcp.closeAll();
  assert.throws(() => process.kill(pids[0], 0), { code: 'ESRCH' });
  assert.equal(mcp.list()[0].connected, false);
  // closeAll is safe to repeat.
  await mcp.closeAll();
});

test('save and remove close the live client', async (t) => {
  const { mcp, pids, store } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save(stdioInput());
  await mcp.listTools({ id: 'fake' });
  assert.equal(mcp.list()[0].connected, true);
  mcp.save(stdioInput({ id: 'fake', name: 'Renamed' }));
  assert.equal(mcp.list()[0].connected, false);
  await waitFor(() => !isAlive(pids[0]));
  await mcp.listTools({ id: 'fake' });
  assert.equal(pids.length, 2);
  assert.deepEqual(mcp.remove({ id: 'fake' }), { removed: true });
  await waitFor(() => !isAlive(pids[1]));
  assert.deepEqual(mcp.remove({ id: 'fake' }), { removed: false });
  assert.equal(store.snapshot().mcpServers, undefined);
  await assert.rejects(() => mcp.listTools({ id: 'fake' }), (error) => error.code === 'MCP_NOT_FOUND');
});

test('Streamable HTTP: session headers, JSON and SSE replies, server requests, DELETE on close', async (t) => {
  const handler = httpMcpHandler();
  const server = await startHttpServer(handler.handle);
  t.after(() => server.close());
  const { mcp, store } = makeManager({ safeStorage: ENCRYPTING_STORAGE });
  t.after(() => mcp.closeAll());
  const saved = mcp.save({ name: 'Remote Docs', transport: 'http', url: server.url, headers: { Authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(saved.headerKeys, ['Authorization']);
  assert.equal(saved.secretStorage, 'encrypted');

  const result = await mcp.test({ id: saved.id });
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'http-fake', version: '2.0.0' });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['echo']);
  const [initialize, initialized, list] = server.requests;
  assert.equal(initialize.method, 'POST');
  assert.equal(initialize.body.method, 'initialize');
  assert.deepEqual(initialize.body.params, {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ScaleMax', version: '1.0.0' },
  });
  assert.equal(initialize.headers['content-type'], 'application/json');
  assert.equal(initialize.headers.accept, 'application/json, text/event-stream');
  assert.equal(initialize.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(initialize.headers['mcp-session-id'], undefined);
  assert.equal(initialize.headers['mcp-protocol-version'], undefined);
  assert.equal(initialized.body.method, 'notifications/initialized');
  assert.equal(list.body.method, 'tools/list');
  for (const request of [initialized, list]) {
    assert.equal(request.headers['mcp-session-id'], 'session-1');
    assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
  }
  assert.deepEqual(handler.state.notifications, ['notifications/initialized']);

  const called = await mcp.callTool({ id: saved.id, name: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual(called, {
    isError: false,
    text: 'echo:hi\n[image: image/png]\n[resource: file:///private/tmp/report.txt]',
    contentTypes: ['text', 'image', 'resource_link'],
  });
  // Server requests that arrived in the stream were answered (ping with {},
  // anything else with -32601), and the still-open stream was cancelled once
  // the matching response had been read.
  await waitFor(() => handler.state.clientResponses.length === 2 && handler.state.streamsClosed === 1);
  const responses = [...handler.state.clientResponses].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  assert.deepEqual(responses, [
    { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } },
    { jsonrpc: '2.0', id: 'srv-ping-1', result: {} },
  ]);
  // notifications/tools/list_changed (sent in the stream) invalidated the cache.
  const toolListCount = () => server.requests.filter((request) => request.body?.method === 'tools/list').length;
  await mcp.listTools({ id: saved.id });
  assert.equal(toolListCount(), 2);
  await mcp.listTools({ id: saved.id });
  assert.equal(toolListCount(), 2);

  await mcp.closeAll();
  const deleted = server.requests.find((request) => request.method === 'DELETE');
  assert.ok(deleted, 'expected a DELETE when the session closes');
  assert.equal(deleted.headers['mcp-session-id'], 'session-1');
  assert.equal(deleted.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(deleted.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(mcp.list()).includes(SECRET), false);
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET), false);
});

test('Streamable HTTP: an expired session is evicted and the next call reconnects', async (t) => {
  const handler = httpMcpHandler();
  const server = await startHttpServer(handler.handle);
  t.after(() => server.close());
  const { mcp } = makeManager();
  t.after(() => mcp.closeAll());
  const { id } = mcp.save({ name: 'Remote', transport: 'http', url: server.url });
  await mcp.listTools({ id });
  assert.equal(mcp.list()[0].connected, true);
  handler.state.sessions.clear();
  await assert.rejects(
    () => mcp.callTool({ id, name: 'echo', arguments: { text: 'x' } }),
    (error) => error instanceof McpError && error.message === 'MCP session expired; retry.',
  );
  assert.equal(mcp.list()[0].connected, false);
  const retried = await mcp.callTool({ id, name: 'echo', arguments: { text: 'again' } });
  assert.match(retried.text, /^echo:again/);
  assert.equal(handler.state.initializeCount, 2);
  // The expired session is not DELETEd; only the live one is on close.
  await mcp.closeAll();
  assert.deepEqual(handler.state.deletes, ['session-2']);
});

test('Streamable HTTP: unsupported protocol versions and HTTP failures are clean errors', async (t) => {
  const handler = httpMcpHandler({ protocolVersion: '1999-01-01' });
  const server = await startHttpServer(handler.handle);
  t.after(() => server.close());
  const { mcp } = makeManager();
  t.after(() => mcp.closeAll());
  const { id } = mcp.save({ name: 'Old', transport: 'http', url: server.url });
  await assert.rejects(
    () => mcp.test({ id }),
    (error) => error.code === 'MCP_PROTOCOL' && /^Unsupported MCP protocol version/.test(error.message),
  );
  const unauthorized = await startHttpServer((_entry, res) => { res.writeHead(401); res.end(); });
  t.after(() => unauthorized.close());
  const other = mcp.save({ name: 'Locked', transport: 'http', url: unauthorized.url });
  await assert.rejects(() => mcp.test({ id: other.id }), /rejected the credentials \(HTTP 401\)/);
  const redirecting = await startHttpServer((_entry, res) => {
    res.writeHead(307, { location: 'https://elsewhere.example.com/mcp' });
    res.end();
  });
  t.after(() => redirecting.close());
  const moved = mcp.save({ name: 'Moved', transport: 'http', url: redirecting.url });
  await assert.rejects(() => mcp.test({ id: moved.id }), (error) => error.message === 'MCP server redirects are not allowed.');
  const down = mcp.save({ name: 'Down', transport: 'http', url: 'http://127.0.0.1:9/mcp' });
  await assert.rejects(() => mcp.test({ id: down.id }), (error) => error.message === 'Could not reach the MCP server.');
});

test('chatTools builds sanitized, unique function names and isolates failures', async (t) => {
  const longName = 'x'.repeat(100);
  const readFileSchema = { type: 'object', properties: { path: { type: 'string' } } };
  const handler = httpMcpHandler({
    tools: [
      { name: 'get.file', description: 'Read a file.', inputSchema: readFileSchema, annotations: { readOnlyHint: true } },
      { name: 'get_file', description: 'Another reader.', inputSchema: { type: 'array' } },
      { name: longName, description: 'd'.repeat(2000), annotations: { readOnlyHint: true } },
      { name: 'write file', title: 'Write', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  const server = await startHttpServer(handler.handle);
  t.after(() => server.close());
  const { mcp, spawnCalls } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save({ name: 'Docs', transport: 'http', url: server.url });
  mcp.save(stdioInput());
  mcp.save(stdioInput({ name: 'Broken', command: MISSING_COMMAND, args: [] }));
  mcp.save(stdioInput({ name: 'Off', enabled: false }));

  const { tools, resolve, errors } = await mcp.chatTools();
  const names = tools.map((tool) => tool.function.name);
  assert.equal(names.length, 6);
  assert.equal(new Set(names).size, names.length);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.match(tool.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(tool.function.description.length <= 1024);
  }
  assert.equal(names[0], 'mcp_docs_get_file');
  assert.match(names[1], /^mcp_docs_get_file_[0-9a-f]{8}$/);
  assert.equal(names[2].length, 64);
  assert.match(names[2], /^mcp_docs_x{46}_[0-9a-f]{8}$/);
  assert.equal(names[3], 'mcp_docs_write_file');
  assert.deepEqual(names.slice(4), ['mcp_fake_echo', 'mcp_fake_add']);
  assert.equal(tools[0].function.description, '[Docs] Read a file.');
  assert.equal(tools[3].function.description, '[Docs] Write');
  assert.equal(tools[2].function.description.length, 1024);
  assert.deepEqual(tools[0].function.parameters, readFileSchema);
  assert.deepEqual(tools[1].function.parameters, { type: 'object', properties: {} });
  assert.deepEqual(tools[2].function.parameters, { type: 'object', properties: {} });
  assert.deepEqual(resolve('mcp_docs_get_file'), { serverId: 'docs', toolName: 'get.file', readOnly: true });
  assert.deepEqual(resolve(names[1]), { serverId: 'docs', toolName: 'get_file', readOnly: false });
  assert.deepEqual(resolve(names[2]), { serverId: 'docs', toolName: longName, readOnly: true });
  assert.deepEqual(resolve('mcp_fake_add'), { serverId: 'fake', toolName: 'add', readOnly: false });
  assert.equal(resolve('mcp_off_echo'), null);
  assert.equal(resolve(42), null);
  assert.deepEqual(errors, [{ serverId: 'broken', message: `Command not found: ${MISSING_COMMAND}` }]);
  // The disabled server was never started.
  assert.equal(spawnCalls.filter((call) => call.command === process.execPath).length, 1);

  const readOnly = await mcp.chatTools({ readOnlyOnly: true });
  assert.deepEqual(readOnly.tools.map((tool) => tool.function.name), [names[0], names[2], 'mcp_fake_echo']);
  assert.equal(readOnly.resolve('mcp_fake_add'), null);
});

test('chatTools exposes at most 128 tools', async (t) => {
  const tools = Array.from({ length: 200 }, (_, index) => ({
    name: `tool_${index}`, description: `Tool ${index}.`, inputSchema: { type: 'object', properties: {} },
  }));
  const handler = httpMcpHandler({ tools });
  const server = await startHttpServer(handler.handle);
  t.after(() => server.close());
  const { mcp } = makeManager();
  t.after(() => mcp.closeAll());
  mcp.save({ name: 'Big', transport: 'http', url: server.url });
  assert.equal((await mcp.listTools({ id: 'big' })).length, 200);
  const result = await mcp.chatTools();
  assert.equal(result.tools.length, 128);
  assert.equal(result.tools[127].function.name, 'mcp_big_tool_127');
  assert.deepEqual(result.errors, [
    { serverId: 'big', message: 'Some tools were omitted because the chat tool limit was reached.' },
  ]);
});

test('secrets that can no longer be decrypted produce a clean error', async () => {
  const store = memoryStore();
  makeManager({ store, safeStorage: ENCRYPTING_STORAGE }).mcp.save(stdioInput({ env: { API_TOKEN: SECRET } }));
  const locked = makeManager({ store, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(locked.mcp.list()[0].secretStorage, 'encrypted');
  await assert.rejects(
    () => locked.mcp.test({ id: 'fake' }),
    (error) => error instanceof McpError && /could not be decrypted/.test(error.message) && !error.message.includes(SECRET),
  );
  assert.equal(locked.spawnCalls.length, 0);
});

test('a tool call that never answers times out and is cancelled on the server', async (t) => {
  const log = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    log.push({ method: options.method, body, headers: options.headers, signal: options.signal });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-03-26', serverInfo: { name: 'slow', version: '1' }, capabilities: { tools: {} } },
      }, { headers: { 'mcp-session-id': 'slow-session' } });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    // tools/call never answers; it only ends when the client aborts it.
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const mcp = createMcpManager({ store: memoryStore(), fetchImpl });
  t.after(() => mcp.closeAll());
  mcp.save({ name: 'Slow', transport: 'http', url: 'https://mcp.example.com/mcp' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = mcp.callTool({ id: 'slow', name: 'hang' });
  pending.catch(() => {});
  while (!log.some((entry) => entry.body?.method === 'tools/call')) await new Promise((resolve) => setImmediate(resolve));
  const call = log.find((entry) => entry.body?.method === 'tools/call');
  assert.equal(call.headers['MCP-Protocol-Version'], '2025-03-26');
  t.mock.timers.tick(119_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(call.signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error) => error instanceof McpError && error.code === 'MCP_TIMEOUT'
    && /did not answer tools\/call within 120 seconds/.test(error.message));
  assert.equal(call.signal.aborted, true);
  await waitFor(() => log.some((entry) => entry.body?.method === 'notifications/cancelled'));
  const cancelled = log.find((entry) => entry.body?.method === 'notifications/cancelled');
  assert.deepEqual(cancelled.body.params, { requestId: call.body.id, reason: 'Request timed out.' });
  // A timeout is not a dead session: the client stays connected.
  assert.equal(mcp.list()[0].connected, true);
});
