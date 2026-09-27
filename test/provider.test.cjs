'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('../lib/provider.cjs');

function assertNoSharedObjects(root) {
  const seen = new Set();
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) throw new TypeError('State JSON cannot contain cycles or shared objects.');
    seen.add(value);
    for (const item of Object.values(value)) walk(item);
  };
  walk(root);
}

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    readAll: () => structuredClone(state),
    update(mutator) {
      const draft = structuredClone(state);
      const result = mutator(draft);
      state = result === undefined ? draft : result;
      // Like lib/state.cjs: one object stored under two keys is refused.
      assertNoSharedObjects(state);
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
  // No capabilities in the response: every capability is unknown (null).
  const unknown = { chat: null, tools: null, reasoning: null, effortLevels: [], defaultEffort: null, effortLocked: false, output: null, media: null };
  assert.deepEqual(result.models, [
    { id: 'gpt-5.5', displayName: 'GPT-5.5', available: true, ...unknown },
    { id: 'claude-sonnet-5[1m]', displayName: 'Claude Sonnet 5', available: false, ...unknown },
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

async function sendAndCapture(input) {
  const { provider, calls } = makeProvider({
    respond: () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  await provider.send({ requestId: 'req-t', messages: [{ role: 'user', content: 'Hi' }], ...input });
  return JSON.parse(calls[0].options.body);
}

test('send puts the system prompt first and forwards a numeric temperature', async () => {
  const body = await sendAndCapture({ systemPrompt: 'You are terse.', temperature: 0.7 });
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are terse.' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Hi' });
  assert.equal(typeof body.temperature, 'number');
  assert.equal(body.temperature, 0.7);
});

test('send forwards temperature 0 (falsy but valid)', async () => {
  const body = await sendAndCapture({ systemPrompt: 'S', temperature: 0 });
  assert.equal(body.temperature, 0);
});

test('send omits temperature when undefined so the provider default applies', async () => {
  const body = await sendAndCapture({ systemPrompt: 'S' });
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'S' });
});

test('send omits an empty system message', async () => {
  const body = await sendAndCapture({ systemPrompt: '   ' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
});

test('send rejects a string temperature', async () => {
  const { provider } = makeProvider({ respond: () => jsonResponse({}) });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
  await assert.rejects(
    () => provider.send({ requestId: 'r', messages: [{ role: 'user', content: 'Hi' }], temperature: '0.7' }),
    /Temperature must be a finite number/,
  );
});

const TOOL_ECHO = {
  type: 'function',
  function: {
    name: 'mcp_fake_echo',
    description: '[Fake] Echo text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
  },
};
const TOOL_ADD = {
  type: 'function',
  function: { name: 'mcp_fake_add', parameters: { type: 'object', properties: {} } },
};

async function configuredProvider(respond) {
  const setup = makeProvider({ respond });
  await setup.provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model' });
  return setup;
}

test('complete sends tools with tool_choice auto and parses tool calls', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({
    model: 'test-model-2026',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'mcp_fake_echo', arguments: '{"text":"hi"}' } },
          { id: 'call_2', type: 'function', function: { name: 'mcp_fake_add', arguments: { a: 1, b: 2 } } },
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
  const messages = [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'Hi' }];
  const result = await provider.complete({ requestId: 'c-1', messages, tools: [TOOL_ECHO, TOOL_ADD], temperature: 0 });
  assert.deepEqual(result, {
    content: null,
    toolCalls: [
      { id: 'call_1', name: 'mcp_fake_echo', arguments: '{"text":"hi"}' },
      { id: 'call_2', name: 'mcp_fake_add', arguments: '{"a":1,"b":2}' },
    ],
    model: 'test-model-2026',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    finishReason: 'tool_calls',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.tools, [TOOL_ECHO, TOOL_ADD]);
  assert.deepEqual(body.messages, messages);
});

test('complete forwards tool round-trips and omits tools when none are given', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The answer is 3.' } }],
  }));
  const messages = [
    { role: 'user', content: 'Add 1 and 2' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp_fake_add', arguments: '{"a":1,"b":2}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '3' },
  ];
  const result = await provider.complete({ requestId: 'c-2', messages });
  // Without a model in the response, the configured model is reported.
  assert.deepEqual(result, { content: 'The answer is 3.', toolCalls: [], model: 'test-model', finishReason: 'stop' });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.messages, messages);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.equal(Object.hasOwn(body, 'tool_choice'), false);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
});

test('complete fills in missing tool call ids and keeps at most 16 calls', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({
    choices: [{
      message: {
        content: 'Working on it.',
        tool_calls: Array.from({ length: 20 }, () => ({ function: { name: 'mcp_fake_echo', arguments: '{}' } })),
      },
    }],
  }));
  const result = await provider.complete({ requestId: 'c-3', messages: [{ role: 'user', content: 'Hi' }], tools: [TOOL_ECHO] });
  assert.equal(result.content, 'Working on it.');
  assert.equal(result.finishReason, null);
  assert.equal(result.toolCalls.length, 16);
  assert.equal(new Set(result.toolCalls.map((call) => call.id)).size, 16);
  for (const call of result.toolCalls) {
    assert.match(call.id, /^call_[0-9a-f]{32}$/);
    assert.equal(call.name, 'mcp_fake_echo');
    assert.equal(call.arguments, '{}');
  }
});

test('complete rejects invalid requests before calling the provider', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({}));
  const user = [{ role: 'user', content: 'Hi' }];
  const tool = (fn) => [{ type: 'function', function: { name: 'ok_name', parameters: {}, ...fn } }];
  const cases = [
    [{ requestId: '', messages: user }, /requestId/],
    [{ requestId: 'r', messages: [] }, /nonempty array/],
    [{ requestId: 'r', messages: [{ role: 'developer', content: 'x' }] }, /system, user, assistant, or tool roles/],
    [{ requestId: 'r', messages: [{ role: 'tool', content: 'x' }] }, /tool roles/],
    [{ requestId: 'r', messages: [{ role: 'assistant', content: null }] }, /tool roles/],
    [{ requestId: 'r', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] }, /at most 1 MB/],
    [{
      requestId: 'r',
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'code', function: { name: 'x', arguments: '{}' } }] }],
    }, /tool_calls must be/],
    [{ requestId: 'r', messages: user, tools: tool({ name: 'bad name' }) }, /name matching/],
    [{ requestId: 'r', messages: user, tools: tool({ description: 'd'.repeat(1025) }) }, /description of at most 1024/],
    [{ requestId: 'r', messages: user, tools: tool({ parameters: 'none' }) }, /object parameters/],
    [{ requestId: 'r', messages: user, tools: [...tool({}), ...tool({})] }, /unique/],
    [{ requestId: 'r', messages: user, tools: Array.from({ length: 129 }, (_, i) => tool({ name: `t${i}` })[0]) }, /at most 128/],
    [{ requestId: 'r', messages: user, temperature: 3 }, /Temperature must be/],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => provider.complete(input),
      (error) => error.name === 'ProviderError' && pattern.test(error.message),
      `expected ${pattern}`,
    );
  }
  assert.equal(calls.length, 0);
});

test('complete requires assistant text or tool calls in the response', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({
    choices: [{ message: { role: 'assistant', content: '   ', tool_calls: [] } }],
  }));
  await assert.rejects(
    () => provider.complete({ requestId: 'c-4', messages: [{ role: 'user', content: 'Hi' }] }),
    /did not contain assistant text or tool calls/,
  );
});

test('complete is cancellable through the shared requestId', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { provider } = await configuredProvider(async () => {
    await gate;
    return jsonResponse({ choices: [{ message: { content: 'late' } }] });
  });
  const pending = provider.complete({ requestId: 'c-5', messages: [{ role: 'user', content: 'Hi' }], tools: [TOOL_ECHO] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.cancel('c-5'), true);
  await assert.rejects(() => pending, (error) => error.code === 'CANCELLED' && /cancelled/.test(error.message));
  release();
});

// ---- Model capabilities, reasoning and model switching ----------------------------

// Shaped like the live ScaleMax /models response (2026-09-26).
const SCALEMAX_MODELS = {
  data: [
    {
      id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', availability: 'available',
      capabilities: { chat: true, tools: true, reasoning: true, tool_choice: false },
    },
    {
      id: 'claude-sonnet-4-6[1m]', display_name: 'Sonnet 4.6', availability: 'available',
      capabilities: { chat: true, tools: true, reasoning: true, effort: true, effort_levels: ['low'], default_effort: 'low', effort_locked: true },
    },
    { id: 'space-bunny', display_name: 'Space Bunny (Free)', availability: 'available', capabilities: { chat: true, tools: true } },
    { id: 'flux-2-pro', display_name: 'ScaleMax Image Flux', family: 'image', availability: 'available', capabilities: { image_generation: true } },
  ],
};

async function scalemaxProvider(respondChat) {
  const bodies = [];
  const { provider, store } = makeProvider({
    respond: (url, options) => {
      if (url.endsWith('/models')) return jsonResponse(SCALEMAX_MODELS);
      bodies.push(JSON.parse(options.body));
      return jsonResponse(respondChat ? respondChat() : { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  const found = await provider.discover({ kind: 'scalemax', apiKey: 'sm_live_test_key_1234567890' });
  await provider.save({
    kind: 'scalemax', baseUrl: found.baseUrl, model: 'deepseek-v4-flash', enabledModels: ['deepseek-v4-flash'],
    models: found.models, apiKey: 'sm_live_test_key_1234567890',
  });
  return { provider, store, bodies, found };
}

test('the catalog keeps chat, tools and reasoning capabilities', async () => {
  const { found } = await scalemaxProvider();
  const byId = Object.fromEntries(found.models.map((model) => [model.id, model]));
  assert.deepEqual(byId['deepseek-v4-flash'], {
    id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', available: true,
    chat: true, tools: true, reasoning: true, effortLevels: [], defaultEffort: null, effortLocked: false, output: null, media: null,
  });
  assert.deepEqual(byId['claude-sonnet-4-6[1m]'].effortLevels, ['low']);
  assert.equal(byId['claude-sonnet-4-6[1m]'].effortLocked, true);
  assert.equal(byId['claude-sonnet-4-6[1m]'].defaultEffort, 'low');
  assert.equal(byId['space-bunny'].reasoning, false);
  assert.equal(byId['flux-2-pro'].chat, false);
  assert.equal(byId['flux-2-pro'].output, 'image');
});

test('reasoning settings are sent only to reasoning models, adjusted to what they allow', async () => {
  const { provider, bodies } = await scalemaxProvider();
  const ask = (reasoning, id) => provider.send({ requestId: id, messages: [{ role: 'user', content: 'Hi' }], reasoning });
  await ask({ thinking: true, effort: 'high' }, 'a');
  await ask({ thinking: false, effort: 'high' }, 'b');
  await ask(undefined, 'c');
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.equal('thinking' in bodies[2], false);

  // Sonnet's effort is locked at low; a model without reasoning gets no fields at all.
  await provider.setModel({ model: 'claude-sonnet-4-6[1m]' });
  await ask({ thinking: true, effort: 'high' }, 'd');
  assert.equal(bodies[3].model, 'claude-sonnet-4-6[1m]');
  assert.equal(bodies[3].reasoning_effort, 'low');
  await provider.setModel({ model: 'space-bunny' });
  await ask({ thinking: true, effort: 'high' }, 'e');
  assert.equal('thinking' in bodies[4] || 'reasoning_effort' in bodies[4], false);

  // complete() (the tool loop) applies the same rules.
  await provider.setModel({ model: 'deepseek-v4-flash' });
  await provider.complete({ requestId: 'f', messages: [{ role: 'user', content: 'Hi' }], reasoning: { thinking: true, effort: 'low' } });
  assert.equal(bodies[5].reasoning_effort, 'low');

  await assert.rejects(() => ask({ thinking: 'yes' }, 'g'), /Reasoning must be/);
  await assert.rejects(() => ask({ thinking: true, effort: 'max' }, 'h'), /Reasoning must be/);
});

test('thinking text in the response is returned next to the answer', async () => {
  const { provider } = await scalemaxProvider(() => ({
    choices: [{ message: { role: 'assistant', content: '391', reasoning_content: '17 × 23 = 391' } }],
  }));
  const result = await provider.send({ requestId: 'r', messages: [{ role: 'user', content: '17*23?' }] });
  assert.equal(result.text, '391');
  assert.equal(result.reasoning, '17 × 23 = 391');
});

test('setModel switches the chat model, enables it, and refuses non-chat or unknown models', async () => {
  const { provider, store } = await scalemaxProvider();
  const meta = await provider.setModel({ model: 'space-bunny' });
  assert.equal(meta.model, 'space-bunny');
  assert.deepEqual(meta.enabledModels, ['deepseek-v4-flash', 'space-bunny']);
  assert.equal(store.snapshot().provider.model, 'space-bunny');
  assert.equal(meta.hasKey, true);
  await assert.rejects(() => provider.setModel({ model: 'flux-2-pro' }), /does not support chat/);
  await assert.rejects(() => provider.setModel({ model: 'gpt-nope' }), /not in the ScaleMax model list/);
  await assert.rejects(() => provider.setModel({}), /Choose a model/);
});

test('refreshModels reloads capabilities with the stored key', async () => {
  const { provider, store, calls } = makeProvider({ respond: () => jsonResponse(SCALEMAX_MODELS) });
  await provider.save({
    kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/v1', model: 'deepseek-v4-flash',
    enabledModels: ['deepseek-v4-flash', 'retired-model'],
    models: [{ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', available: true }],
    apiKey: 'sm_live_test_key_1234567890',
  });
  const meta = await provider.refreshModels();
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sm_live_test_key_1234567890');
  assert.equal(meta.models.find((model) => model.id === 'deepseek-v4-flash').reasoning, true);
  assert.deepEqual(meta.enabledModels, ['deepseek-v4-flash']);
  assert.equal(store.snapshot().provider.models.length, 4);
});

// ---- Media capabilities, provider profiles, media fetch ------------------------------

// Shaped like the live ScaleMax /models entries for media models (2026-09-27).
const MEDIA_MODELS = {
  data: [
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', capabilities: { chat: true, tools: true, reasoning: true } },
    {
      id: 'gpt-image-2', display_name: 'ScaleMax Image 2', family: 'image',
      capabilities: { image_generation: true, sizes: ['1024x1024', '1536x864', '864x1536'], quality: ['low', 'medium', 'high'], max_images_per_request: 1 },
      pricing: { credit_usd_per_image_min: 0.012, credit_usd_per_image_max: 0.422 },
    },
    {
      id: 'qwen-image-3.0-pro', display_name: 'Qwen Image 3.0 Pro', family: 'image',
      capabilities: { image_generation: true, sizes: ['1024x1024', '<script>'], quality: ['low'], max_images_per_request: 4 },
      pricing: { credit_usd_per_image_min: 0.2, credit_usd_per_image_max: 0.2 },
    },
    {
      id: 'grok-imagine-video', display_name: 'Grok Imagine Video', family: 'video',
      capabilities: {
        video_generation: true, aspect_ratios: ['1:1', '16:9'], resolutions: ['480p', '720p'],
        supports_t2v: true, supports_i2v: true, requires_image: false, supports_edit: true, supports_extend: false,
      },
      pricing: { credit_usd_per_second: { '480p': 0.046667, '720p': 0.066667 }, discount_percent: 20, reference_duration_seconds: 6 },
    },
  ],
};

test('media models keep their generation options and prices', async () => {
  const { provider } = makeProvider({ respond: () => jsonResponse(MEDIA_MODELS) });
  const { models } = await provider.discover({ kind: 'scalemax', apiKey: 'sm_live_test_key_1234567890' });
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(byId['deepseek-v4-flash'].media, null);
  assert.deepEqual(byId['gpt-image-2'].media, {
    kind: 'image', sizes: ['1024x1024', '1536x864', '864x1536'], qualities: ['low', 'medium', 'high'],
    maxImages: 1, edit: true, pricing: { min: 0.012, max: 0.422 },
  });
  // Unsafe option values are dropped; editing is only claimed where the API supports it.
  assert.deepEqual(byId['qwen-image-3.0-pro'].media.sizes, ['1024x1024']);
  assert.equal(byId['qwen-image-3.0-pro'].media.edit, false);
  assert.equal(byId['qwen-image-3.0-pro'].media.maxImages, 4);
  assert.deepEqual(byId['grok-imagine-video'].media, {
    kind: 'video', aspectRatios: ['1:1', '16:9'], resolutions: ['480p', '720p'], textToVideo: true, imageToVideo: true,
    requiresImage: false, edit: true, extend: false, durationMin: 1, durationMax: 15, defaultDuration: 6,
    pricing: { perSecond: { '480p': 0.046667, '720p': 0.066667 }, discountPercent: 20 },
  });
});

function profileProvider() {
  const store = memoryStore();
  const { provider, calls } = makeProvider({
    store,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`),
      decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
    },
    respond: (url, options) => jsonResponse({ url, auth: options.headers?.Authorization || null, choices: [{ message: { content: 'ok' } }] }),
  });
  return { provider, store, calls };
}

test('several providers can be saved, switched and removed; each keeps its own key and model', async () => {
  const { provider, store, calls } = profileProvider();
  await provider.save({ kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/v1', model: 'deepseek-v4-flash', apiKey: 'sm_live_first_key_1234567890' });
  let listing = provider.profiles();
  assert.equal(listing.profiles.length, 1);
  assert.equal(listing.profiles[0].name, 'ScaleMax');
  assert.equal(provider.get().profileName, 'ScaleMax');

  listing = await provider.addProfile({ name: 'Local Ollama' });
  assert.equal(listing.profiles.length, 2);
  const localId = listing.activeId;
  assert.equal(provider.get().configured, false);
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  assert.equal(provider.get().model, 'llama3');

  // The inactive ScaleMax profile keeps its encrypted key and model; nothing is decrypted to list it.
  listing = provider.profiles();
  const scalemax = listing.profiles.find((profile) => profile.id !== localId);
  assert.deepEqual([scalemax.active, scalemax.model, scalemax.hasKey, scalemax.configured], [false, 'deepseek-v4-flash', true, true]);
  assert.equal(JSON.stringify(listing).includes('sm_live_first_key'), false);

  // Switching loads that provider's key again: the next request carries it.
  await provider.selectProfile({ id: scalemax.id });
  assert.equal(provider.get().model, 'deepseek-v4-flash');
  await provider.send({ requestId: 'r1', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sm_live_first_key_1234567890');
  await provider.selectProfile({ id: localId });
  await provider.send({ requestId: 'r2', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);

  listing = await provider.renameProfile({ id: localId, name: '  Ollama  ' });
  assert.equal(listing.profiles.find((profile) => profile.id === localId).name, 'Ollama');
  // Removing the active provider switches to the remaining one; the last cannot be removed.
  listing = await provider.removeProfile({ id: localId });
  assert.equal(listing.profiles.length, 1);
  assert.equal(provider.get().model, 'deepseek-v4-flash');
  await assert.rejects(() => provider.removeProfile({ id: listing.activeId }), /last provider cannot be removed/);
  assert.equal(JSON.stringify(store.snapshot()).includes('sm_live_first_key'), false);
});

test('mediaFetch sends the key only to the provider origin and refuses plain http elsewhere', async () => {
  const { provider, calls } = profileProvider();
  await provider.save({ kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/v1', model: 'deepseek-v4-flash', apiKey: 'sm_live_first_key_1234567890' });
  await provider.mediaFetch('images/generations', { method: 'POST', body: '{}' });
  assert.equal(calls.at(-1).url, 'https://api.scalemax.pro/v1/images/generations');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sm_live_first_key_1234567890');
  assert.equal(calls.at(-1).options.redirect, 'manual');
  await provider.mediaFetch('https://cdn.example.com/image.png');
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  assert.throws(() => provider.mediaFetch('http://cdn.example.com/image.png'), /non-HTTPS/);
  assert.equal(provider.redact('error for sm_live_first_key_1234567890'), 'error for [redacted]');
});
