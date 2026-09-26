'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('../lib/provider.cjs');

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

function makeProvider(overrides = {}) {
  const calls = [];
  const store = overrides.store || memoryStore();
  const provider = createProvider({
    store,
    safeStorage: overrides.safeStorage,
    approve: overrides.approve || (async () => true),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return overrides.respond(url, options);
    },
  });
  return { provider, store, calls };
}

test('rejects an HTTPS endpoint without an API key', async () => {
  const { provider } = makeProvider();
  await assert.rejects(
    () => provider.save({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }),
    /API key must be supplied/,
  );
});

test('allows loopback HTTP without a key and reports configured', async () => {
  const { provider } = makeProvider();
  const meta = await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  assert.equal(meta.configured, true);
  assert.equal(meta.hasKey, false);
  assert.equal(meta.model, 'llama3');
});

test('requires approval before changing the endpoint or key', async () => {
  let approved = 0;
  const { provider } = makeProvider({ approve: async () => { approved += 1; return false; } });
  await assert.rejects(
    () => provider.save({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-test-key-1234567890' }),
    /not approved/,
  );
  assert.equal(approved, 1);
});

test('stores a session key and never returns it from get()', async () => {
  const { provider, store } = makeProvider();
  const meta = await provider.save({
    baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-secret-value-123456',
  });
  assert.equal(meta.hasKey, true);
  assert.equal(meta.keyStorage, 'session');
  assert.equal('key' in meta, false);
  // Without safeStorage the plaintext key must not be persisted.
  assert.equal(store.snapshot().provider.encryptedKey, undefined);
  assert.equal(store.snapshot().provider.keyStorage, 'session');
});

test('encrypts the key when safeStorage is available', async () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
  };
  const { provider, store } = makeProvider({ safeStorage });
  const meta = await provider.save({
    baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-secret-value-123456',
  });
  assert.equal(meta.keyStorage, 'encrypted');
  assert.equal(store.snapshot().provider.keyStorage, 'encrypted');
  assert.match(store.snapshot().provider.encryptedKey, /^[A-Za-z0-9+/]+={0,2}$/);
});

test('send posts the conversation and returns assistant text', async () => {
  const { provider, calls } = makeProvider({
    respond: () => jsonResponse({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'Hello from the provider.' } }],
      usage: { total_tokens: 12 },
    }),
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-4o-mini' });
  const result = await provider.send({
    requestId: 'req-1',
    systemPrompt: 'Be terse.',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(result.text, 'Hello from the provider.');
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.usage.total_tokens, 12);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Be terse.' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Hi' });
});

test('send rejects provider redirects', async () => {
  const { provider } = makeProvider({
    respond: () => ({
      status: 302,
      redirected: true,
      headers: { get: () => null },
      body: { cancel: () => Promise.resolve() },
    }),
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  await assert.rejects(
    () => provider.send({ requestId: 'req-2', messages: [{ role: 'user', content: 'Hi' }] }),
    /redirects are not allowed/,
  );
});

test('send rejects responses over the 4 MB limit', async () => {
  const { provider } = makeProvider({
    respond: () => ({
      status: 200,
      redirected: false,
      headers: { get: (name) => (name === 'content-length' ? String(5 * 1024 * 1024) : null) },
      body: { cancel: () => Promise.resolve() },
    }),
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  await assert.rejects(
    () => provider.send({ requestId: 'req-3', messages: [{ role: 'user', content: 'Hi' }] }),
    /4 MB limit/,
  );
});

test('cancel aborts an in-flight request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { provider } = makeProvider({
    respond: async () => {
      await gate;
      return jsonResponse({ choices: [{ message: { content: 'late' } }] });
    },
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  const pending = provider.send({ requestId: 'req-4', messages: [{ role: 'user', content: 'Hi' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.cancel('req-4'), true);
  await assert.rejects(() => pending, /cancelled/);
  release();
});

test('clear removes the stored provider record', async () => {
  const { provider, store } = makeProvider();
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  const meta = provider.clear();
  assert.equal(meta.configured, false);
  assert.equal(store.snapshot().provider, undefined);
});

test('discover picks the ScaleMax endpoint that authenticates the key', async () => {
  const seen = [];
  const { provider } = makeProvider({
    respond: (url) => {
      seen.push(url);
      // The root /v1 rejects the key; only the /token/v1 endpoint accepts it.
      if (url.includes('api.scalemax.pro/v1/models')) {
        return { status: 401, redirected: false, headers: { get: () => null }, body: { cancel: () => Promise.resolve() } };
      }
      return jsonResponse({
        data: [
          { id: 'gpt-5.5', display_name: 'GPT-5.5', availability: 'available' },
          { id: 'claude-sonnet-5[1m]', display_name: 'Claude Sonnet 5', availability: 'unavailable' },
        ],
      });
    },
  });
  const result = await provider.discover({ kind: 'scalemax', apiKey: 'sm_live_test_key_1234567890' });
  assert.equal(result.kind, 'scalemax');
  assert.equal(result.baseUrl, 'https://api.scalemax.pro/token/v1');
  assert.deepEqual(result.models, [
    { id: 'gpt-5.5', displayName: 'GPT-5.5', available: true },
    { id: 'claude-sonnet-5[1m]', displayName: 'Claude Sonnet 5', available: false },
  ]);
  assert.equal(seen[0], 'https://api.scalemax.pro/v1/models');
  assert.equal(seen[1], 'https://api.scalemax.pro/token/v1/models');
});

test('discover reports an unauthorized ScaleMax key', async () => {
  const { provider } = makeProvider({
    respond: () => ({ status: 401, redirected: false, headers: { get: () => null }, body: { cancel: () => Promise.resolve() } }),
  });
  await assert.rejects(
    () => provider.discover({ kind: 'scalemax', apiKey: 'sm_live_bad_key_000000000000' }),
    /rejected this API key/,
  );
});

test('save persists the preset kind, enabled models and catalog', async () => {
  const { provider, store } = makeProvider();
  const meta = await provider.save({
    kind: 'scalemax',
    baseUrl: 'https://api.scalemax.pro/token/v1',
    enabledModels: ['gpt-5.5', 'claude-sonnet-5[1m]'],
    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', available: true }],
    apiKey: 'sm_live_test_key_1234567890',
  });
  assert.equal(meta.kind, 'scalemax');
  assert.equal(meta.model, 'gpt-5.5');
  assert.deepEqual(meta.enabledModels, ['gpt-5.5', 'claude-sonnet-5[1m]']);
  assert.equal(store.snapshot().provider.kind, 'scalemax');
  assert.equal(store.snapshot().provider.keyStorage, 'session');
});

test('save rejects a ScaleMax endpoint that is not official', async () => {
  const { provider } = makeProvider();
  await assert.rejects(
    () => provider.save({ kind: 'scalemax', baseUrl: 'https://evil.example.com/v1', model: 'm', apiKey: 'sm_live_test_key_1234567890' }),
    /official API URLs/,
  );
});

test('test() validates the models response shape', async () => {
  const { provider } = makeProvider({
    respond: () => jsonResponse({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }),
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-4o-mini' });
  const result = await provider.test();
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['gpt-4o-mini', 'gpt-4o']);
});
