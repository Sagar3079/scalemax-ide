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
    // Retries wait a few milliseconds here, not seconds.
    retryDelays: overrides.retryDelays || [1, 1, 1],
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

test('complete requires assistant text or tool calls in the response, asking once more first', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({
    choices: [{ message: { role: 'assistant', content: '   ', tool_calls: [] } }],
  }));
  await assert.rejects(
    () => provider.complete({ requestId: 'c-4', messages: [{ role: 'user', content: 'Hi' }] }),
    /did not contain assistant text or tool calls/,
  );
  assert.equal(calls.length, 2, 'the empty reply and one more try');
});

test('a streamed reply that only thought is asked again; both attempts count toward usage', async () => {
  const usage = (tokens) => ({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: 10 + tokens } });
  const answers = [
    () => sseResponse([chunk({ reasoning_content: 'Hmm.' }), chunk({}, { finish_reason: 'stop' }), usage(30), '[DONE]']),
    () => sseResponse([chunk({ content: 'Answer.' }, { finish_reason: 'stop' }), usage(4), '[DONE]']),
  ];
  const { provider, calls } = await configuredProvider(() => answers.shift()());
  const heard = [];
  const result = await provider.complete({ requestId: 'e-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => heard.push(delta) });
  assert.equal(result.content, 'Answer.');
  assert.equal(calls.length, 2);
  assert.deepEqual(heard.map((delta) => delta.type), ['reasoning', 'retry', 'text']);
  assert.equal(heard[1].reason, 'EMPTY');
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 34, total_tokens: 54 });
});

test('a model that answers only in its thinking twice gets a clear error', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning_content: 'one, two, three' } }],
  }));
  await assert.rejects(
    () => provider.complete({ requestId: 'e-2', messages: [{ role: 'user', content: 'Count' }] }),
    (error) => error.code === 'EMPTY_REPLY' && /wrote only its thinking/.test(error.message),
  );
  assert.equal(calls.length, 2);
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
// ---- Streaming (Server-Sent Events) -------------------------------------------------------
function sseResponse(events, { chunkSize = 0, close = true, headers = {} } = {}) {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  const bytes = Buffer.from(text, 'utf8');
  const size = chunkSize || bytes.length || 1;
  const body = new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size) controller.enqueue(new Uint8Array(bytes.subarray(index, index + size)));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers } });
}
const chunk = (delta, extra = {}) => ({ object: 'chat.completion.chunk', model: 'test-model-2026', choices: [{ index: 0, delta, ...extra }] });
test('complete streams text, reasoning and tool calls when a listener is given', async () => {
  const { provider, calls } = await configuredProvider(() => sseResponse([
    chunk({ role: 'assistant', reasoning_content: 'Let me ' }),
    chunk({ reasoning_content: 'look.' }),
    chunk({ content: 'Checking ' }),
    chunk({ content: 'the files — ünïcode ok.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'mcp_fake_echo', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'mcp_fake_add', arguments: '{}' } }] }),
    chunk({}, { finish_reason: 'tool_calls' }),
    { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
    '[DONE]',
  ], { chunkSize: 7 }));
  const deltas = [];
  const result = await provider.complete({ requestId: 's-1', messages: [{ role: 'user', content: 'Hi' }], tools: [TOOL_ECHO, TOOL_ADD] },
    { onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(result, {
    content: 'Checking the files — ünïcode ok.',
    toolCalls: [
      { id: 'call_a', name: 'mcp_fake_echo', arguments: '{"text":"hi"}' },
      { id: 'call_b', name: 'mcp_fake_add', arguments: '{}' },
    ],
    model: 'test-model-2026',
    reasoning: 'Let me look.',
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    finishReason: 'tool_calls',
  });
  assert.deepEqual(deltas, [
    { type: 'reasoning', text: 'Let me ' },
    { type: 'reasoning', text: 'look.' },
    { type: 'text', text: 'Checking ' },
    { type: 'text', text: 'the files — ünïcode ok.' },
    { type: 'tool', index: 0, name: 'mcp_fake_echo' },
    { type: 'tool', index: 1, name: 'mcp_fake_add' },
  ]);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.match(calls[0].options.headers.Accept, /text\/event-stream/);
});
test('a streamed reply split into single bytes and CRLF lines reads the same', async () => {
  const events = [chunk({ content: 'Grüße ' }), chunk({ content: 'aus Köln' }, { finish_reason: 'stop' }), '[DONE]'];
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = Buffer.from(`: keep-alive\r\n\r\nevent: message\r\n${text}`, 'utf8');
  const { provider } = await configuredProvider(() => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const pieces = [];
  const result = await provider.complete({ requestId: 's-2', messages: [{ role: 'user', content: 'Hi' }] },
    { onDelta: (delta) => pieces.push(delta.text) });
  assert.equal(result.content, 'Grüße aus Köln');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(pieces, ['Grüße ', 'aus Köln']);
});
test('a server that ignores stream answers with JSON, told to the listener in one piece', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({
    model: 'test-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'All at once.' } }],
  }));
  const deltas = [];
  const result = await provider.complete({ requestId: 's-3', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => deltas.push(delta) });
  assert.equal(result.content, 'All at once.');
  assert.deepEqual(deltas, [{ type: 'text', text: 'All at once.' }]);
});
test('a stream refused with HTTP 400 about streaming is asked once more without streaming', async () => {
  const { provider, calls } = await configuredProvider((url, options) => {
    const body = JSON.parse(options.body);
    if (body.stream) {
      return jsonResponse({ error: { message: 'Unrecognized request argument supplied: stream_options', code: 'invalid_request' } }, { status: 400 });
    }
    return jsonResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Fine without.' } }] });
  });
  const deltas = [];
  const result = await provider.complete({ requestId: 's-4', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => deltas.push(delta) });
  assert.equal(result.content, 'Fine without.');
  assert.deepEqual(deltas, [{ type: 'text', text: 'Fine without.' }]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).stream, false);
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), 'stream_options'), false);
});
test('other refusals are not retried and carry the provider message, status and code', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({
    error: { message: 'This model does not accept images.\nUse another model.', code: 'image_input_unsupported' },
  }, { status: 400 }));
  await assert.rejects(
    () => provider.complete({ requestId: 's-5', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    // No picture was sent, so this is not taken for a picture refusal.
    (error) => error.status === 400 && error.providerCode === 'image_input_unsupported' && error.code === 'PROVIDER_ERROR'
      && error.message === 'The provider refused the request (HTTP 400): This model does not accept images. Use another model.',
  );
  assert.equal(calls.length, 1);
});

test('a picture refusal is told apart by its code or its words; other 400s are not', async () => {
  const picture = [{ role: 'user', content: [{ type: 'text', text: 'Which color?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }];
  const text = [{ role: 'user', content: 'Hi' }];
  const cases = [
    [{ message: "deepseek-v4-flash can't read images. Use a model with image input.", code: 'image_input_unsupported' }, picture, 'IMAGES_UNSUPPORTED'],
    [{ message: 'Image input is not supported for this model' }, picture, 'IMAGES_UNSUPPORTED'],
    [{ message: 'image_url is only supported by certain models.' }, picture, 'IMAGES_UNSUPPORTED'],
    [{ message: 'Failed to deserialize the JSON body: unknown variant `image_url`, expected `text`' }, picture, 'IMAGES_UNSUPPORTED'],
    // A picture that is too big or broken, and refusals of requests without pictures, are not.
    [{ message: 'Image too large: exceeds 5 MB', code: 'image_too_large' }, picture, 'PROVIDER_ERROR'],
    [{ message: 'Invalid image format: could not decode' }, picture, 'PROVIDER_ERROR'],
    [{ message: "smoke can't read images.", code: 'image_input_unsupported' }, text, 'PROVIDER_ERROR'],
    [{ message: 'messages must not be empty', code: 'invalid_request' }, picture, 'PROVIDER_ERROR'],
  ];
  for (const [error, messages, code] of cases) {
    const { provider } = await configuredProvider(() => jsonResponse({ error }, { status: 400 }));
    await assert.rejects(() => provider.complete({ requestId: 'img-1', messages }),
      (thrown) => thrown.code === code, `${error.message} -> ${code}`);
  }
});
test('provider error details never contain the API key and HTML pages are not shown', async () => {
  const key = 'sk-secret-streaming-key-123456';
  let reply = () => jsonResponse({ error: { message: `Bad key ${key} for model` } }, { status: 500 });
  const { provider } = makeProvider({ respond: () => reply() });
  await provider.save({ baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: key });
  await assert.rejects(() => provider.complete({ requestId: 's-6', messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error.status === 500 && !error.message.includes(key) && error.message.includes('[redacted]'));
  reply = () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => provider.complete({ requestId: 's-7', messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error.message === 'Provider request failed with an unsuccessful HTTP status (502).');
});
test('an error event inside the stream stops the reply with the provider message', async () => {
  const { provider } = await configuredProvider(() => sseResponse([
    chunk({ content: 'Part' }),
    { error: { message: 'upstream overloaded' } },
  ]));
  await assert.rejects(() => provider.complete({ requestId: 's-8', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    /The provider stopped the reply: upstream overloaded/);
});
test('cancelling a streamed reply stops it at once', async () => {
  const { provider } = await configuredProvider(() => sseResponse([chunk({ content: 'Still ' })], { close: false }));
  let heard = null;
  const first = new Promise((resolve) => { heard = resolve; });
  const pending = provider.complete({ requestId: 's-9', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => heard(delta) });
  assert.deepEqual(await first, { type: 'text', text: 'Still ' });
  assert.equal(provider.cancel('s-9'), true);
  await assert.rejects(() => pending, (error) => error.code === 'CANCELLED');
});
test('a stream that ends without [DONE] keeps what arrived, and listener errors never break it', async () => {
  const { provider } = await configuredProvider(() => sseResponse([chunk({ content: 'Done anyway.' }, { finish_reason: 'stop' })]));
  const result = await provider.complete({ requestId: 's-10', messages: [{ role: 'user', content: 'Hi' }] }, {
    onDelta: () => { throw new Error('listener broke'); },
  });
  assert.equal(result.content, 'Done anyway.');
});
test('up to eight requests may be in flight at once', async () => {
  const { provider } = await configuredProvider(() => sseResponse([], { close: false }));
  const pending = Array.from({ length: 8 }, (_, index) => provider.complete({ requestId: `p-${index}`, messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(() => provider.complete({ requestId: 'p-9', messages: [{ role: 'user', content: 'Hi' }] }), /At most 8 provider requests/);
  assert.equal(provider.cancelAll(), 8);
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every((item) => item.status === 'rejected' && item.reason.code === 'CANCELLED'));
});
test('stream error events are shown without the API key', async () => {
  const key = 'sk-secret-stream-error-key-123456';
  let reply = () => sseResponse([chunk({ content: 'Part' }), { error: { message: `upstream rejected key ${key}\u202e` } }]);
  const { provider } = makeProvider({ respond: () => reply() });
  await provider.save({ baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: key });
  await assert.rejects(() => provider.complete({ requestId: 'e-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    (error) => !error.message.includes(key) && error.message === 'The provider stopped the reply: upstream rejected key [redacted]');
  // A 200 JSON body with an error (a server that ignored `stream`) never shows the key either.
  reply = () => jsonResponse({ error: { message: `invalid key ${key}` } });
  await assert.rejects(() => provider.complete({ requestId: 'e-2', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    (error) => !error.message.includes(key));
});
test('tool calls without index are kept apart, streamed or whole', async () => {
  // Pieces without index: a known id continues its call, a second name starts the next one.
  const { provider } = await configuredProvider(() => sseResponse([
    chunk({ tool_calls: [{ id: 'call_a', function: { name: 'mcp_fake_echo', arguments: '{"te' } }] }),
    chunk({ tool_calls: [{ id: 'call_a', function: { arguments: 'xt":"hi"}' } }] }),
    chunk({ tool_calls: [{ function: { name: 'mcp_fake_add', arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ function: { arguments: '1}' } }] }, { finish_reason: 'tool_calls' }),
    '[DONE]',
  ]));
  const streamed = await provider.complete({ requestId: 't-1', messages: [{ role: 'user', content: 'Hi' }], tools: [TOOL_ECHO, TOOL_ADD] }, { onDelta: () => {} });
  assert.deepEqual(streamed.toolCalls.map((call) => [call.id.startsWith('call_') ? 'id' : '', call.name, call.arguments]), [
    ['id', 'mcp_fake_echo', '{"text":"hi"}'],
    ['id', 'mcp_fake_add', '{"a":1}'],
  ]);
  assert.equal(streamed.toolCalls[0].id, 'call_a');
  // The whole-reply fallback is checked exactly like a non-streamed reply.
  const whole = await configuredProvider(() => jsonResponse({
    choices: [{ message: { content: null, tool_calls: [
      { function: { name: 'mcp_fake_echo', arguments: '{"x":1}' } },
      { function: { name: 'mcp_fake_add', arguments: '{"y":2}' } },
    ] } }],
  }));
  const result = await whole.provider.complete({ requestId: 't-2', messages: [{ role: 'user', content: 'Hi' }], tools: [TOOL_ECHO, TOOL_ADD] }, { onDelta: () => {} });
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.arguments]), [['mcp_fake_echo', '{"x":1}'], ['mcp_fake_add', '{"y":2}']]);
});
test('a stream cut off without [DONE] or a finish reason fails instead of passing as the answer', async () => {
  const { provider } = await configuredProvider(() => sseResponse([chunk({ content: 'Half an ans' })]));
  await assert.rejects(() => provider.complete({ requestId: 'x-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    /cut off before it finished/);
});
test('the stream body is cancelled when reading stops early', async () => {
  let cancelled = 0;
  const body = () => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'x' }))}\n\ndata: {not json}\n\n`));
    },
    cancel() { cancelled += 1; },
  });
  const { provider } = await configuredProvider(() => new Response(body(), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(() => provider.complete({ requestId: 'c-9', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    /unreadable stream event/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled, 1);
});


test('catalog keeps optional context and USD token pricing without inventing them for other models', async () => {
  const { provider } = makeProvider({
    respond: () => jsonResponse({ data: [
      {
        id: 'priced', display_name: 'Priced', context_window: 1_000_000, max_output_tokens: 8192,
        pricing: { input_per_million: 0.19, output_per_million: 0.51, currency: 'USD' },
        capabilities: { chat: true, tools: true },
      },
      { id: 'unknown', capabilities: { chat: true } },
    ] }),
  });
  const found = await provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' });
  const [priced, unknown] = found.models;
  assert.deepEqual(priced.pricing, { inputPerMillion: 0.19, outputPerMillion: 0.51, currency: 'USD' });
  assert.equal(priced.contextWindow, 1_000_000);
  assert.equal(priced.maxOutputTokens, 8192);
  assert.equal('pricing' in unknown, false);
  assert.equal('contextWindow' in unknown, false);
});

test('chat replies snapshot catalog pricing for later local accounting', async () => {
  const { provider } = makeProvider({
    respond: (_url, options) => {
      if (options.method === 'GET') return jsonResponse({ data: [{
        id: 'priced', context_window: 4096, max_output_tokens: 512,
        pricing: { input_per_million: 1, output_per_million: 2, currency: 'USD' }, capabilities: { chat: true },
      }] });
      return jsonResponse({ model: 'priced', choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    },
  });
  const found = await provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' });
  await provider.save({ kind: 'custom', baseUrl: found.baseUrl, model: 'priced', models: found.models });
  const result = await provider.send({ requestId: 'pricing-snapshot', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(result.pricing, { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' });
});


test('a request snapshot keeps later tool-loop rounds on the original model and price', async () => {
  const seenModels = [];
  const { provider } = makeProvider({
    respond: (_url, options) => {
      const body = JSON.parse(options.body);
      seenModels.push(body.model);
      return jsonResponse({ model: body.model, choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  await provider.save({
    kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'one',
    models: [
      { id: 'one', pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 } },
      { id: 'two', pricing: { currency: 'USD', inputPerMillion: 10, outputPerMillion: 20 } },
    ],
  });
  const frozen = provider.snapshot();
  await provider.setModel({ model: 'two' });
  const result = await provider.complete({ requestId: 'frozen-round', messages: [{ role: 'user', content: 'hi' }] }, { snapshot: frozen });
  assert.deepEqual(seenModels, ['one']);
  assert.equal(result.model, 'one');
  assert.deepEqual(result.pricing, { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 });
});


test('catalog preserves a valid small advertised maximum-output limit', async () => {
  const { provider } = makeProvider({
    respond: () => jsonResponse({ data: [{ id: 'small-output', context_window: 4096, max_output_tokens: 128, capabilities: { chat: true } }] }),
  });
  const found = await provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.equal(found.models[0].maxOutputTokens, 128);
});

// ---- Phase 7: retries, cached tokens, pictures, long conversations --------------------------

test('a passing failure (rate limit, overloaded server, cut stream, dropped connection) is retried', async () => {
  const answers = [
    () => new Response('', { status: 429, headers: { 'retry-after': '0' } }),
    () => jsonResponse({ error: { message: 'overloaded' } }, { status: 503 }),
    () => { throw new TypeError('fetch failed'); },
    () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Made it.' } }] }),
  ];
  const { provider, calls } = await configuredProvider(() => answers.shift()());
  const result = await provider.complete({ requestId: 'r-1', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(result.content, 'Made it.');
  assert.equal(calls.length, 4);
});

test('retries that never streamed anything are announced too, so the window can say it is retrying', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({ error: { message: 'busy' } }, { status: 500 }));
  const heard = [];
  await assert.rejects(() => provider.complete({ requestId: 'n-500', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => heard.push(delta) }),
    (error) => error.status === 500);
  assert.deepEqual(heard.map((delta) => [delta.type, delta.attempt, delta.of, delta.reset]), [['retry', 1, 3, false], ['retry', 2, 3, false], ['retry', 3, 3, false]]);
});

test('refusals are not retried, and retries give up after three', async () => {
  for (const [status, expected] of [[400, 1], [401, 1], [404, 1]]) {
    const { provider, calls } = await configuredProvider(() => jsonResponse({ error: { message: 'no' } }, { status }));
    await assert.rejects(() => provider.complete({ requestId: `n-${status}`, messages: [{ role: 'user', content: 'Hi' }] }));
    assert.equal(calls.length, expected, `HTTP ${status}`);
  }
  const { provider, calls } = await configuredProvider(() => jsonResponse({ error: { message: 'busy' } }, { status: 502 }));
  await assert.rejects(() => provider.complete({ requestId: 'n-502', messages: [{ role: 'user', content: 'Hi' }] }), (error) => error.status === 502);
  assert.equal(calls.length, 4, 'the first try and three retries');
});

test('a stream cut part way is asked again, and the listener is told to start the round over', async () => {
  const answers = [
    () => sseResponse([chunk({ content: 'Half an ans' })]),
    () => sseResponse([chunk({ content: 'The whole answer.' }, { finish_reason: 'stop' }), '[DONE]']),
  ];
  const { provider } = await configuredProvider(() => answers.shift()());
  const heard = [];
  const result = await provider.complete({ requestId: 'c-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => heard.push(delta) });
  assert.equal(result.content, 'The whole answer.');
  assert.deepEqual(heard.map((delta) => delta.type), ['text', 'retry', 'text']);
  assert.equal(heard[1].reason, 'CUT_OFF');
});

test('Stop while a retry waits ends it without another request', async () => {
  const { provider, calls } = makeProvider({ respond: () => jsonResponse({ error: { message: 'busy' } }, { status: 503 }), retryDelays: [5000, 5000, 5000] });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model' });
  const pending = provider.complete({ requestId: 'w-1', messages: [{ role: 'user', content: 'Hi' }] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(provider.cancel('w-1'), true);
  await assert.rejects(() => pending, (error) => error.code === 'CANCELLED');
  assert.equal(calls.length, 1);
});

test('a request waiting to be tried again keeps its id, so Stop still reaches it', async () => {
  const { provider, calls } = makeProvider({ respond: () => jsonResponse({ error: { message: 'busy' } }, { status: 503 }), retryDelays: [5000, 5000, 5000] });
  await provider.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model' });
  const pending = provider.complete({ requestId: 'w-2', messages: [{ role: 'user', content: 'Hi' }] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(() => provider.complete({ requestId: 'w-2', messages: [{ role: 'user', content: 'Again' }] }), /already in flight/);
  assert.equal(provider.cancel('w-2'), true);
  await assert.rejects(() => pending, (error) => error.code === 'CANCELLED');
  assert.equal(calls.length, 1);
});

test('prompt tokens served from the cache are reported', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    usage: { prompt_tokens: 1200, completion_tokens: 5, total_tokens: 1205, prompt_tokens_details: { cached_tokens: 1024 } },
  }));
  const result = await provider.complete({ requestId: 'k-1', messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(result.usage, { prompt_tokens: 1200, completion_tokens: 5, total_tokens: 1205, cached_tokens: 1024 });
});

test('a user message may carry pictures as data-URL image parts, nothing else', async () => {
  const { provider, calls } = await configuredProvider(() => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Red.' } }] }));
  const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
  await provider.complete({ requestId: 'i-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Which color?' }, picture] }] });
  assert.deepEqual(JSON.parse(calls[0].options.body).messages[0].content, [{ type: 'text', text: 'Which color?' }, picture]);
  for (const bad of [
    [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
    [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }],
    [{ type: 'input_audio', input_audio: {} }],
  ]) {
    await assert.rejects(() => provider.complete({ requestId: 'i-2', messages: [{ role: 'user', content: bad }] }), /pictures/);
  }
});

test('a long tool reply may send more than 500 messages', async () => {
  const { provider } = await configuredProvider(() => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
  const messages = Array.from({ length: 1200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
  const result = await provider.complete({ requestId: 'l-1', messages });
  assert.equal(result.content, 'ok');
});

test('thinking goes back with the tool calls only to models that ask for it', async () => {
  const bodies = [];
  const { provider } = makeProvider({
    respond: (url, options) => {
      if (url.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'think-back', capabilities: { chat: true, tools: true, reasoning: true, reasoning_replay: true } }, { id: 'plain', capabilities: { chat: true, tools: true } }] });
      }
      bodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    },
  });
  const discovered = await provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' });
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'think-back', models: discovered.models });
  const messages = [
    { role: 'user', content: 'Go' },
    { role: 'assistant', content: null, reasoning_content: 'I should list files.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
  ];
  await provider.complete({ requestId: 'rb-1', messages });
  assert.equal(bodies[0].messages[1].reasoning_content, 'I should list files.');
  await provider.setModel({ model: 'plain' });
  await provider.complete({ requestId: 'rb-2', messages });
  assert.equal('reasoning_content' in bodies[1].messages[1], false);
});

// ---- Stream error events, provider changes under running replies -----------------------------

test('an error event in the stream that names a passing failure is retried like the HTTP failure', async () => {
  const answers = [
    () => sseResponse([chunk({ content: 'Part' }), { error: { type: 'overloaded_error', message: 'Overloaded' } }]),
    () => sseResponse([{ error: { code: 429, message: 'slow down' } }]),
    () => sseResponse([{ error: { status: '503', message: 'busy' } }]),
    () => sseResponse([chunk({ content: 'The whole answer.' }, { finish_reason: 'stop' }), '[DONE]']),
  ];
  const { provider, calls } = await configuredProvider(() => answers.shift()());
  const heard = [];
  const result = await provider.complete({ requestId: 'se-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: (delta) => heard.push(delta) });
  assert.equal(result.content, 'The whole answer.');
  assert.equal(calls.length, 4);
  // Every retry is announced, as retry n of 3; only the first had shown text to take back.
  assert.deepEqual(heard.map((delta) => delta.type), ['text', 'retry', 'retry', 'retry', 'text']);
  assert.equal(heard[1].reason, 'NETWORK');
  assert.deepEqual(heard.slice(1, 4).map((delta) => [delta.attempt, delta.of, delta.reset]), [[1, 3, true], [2, 3, false], [3, 3, false]]);
  // A refusal in the stream keeps its code and type but is not asked again.
  const refusing = await configuredProvider(() => sseResponse([{ error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'too long' } }]));
  await assert.rejects(() => refusing.provider.complete({ requestId: 'se-2', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    (error) => error.code === 'PROVIDER_ERROR' && error.providerCode === 'context_length_exceeded' && error.status === undefined
      && error.message === 'The provider stopped the reply: too long');
  assert.equal(refusing.calls.length, 1);
});

/** Two custom HTTPS providers with keys; requests wait while `hold` is set. */
function heldProviders(options = {}) {
  let hold = null;
  const store = memoryStore();
  const { provider, calls } = makeProvider({
    store,
    retryDelays: options.retryDelays,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`),
      decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
    },
    respond: async (url, init) => {
      if (hold) await hold;
      return options.respond ? options.respond(url, init) : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    },
  });
  const holdRequests = () => {
    let release;
    hold = new Promise((resolve) => { release = resolve; });
    return () => { hold = null; release(); };
  };
  return { provider, calls, store, holdRequests };
}
const A = { kind: 'custom', baseUrl: 'https://a.example/v1', model: 'a-1', apiKey: 'sk-provider-a-key-1234567890' };
const B = { kind: 'custom', baseUrl: 'https://b.example/v1', model: 'b-1', apiKey: 'sk-provider-b-key-1234567890' };
const ask = (provider, requestId, snapshot) => provider.complete({ requestId, messages: [{ role: 'user', content: 'Hi' }] }, { snapshot });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('switching provider or model leaves running replies alone; their snapshot keeps its key', async () => {
  const { provider, calls, holdRequests } = heldProviders();
  await provider.save(A);
  const frozen = provider.snapshot();
  const release = holdRequests();
  const running = ask(provider, 'keep-1', frozen);
  await tick();
  await provider.save({ kind: 'custom', baseUrl: A.baseUrl, model: 'a-2' });
  await provider.setModel({ model: 'a-3' });
  await provider.addProfile({ name: 'B' });
  await provider.save(B);
  release();
  assert.equal((await running).content, 'ok');
  // A later round of that reply still goes to the first provider, with its key and model.
  await ask(provider, 'keep-2', frozen);
  assert.equal(calls.at(-1).url, 'https://a.example/v1/chat/completions');
  assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${A.apiKey}`);
  assert.equal(JSON.parse(calls.at(-1).options.body).model, 'a-1');
});

test('removing or clearing a provider, or replacing its key, stops the replies using it', async () => {
  const { provider, calls, holdRequests } = heldProviders();
  await provider.save(A);
  const idA = provider.get().profileId;
  const frozenA = provider.snapshot();
  let release = holdRequests();
  const onA = ask(provider, 'gone-1', frozenA);
  await provider.addProfile({ name: 'B' });
  await provider.save(B);
  const frozenB = provider.snapshot();
  const onB = ask(provider, 'stay-1', frozenB);
  await tick();
  // Removing the (now inactive) first provider stops its reply, not the other provider's.
  await provider.removeProfile({ id: idA });
  await assert.rejects(() => onA, (error) => error.code === 'PROVIDER_CHANGED');
  release();
  assert.equal((await onB).content, 'ok');
  // Its next round never goes out with the removed key.
  const sent = calls.length;
  await assert.rejects(() => ask(provider, 'gone-2', frozenA), (error) => error.code === 'PROVIDER_CHANGED');
  assert.equal(calls.length, sent);
  // A new key for the active provider: replies on the old key stop, new ones use the new key.
  release = holdRequests();
  const oldKey = ask(provider, 'gone-3', frozenB);
  await tick();
  await provider.save({ ...B, apiKey: 'sk-provider-b-new-key-1234567890' });
  await assert.rejects(() => oldKey, (error) => error.code === 'PROVIDER_CHANGED');
  release();
  await assert.rejects(() => ask(provider, 'gone-4', frozenB), (error) => error.code === 'PROVIDER_CHANGED');
  const fresh = provider.snapshot();
  await ask(provider, 'new-1', fresh);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk-provider-b-new-key-1234567890');
  // Clearing: in flight or later, nothing more goes out with that key.
  release = holdRequests();
  const cleared = ask(provider, 'gone-5', fresh);
  await tick();
  provider.clear();
  await assert.rejects(() => cleared, (error) => error.code === 'PROVIDER_CHANGED' && /Send the message again/.test(error.message));
  release();
  await assert.rejects(() => ask(provider, 'gone-6', fresh), (error) => error.code === 'PROVIDER_CHANGED');
});

test('clearing a provider ends a request waiting to be retried at once', async () => {
  const { provider, calls } = heldProviders({ retryDelays: [5000, 5000, 5000], respond: () => jsonResponse({ error: { message: 'busy' } }, { status: 503 }) });
  await provider.save(A);
  const pending = ask(provider, 'wait-1', provider.snapshot());
  await tick();
  provider.clear();
  await assert.rejects(() => pending, (error) => error.code === 'PROVIDER_CHANGED');
  assert.equal(calls.length, 1);
});

test('choosing a provider with a model it cannot use changes nothing', async () => {
  const { provider } = await scalemaxProvider();
  const scalemaxId = provider.get().profileId;
  await provider.addProfile({ name: 'Local' });
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  const localId = provider.get().profileId;
  await assert.rejects(() => provider.selectProfile({ id: scalemaxId, model: 'flux-2-pro' }), /does not support chat/);
  await assert.rejects(() => provider.selectProfile({ id: scalemaxId, model: 'gpt-nope' }), /not in the ScaleMax model list/);
  assert.deepEqual([provider.get().profileId, provider.get().model], [localId, 'llama3']);
  // A model it can use: switched and chosen in one step.
  const listing = await provider.selectProfile({ id: scalemaxId, model: 'space-bunny' });
  assert.equal(listing.activeId, scalemaxId);
  assert.equal(provider.get().model, 'space-bunny');
  assert.deepEqual(provider.get().enabledModels, ['deepseek-v4-flash', 'space-bunny']);
  // Its current model needs no check; a model for the active provider is checked the same way.
  await provider.selectProfile({ id: scalemaxId, model: 'space-bunny' });
  await assert.rejects(() => provider.selectProfile({ id: scalemaxId, model: 'flux-2-pro' }), /does not support chat/);
  assert.equal(provider.get().model, 'space-bunny');
});

// ---- Connection failures name the endpoint and the cause (UX: "Provider request failed" said nothing) ----

/** What fetch() throws for a failed connection: TypeError('fetch failed') with the system error as cause. */
function fetchFailed(code, { aggregate = false } = {}) {
  const system = Object.assign(new Error(`connect ${code}`), { code });
  const cause = aggregate ? Object.assign(new AggregateError([system, system], ''), { code }) : system;
  return new TypeError('fetch failed', { cause });
}

test('a failed connection says which endpoint and why, with one hint, and never shows the key', async () => {
  const key = 'sk-test-local-secret-1234567890';
  const cases = [
    ['ECONNREFUSED', 'http://127.0.0.1:47399/v1', "Couldn't reach http://127.0.0.1:47399/v1 — nothing is listening there. Is the server running?", 'NETWORK'],
    ['ENOTFOUND', 'https://api.example.test/v1', "Couldn't find api.example.test. Check the address in the base URL, or your internet connection.", 'NETWORK'],
    ['EAI_AGAIN', 'https://api.example.test/v1', "Couldn't look up api.example.test right now. Check your internet connection.", 'NETWORK'],
    ['UND_ERR_CONNECT_TIMEOUT', 'https://slow.example.test/v1', "slow.example.test didn't answer within 10 s. Check that the server is up and reachable.", 'TIMEOUT'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'https://box.local:8443/v1', /^box\.local:8443's certificate isn't trusted \(self-signed or from an unknown issuer\)\. /, 'TLS'],
    ['CERT_HAS_EXPIRED', 'https://old.example.test/v1', "old.example.test's certificate has expired. Renew it on the server, then test again.", 'TLS'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'https://wrong.example.test/v1', "wrong.example.test's certificate is for a different name. Check the address in the base URL.", 'TLS'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'https://127.0.0.1:47301/v1', /didn't answer over HTTPS .*use http:\/\/ instead\.$/, 'TLS'],
    ['ECONNRESET', 'https://api.example.test/v1', "api.example.test closed the connection without answering. Try again in a moment.", 'NETWORK'],
    ['EHOSTUNREACH', 'https://10.0.0.9/v1', /^Couldn't reach 10\.0\.0\.9 — there is no network route to it\./, 'NETWORK'],
    ['EWHATEVER', 'https://api.example.test/v1', "Couldn't reach https://api.example.test/v1 (EWHATEVER). Check the base URL and your connection.", 'NETWORK'],
  ];
  for (const [code, baseUrl, message, kind] of cases) {
    const { provider } = makeProvider({ respond: () => { throw fetchFailed(code); } });
    await assert.rejects(() => provider.discover({ kind: 'custom', baseUrl, apiKey: key }), (error) => {
      if (typeof message === 'string') assert.equal(error.message, message, code);
      else assert.match(error.message, message, code);
      assert.equal(error.code, kind, code);
      assert.equal(error.network, code);
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
  // localhost tries ::1 and 127.0.0.1: an AggregateError that carries the shared code.
  const { provider } = makeProvider({ respond: () => { throw fetchFailed('ECONNREFUSED', { aggregate: true }); } });
  await assert.rejects(() => provider.discover({ kind: 'custom', baseUrl: 'http://localhost:47399/v1' }),
    { message: "Couldn't reach http://localhost:47399/v1 — nothing is listening there. Is the server running?" });
  // An error without any system code still names the endpoint.
  const bare = makeProvider({ respond: () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => bare.provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:47399/v1' }),
    { message: "Couldn't reach http://127.0.0.1:47399/v1. Check the base URL and your connection.", code: 'NETWORK' });
});

test('chat replies keep retrying a refused connection and end on the specific message; certificate errors are not retried', async () => {
  const refused = await configuredProvider(() => { throw fetchFailed('ECONNREFUSED'); });
  await assert.rejects(() => refused.provider.complete({ requestId: 'nc-1', messages: [{ role: 'user', content: 'Hi' }] }),
    { message: "Couldn't reach http://127.0.0.1:11434/v1 — nothing is listening there. Is the server running?", code: 'NETWORK' });
  assert.equal(refused.calls.length, 4, 'the first try and three retries');
  const reset = await configuredProvider(() => { throw fetchFailed('ECONNRESET'); });
  await assert.rejects(() => reset.provider.send({ requestId: 'nc-2', messages: [{ role: 'user', content: 'Hi' }] }), { code: 'NETWORK' });
  assert.equal(reset.calls.length, 4);
  const tls = await configuredProvider(() => { throw fetchFailed('CERT_HAS_EXPIRED'); });
  await assert.rejects(() => tls.provider.complete({ requestId: 'nc-3', messages: [{ role: 'user', content: 'Hi' }] }), { code: 'TLS' });
  assert.equal(tls.calls.length, 1, 'a certificate problem does not pass in seconds');
});

test('a connection lost after the reply began says the reply was cut short', async () => {
  const lost = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"Hal"}}]}\n\n'));
      controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { provider, calls } = await configuredProvider(lost);
  await assert.rejects(() => provider.complete({ requestId: 'cut-1', messages: [{ role: 'user', content: 'Hi' }] }, { onDelta: () => {} }),
    { message: '127.0.0.1:11434 closed the connection before the reply finished. Try again in a moment.', code: 'NETWORK' });
  assert.equal(calls.length, 4);
});

test('ScaleMax that cannot be reached at all says why, naming its host', async () => {
  const { provider } = makeProvider({ respond: () => { throw fetchFailed('ENOTFOUND'); } });
  await assert.rejects(() => provider.discover({ kind: 'scalemax', apiKey: 'sm_live_test_key_1234567890' }),
    { message: "Couldn't find api.scalemax.pro. Check the address in the base URL, or your internet connection.", network: 'ENOTFOUND' });
});

test('the catalog shows the name an endpoint gives a model (display_name, else name), else its id', async () => {
  const { provider } = makeProvider({
    respond: () => jsonResponse({ object: 'list', data: [
      { id: 'stub-coder-large', name: 'Stub Coder Large' },
      { id: 'both', display_name: 'Display Name', name: 'Plain Name' },
      { id: 'plain-id' },
      { id: 'bad-name', name: 'Bad\nName' },
    ] }),
  });
  const found = await provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:47301/v1' });
  assert.deepEqual(found.models.map((model) => model.displayName), ['Stub Coder Large', 'Display Name', 'plain-id', 'bad-name']);
});

test('a saved custom endpoint is named after its host, never "ScaleMax"; a name the user gave stays', async () => {
  const { provider } = profileProvider();
  // The first provider starts as "ScaleMax"; saving a custom endpoint in it names it after the host.
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:47301/v1', model: 'stub-coder-large' });
  assert.equal(provider.get().profileName, '127.0.0.1:47301');
  assert.equal(provider.profiles().profiles[0].name, '127.0.0.1:47301');
  // Another endpoint in the same provider: the automatic name follows it.
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', model: 'llama3' });
  assert.equal(provider.get().profileName, '127.0.0.1:8080');
  // Back to ScaleMax: "ScaleMax" again.
  await provider.save({ kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/v1', model: 'deepseek-v4-flash', apiKey: 'sm_live_first_key_1234567890' });
  assert.equal(provider.get().profileName, 'ScaleMax');
  // "Provider 2" from Add provider becomes the host when it is saved.
  await provider.addProfile({});
  assert.equal(provider.get().profileName, 'Provider 2');
  await provider.save({ kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test-local-key-123' });
  assert.equal(provider.get().profileName, 'api.openai.com');
  // A name the user typed is never replaced, whether given on Add or by renaming.
  await provider.addProfile({ name: 'Local Ollama' });
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  assert.equal(provider.get().profileName, 'Local Ollama');
  const openai = provider.profiles().profiles.find((profile) => profile.name === 'api.openai.com');
  await provider.selectProfile({ id: openai.id });
  await provider.renameProfile({ id: openai.id, name: 'ScaleMax' });
  await provider.save({ kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-test-local-key-123' });
  assert.equal(provider.get().profileName, 'ScaleMax', 'the user chose this name, even if it reads like the default');
});

test('choosing a model of a provider that is not saved yet says to save it in Assistant', async () => {
  const { provider } = profileProvider();
  await assert.rejects(() => provider.setModel({ model: 'stub-coder-large' }),
    { message: 'Save "ScaleMax" in Assistant first, then choose its model here.' });
  await provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:47301/v1', model: 'stub-coder-large' });
  const savedId = provider.get().profileId;
  await provider.addProfile({});
  await provider.selectProfile({ id: savedId });
  const unsaved = provider.profiles().profiles.find((profile) => profile.id !== savedId);
  await assert.rejects(() => provider.selectProfile({ id: unsaved.id, model: 'anything' }),
    { message: 'Save "Provider 2" in Assistant first, then choose its model here.' });
  // Once saved, the model menu's choice goes through.
  await provider.setModel({ model: 'stub-coder-mini' });
  assert.equal(provider.get().model, 'stub-coder-mini');
});

test('a custom endpoint saved under "ScaleMax" by an earlier version is listed by its host', () => {
  const record = { kind: 'custom', baseUrl: 'http://127.0.0.1:47301/v1', model: 'stub-coder-large', keyStorage: 'none', enabledModels: [] };
  const store = memoryStore({ provider: record, providerProfiles: { activeId: 'default', profiles: [{ id: 'default', name: 'ScaleMax', record }] } });
  const { provider } = makeProvider({ store, respond: () => jsonResponse({}) });
  assert.equal(provider.get().profileName, '127.0.0.1:47301');
  assert.equal(provider.profiles().profiles[0].name, '127.0.0.1:47301');
});
