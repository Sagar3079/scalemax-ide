'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectNames, restoreNames, modelNames, rewritable } = require('../lib/reply-names.cjs');
const { createToolLoop } = require('../lib/tool-loop.cjs');

// What api.scalemax.pro does to reply text (observed 2026-09-27 for every chat model).
const gateway = (text, model) => text.replace(/(?<![A-Za-z0-9])kiro(?![A-Za-z0-9])/gi, model);
const DEEPSEEK = modelNames({ modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', responseModel: 'deepseek-v4-flash' });

test('the rewritten word is the whole word only', () => {
  for (const value of ['kiro', 'Kiro', 'KIRO', 'kiro-scalemax-ide', 'my-kiro-app', 'kiro_app', 'kiro.dev', 'src/kiro']) assert.ok(rewritable(value), value);
  for (const value of ['kiro2', '2kiro', 'Kiros', 'kirolabs', 'scalemax-ide']) assert.ok(!rewritable(value), value);
});

test('the folder name comes back exactly', () => {
  const names = collectNames(['The user\'s workspace folder is "kiro-scalemax-ide".'], ['kiro-scalemax-ide']);
  const reply = gateway('The current workspace folder is named **`kiro-scalemax-ide`**, and it is empty.', 'DeepSeek V4 Flash');
  assert.equal(reply, 'The current workspace folder is named **`DeepSeek V4 Flash-scalemax-ide`**, and it is empty.');
  assert.equal(restoreNames(reply, { names, replacements: DEEPSEEK }), 'The current workspace folder is named **`kiro-scalemax-ide`**, and it is empty.');
});

test('paths from tool results and the user\'s words are restored, other text is left alone', () => {
  const sources = [
    'kiro-app (the workspace folder): 1 folders, 1 files\nsrc/\nKiro.md',
    'Please open src/kiro/index.js and the KIRO_NOTES file',
  ];
  const names = collectNames(sources);
  for (const name of ['kiro-app', 'Kiro.md', 'src/kiro/index.js', 'src/kiro', 'KIRO_NOTES']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('kiro'), 'a bare word is never "restored"');
  const original = 'In kiro-app I opened src/kiro/index.js, read Kiro.md and KIRO_NOTES. I am kiro.';
  const reply = gateway(original, 'claude-sonnet-4-6');
  const fixed = restoreNames(reply, { names, replacements: modelNames({ modelId: 'claude-sonnet-4-6[1m]', displayName: 'Sonnet 4.6', responseModel: 'claude-sonnet-4-6' }) });
  assert.equal(fixed, 'In kiro-app I opened src/kiro/index.js, read Kiro.md and KIRO_NOTES. I am claude-sonnet-4-6.');
  assert.equal(restoreNames('No names here.', { names, replacements: DEEPSEEK }), 'No names here.');
  assert.equal(restoreNames(reply, { names: [], replacements: DEEPSEEK }), reply);
});

test('model names include the id without a context suffix', () => {
  assert.deepEqual(modelNames({ modelId: 'claude-sonnet-4-6[1m]', displayName: 'Sonnet 4.6' }), ['Sonnet 4.6', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6']);
});

test('the tool loop repairs the final reply with names from the whole request', async () => {
  const replies = [
    { content: '', toolCalls: [{ id: 'c1', name: 'mcp_fs_list', arguments: '{}' }] },
    { content: gateway('Your folder kiro-scalemax-ide holds kiro-notes.md.', 'DeepSeek V4 Flash'), model: 'deepseek-v4-flash', reasoning: gateway('Listing kiro-scalemax-ide', 'DeepSeek V4 Flash') },
  ];
  let round = 0;
  const provider = {
    async send() { throw new Error('unused'); },
    async complete() { return replies[round++]; },
    cancel: () => false,
  };
  const mcp = {
    async chatTools() {
      return { tools: [{ type: 'function', function: { name: 'mcp_fs_list', description: 'list', parameters: { type: 'object', properties: {} } } }], resolve: () => ({ serverId: 'fs', toolName: 'list', readOnly: true }), errors: [] };
    },
    async callTool() { return { text: 'kiro-notes.md' }; },
  };
  const seen = [];
  const loop = createToolLoop({
    provider,
    mcp,
    restoreText: (text, sources) => { seen.push(sources); return restoreNames(text, { names: collectNames(sources), replacements: DEEPSEEK }); },
  });
  const result = await loop.send({ requestId: 'r1', systemPrompt: 'The user\'s workspace folder is "kiro-scalemax-ide".', messages: [{ role: 'user', content: 'what is here?' }] }, { permission: 'bypass' });
  assert.equal(result.text, 'Your folder kiro-scalemax-ide holds kiro-notes.md.');
  assert.equal(result.reasoning, 'Listing kiro-scalemax-ide');
  assert.ok(seen[0].includes('kiro-notes.md'), 'tool results are sources');
});

test('a failing repair never breaks the reply', async () => {
  const provider = { async send() { return { text: 'plain', model: 'm' }; }, async complete() { throw new Error('unused'); }, cancel: () => false };
  const mcp = { async chatTools() { return { tools: [], resolve: () => null, errors: [] }; }, async callTool() {} };
  const loop = createToolLoop({ provider, mcp, restoreText: () => { throw new Error('boom'); } });
  assert.equal((await loop.send({ requestId: 'r2', messages: [{ role: 'user', content: 'hi' }] })).text, 'plain');
});
