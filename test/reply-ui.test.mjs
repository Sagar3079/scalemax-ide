import test from 'node:test';
import assert from 'node:assert/strict';
import { createReply, applyProgress, statusText, partialReply, replyReasoning } from '../src/reply-ui.js';
import { normalizeSteps, stepSummary } from '../src/domain.mjs';

const R = 'chat-t1-1';
const feed = (reply, events) => events.map((event) => applyProgress(reply, { requestId: R, ...event }));

test('a streamed reply builds text blocks and steps in order', () => {
  const reply = createReply({ taskId: 't1', requestId: R, thinking: true });
  assert.equal(statusText(reply), 'Thinking…');
  const changes = feed(reply, [
    { phase: 'thinking', round: 0 },
    { phase: 'delta', kind: 'reasoning', text: 'Need the ' },
    { phase: 'delta', kind: 'reasoning', text: 'tests.' },
    { phase: 'delta', kind: 'text', text: 'Let me ' },
    { phase: 'delta', kind: 'text', text: 'check.' },
    { phase: 'preparing', serverId: 'Workspace', toolName: 'run_command' },
    { phase: 'tool', callId: 'step-1', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' },
    { phase: 'tool-output', callId: 'step-1', text: 'ok 1\n' },
    { phase: 'tool-output', callId: 'step-1', text: 'ok 2\n' },
    { phase: 'tool-done', callId: 'step-1', ok: true },
    { phase: 'thinking', round: 1 },
    { phase: 'delta', kind: 'reasoning', text: 'Passed.' },
    { phase: 'delta', kind: 'text', text: 'All tests pass.' },
  ]);
  assert.deepEqual(changes.map((change) => change && change.kind), [
    'status', 'reasoning', 'reasoning', 'text', 'text', 'status', 'step', 'output', 'output', 'step', 'status', 'reasoning', 'text',
  ]);
  assert.equal(changes[3].added, true);
  assert.equal(changes[4].added, false);
  assert.equal(changes[6].added, true);
  assert.deepEqual(reply.items.map((item) => (item.type === 'text' ? item.text : `${item.title}:${item.state}`)),
    ['Let me check.', 'Ran npm test:ok', 'All tests pass.']);
  assert.equal(reply.items[1].output, 'ok 1\nok 2\n');
  assert.equal(replyReasoning(reply), 'Need the tests.\n\nPassed.');
  assert.equal(statusText(reply), 'Writing…');
});

test('text-set replaces the round text, and unknown events change nothing', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  feed(reply, [{ phase: 'delta', kind: 'text', text: 'Open DeepSeek-app' }, { phase: 'text-set', kind: 'text', text: 'Open kiro-app' }]);
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].text, 'Open kiro-app');
  assert.equal(applyProgress(reply, { phase: 'nonsense' }), null);
  assert.equal(applyProgress(reply, { phase: 'tool-output', callId: 'missing', text: 'x' }), null);
  assert.equal(applyProgress(reply, null), null);
});

test('status follows approvals and tools in plain words', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  assert.equal(statusText(reply), 'Writing…');
  applyProgress(reply, { phase: 'approval', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' });
  assert.equal(statusText(reply), 'Waiting for your approval: writing a file');
  applyProgress(reply, { phase: 'tool', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' });
  assert.equal(statusText(reply), 'Writing a file…');
  assert.equal(reply.items.length, 1, 'approval and run are one step');
  applyProgress(reply, { phase: 'tool', callId: 'step-2', title: 'GitHub · list_issues', serverId: 'gh', toolName: 'list_issues' });
  assert.equal(statusText(reply), 'Running gh · list_issues…');
  const media = createReply({ taskId: 't1', requestId: 'media-1', kind: 'media', mediaKind: 'video' });
  assert.equal(statusText(media), 'Generating video…');
  media.mediaPhase = 'queued';
  assert.equal(statusText(media), 'Video queued at the provider…');
});

test('a stopped reply keeps its text as the answer and the rest as steps', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  assert.equal(partialReply(reply), null);
  feed(reply, [
    { phase: 'delta', kind: 'text', text: 'Reading first.' },
    { phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' },
    { phase: 'tool-done', callId: 'step-1', ok: true },
    { phase: 'thinking', round: 1 },
    { phase: 'tool', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' },
    { phase: 'tool-output', callId: 'step-2', text: 'running…' },
  ]);
  const midTool = partialReply(reply);
  assert.equal(midTool.text, '');
  assert.deepEqual(midTool.steps, [
    { type: 'note', text: 'Reading first.' },
    { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file' },
    { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', output: 'running…', stopped: true },
  ]);
  feed(reply, [{ phase: 'tool-done', callId: 'step-2', ok: true }, { phase: 'thinking', round: 2 }, { phase: 'delta', kind: 'text', text: 'Half an answ' }]);
  const midText = partialReply(reply);
  assert.equal(midText.text, 'Half an answ');
  assert.equal(midText.steps.length, 3);
  assert.equal(partialReply(createReply({ taskId: 't', requestId: 'm', kind: 'media' })), null);
});

test('steps are bounded when kept and summarised for the folded list', () => {
  const steps = normalizeSteps([
    { type: 'note', text: '  First I read.  ' },
    { type: 'tool', title: 'Read   a.js', ok: true, server: 'Workspace', tool: 'read_file', preview: 'x'.repeat(500) },
    { type: 'tool', title: 'Read b.js', ok: true, server: 'Workspace', tool: 'read_file' },
    { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', output: `${'y'.repeat(5000)}END` },
    { type: 'tool', title: '' },
    { type: 'note', text: '   ' },
    'junk',
    { type: 'other', text: 'x' },
  ]);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].text, 'First I read.');
  assert.equal(steps[1].title, 'Read a.js');
  assert.equal(steps[1].preview.length, 200);
  assert.equal(steps[3].output.length, 4096);
  assert.ok(steps[3].output.endsWith('END'));
  assert.equal(stepSummary(steps), '3 steps · Read 2 files · Ran a command · failed');
  assert.equal(stepSummary([{ type: 'note', text: 'Only words.' }]), 'Notes');
  assert.equal(normalizeSteps(Array.from({ length: 300 }, () => ({ type: 'note', text: 'n' }))).length, 200);
});

test('an interrupted reply reaches the model as its own text plus a note from ScaleMax', async () => {
  const { historyMessages } = await import('../src/domain.mjs');
  const turns = historyMessages([
    { role: 'user', text: 'Fix the bug.' },
    { role: 'assistant', text: 'Reading first, then', interrupted: 'stopped', notice: 'Stopped before the reply was finished.',
      steps: [
        { type: 'note', text: 'Looking.' },
        { type: 'tool', title: 'Read a.js', ok: true },
        { type: 'tool', title: 'Edited a.js', ok: false },
        { type: 'tool', title: 'Ran npm test', ok: false, stopped: true },
      ] },
    { role: 'user', text: 'Carry on.' },
    { role: 'assistant', text: '', interrupted: 'failed', steps: [] },
    { role: 'user', text: '/init' },
    { role: 'assistant', text: 'Plain answer.' },
    { role: 'system', text: 'never sent' },
    'junk',
  ]);
  assert.deepEqual(turns, [
    { role: 'user', content: 'Fix the bug.' },
    { role: 'assistant', content: 'Reading first, then' },
    { role: 'user', content: '[Note from ScaleMax, the app: the user pressed Stop while you were writing your previous reply, so it ends where they stopped it. It had already done this: Read a.js; Edited a.js (failed); Ran npm test (stopped).]' },
    { role: 'user', content: 'Carry on.' },
    { role: 'user', content: '[Note from ScaleMax, the app: your previous reply broke off because of a connection or provider error, not because of you or the user.]' },
    { role: 'user', content: '/init' },
    { role: 'assistant', content: 'Plain answer.' },
  ]);
});

test('a reply\'s changes are kept bounded, summarised, and undone files reach the model as a note', async () => {
  const { normalizeChanges, changesSummary, historyMessages } = await import('../src/domain.mjs');
  const changes = normalizeChanges({
    id: 'chat-task-1-2', folderName: 'kiro-app',
    files: [
      { path: 'src/a.js', kind: 'modified', added: 3, removed: 1, status: 'undone' },
      { path: 'notes.md', kind: 'created', added: 2, removed: 0, status: 'kept' },
      { path: 'src/b.js', kind: 'weird', added: -4, removed: 1.5, status: 'odd' },
      { path: 'src/a.js', kind: 'modified', added: 9, removed: 9 },
      { path: '' },
      'junk',
    ],
  });
  assert.deepEqual(changes, {
    id: 'chat-task-1-2', folderName: 'kiro-app',
    files: [
      { path: 'src/a.js', kind: 'modified', added: 3, removed: 1, status: 'undone' },
      { path: 'notes.md', kind: 'created', added: 2, removed: 0, status: 'kept' },
      { path: 'src/b.js', kind: 'modified', added: 0, removed: 0, status: 'changed' },
    ],
  });
  assert.equal(changesSummary(changes), '3 files changed · +5 \u22121 · 1 undone · 1 kept');
  assert.equal(normalizeChanges({ id: 'x', files: [] }), null);
  assert.equal(normalizeChanges({ id: 'bad\nid', files: [{ path: 'a' }] }), null);
  assert.equal(changesSummary(null), '');
  const turns = historyMessages([
    { role: 'user', text: 'Fix it.' },
    { role: 'assistant', text: 'Fixed a.js and wrote notes.', changes },
    { role: 'user', text: 'Thanks. Now b.js?' },
  ]);
  assert.deepEqual(turns, [
    { role: 'user', content: 'Fix it.' },
    { role: 'assistant', content: 'Fixed a.js and wrote notes.' },
    { role: 'user', content: '[Note from ScaleMax, the app: after that reply the user undid its changes to src/a.js, so this file is back as it was before it.]' },
    { role: 'user', content: 'Thanks. Now b.js?' },
  ]);
  // Stopped and partly undone: one note says both.
  const both = historyMessages([
    { role: 'assistant', text: '', interrupted: 'stopped', steps: [{ type: 'tool', title: 'Edited src/a.js', ok: true }], changes },
  ]);
  assert.deepEqual(both, [{ role: 'user', content: '[Note from ScaleMax, the app: the user pressed Stop while you were writing your previous reply, so it ends where they stopped it. It had already done this: Edited src/a.js. Also, after that reply the user undid its changes to src/a.js, so this file is back as it was before it.]' }]);
});

test('a live reply keeps the latest changes, and a stopped one carries them', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  assert.equal(applyProgress(reply, { phase: 'changes', changes: { id: R, files: [] } }), null);
  const change = applyProgress(reply, { phase: 'changes', changes: { id: R, folderName: 'app', files: [{ path: 'a.js', kind: 'modified', added: 1, removed: 1 }] } });
  assert.deepEqual(change, { kind: 'changes' });
  const partial = partialReply(reply);
  assert.deepEqual(partial.changes, { id: R, folderName: 'app', files: [{ path: 'a.js', kind: 'modified', added: 1, removed: 1, status: 'changed' }] });
  assert.equal(partial.text, '');
  // Every file changed back: the changes are gone, and with nothing else there is no partial reply.
  assert.deepEqual(applyProgress(reply, { phase: 'changes', changes: null }), { kind: 'changes' });
  assert.equal(reply.changes, null);
  assert.equal(partialReply(reply), null);
});

test('a to-do list and a retry reach the live reply, and a stopped reply keeps its list', () => {
  const reply = createReply({ taskId: 't', requestId: 'r' });
  applyProgress(reply, { phase: 'thinking', round: 0 });
  applyProgress(reply, { phase: 'delta', kind: 'text', text: 'Half' });
  assert.deepEqual(applyProgress(reply, { phase: 'todos', items: [{ content: 'Add the test', status: 'in_progress' }, { content: '', status: 'pending' }] }), { kind: 'todos' });
  assert.deepEqual(reply.todos, [{ content: 'Add the test', status: 'in_progress' }]);
  // The provider is asked again: the text shown so far was reset by main (text-set ''), and the
  // status says why the reply is taking longer.
  applyProgress(reply, { phase: 'text-set', kind: 'text', text: '' });
  applyProgress(reply, { phase: 'retry', attempt: 1 });
  assert.equal(reply.phase, 'retrying');
  assert.match(statusText(reply), /trying again/);
  applyProgress(reply, { phase: 'delta', kind: 'text', text: 'Whole answer.' });
  const partial = partialReply(reply);
  assert.equal(partial.text, 'Whole answer.');
  assert.deepEqual(partial.todos, [{ content: 'Add the test', status: 'in_progress' }]);
});

// A subagent (agent_task, lib/subagents.cjs) of the step 'step-2': its status, and its own events.
const agentStep = { phase: 'tool', callId: 'step-2', title: 'Subagent: Find the parser', serverId: 'Agents', toolName: 'agent_task' };
const status = (value, extra = {}) => ({ phase: 'subagent', callId: 'step-2', status: value, description: 'Find the parser', kind: 'explore', ...extra });
const nested = (event) => ({ phase: 'subagent', callId: 'step-2', event });

test('a subagent builds a group of its own under the step of its call', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  feed(reply, [
    { phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' },
    { phase: 'tool-done', callId: 'step-1', ok: true },
    agentStep,
  ]);
  assert.equal(statusText(reply), 'Running a subagent…');
  const changes = feed(reply, [
    status('running'),
    nested({ phase: 'thinking', round: 0 }),
    nested({ phase: 'delta', kind: 'text', text: 'Looking.' }),
    // Its own step ids: its 'step-1' is not the reply's.
    nested({ phase: 'tool', callId: 'step-1', title: 'Searched for "parse"', serverId: 'Workspace', toolName: 'search' }),
    nested({ phase: 'tool-output', callId: 'step-1', text: 'src/parser.js:12' }),
    nested({ phase: 'tool-done', callId: 'step-1', ok: true }),
    status('done', { rounds: 2, metrics: { usage: { inputTokens: 20, outputTokens: 4 }, pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 }, costNanoUsd: 28000, costStatus: 'priced' } }),
  ]);
  assert.deepEqual(changes.map((change) => change && change.kind), ['agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent']);
  assert.equal(reply.items.length, 2, 'nested events add nothing to the reply itself');
  assert.equal(reply.items[0].state, 'ok', 'the reply\'s own step-1 is untouched');
  const { agent } = reply.items[1];
  assert.equal(agent.description, 'Find the parser');
  assert.equal(agent.kind, 'explore');
  assert.equal(agent.status, 'done');
  assert.equal(agent.rounds, 2);
  assert.equal(agent.metrics.costNanoUsd, 28000);
  assert.deepEqual(agent.items.map((item) => (item.type === 'text' ? item.text : `${item.title}:${item.state}:${item.output}`)),
    ['Looking.', 'Searched for "parse":ok:src/parser.js:12']);
  // The reply's step ends as usual.
  applyProgress(reply, { phase: 'tool-done', callId: 'step-2', ok: true });
  assert.equal(reply.items[1].state, 'ok');
  assert.equal(statusText(reply), 'Working…');
});

test('subagent events for no known step, nested subagents, changes and bad statuses are ignored', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  assert.equal(applyProgress(reply, status('running')), null, 'no such step');
  applyProgress(reply, agentStep);
  assert.equal(applyProgress(reply, nested({ phase: 'subagent', callId: 'step-1', status: 'running' })), null);
  assert.equal(applyProgress(reply, nested({ phase: 'changes', changes: null })), null);
  assert.equal(applyProgress(reply, status('exploded')), null);
  assert.equal(applyProgress(reply, nested({ phase: 'nonsense' })), null);
  assert.equal(reply.items[0].agent, undefined, 'nothing to show yet');
  applyProgress(reply, status('queued', { kind: 'admin', description: 42 }));
  assert.equal(reply.items[0].agent.status, 'queued');
  assert.equal(reply.items[0].agent.kind, 'general', 'an unknown kind is not taken');
  assert.equal(reply.items[0].agent.description, '');
});

test('the status counts the subagents at work and says when one waits for approval', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  feed(reply, [agentStep, status('running'), { ...agentStep, callId: 'step-3' }, { phase: 'subagent', callId: 'step-3', status: 'running', description: 'Find the tests', kind: 'explore' }]);
  assert.equal(statusText(reply), 'Running 2 subagents…');
  applyProgress(reply, nested({ phase: 'approval', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' }));
  assert.equal(statusText(reply), 'Waiting for your approval · Subagent: Find the parser');
  applyProgress(reply, nested({ phase: 'tool', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' }));
  assert.equal(statusText(reply), 'Running 2 subagents…');
  applyProgress(reply, status('done'));
  applyProgress(reply, { phase: 'tool-done', callId: 'step-2', ok: true });
  assert.equal(statusText(reply), 'Running a subagent…');
});

test('a stopped reply keeps its subagent, stopped, with what it did so far', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  feed(reply, [
    agentStep,
    status('running'),
    nested({ phase: 'delta', kind: 'text', text: 'Reading.' }),
    nested({ phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' }),
    nested({ phase: 'tool-done', callId: 'step-1', ok: true }),
    nested({ phase: 'tool', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' }),
  ]);
  const [step] = partialReply(reply).steps;
  assert.equal(step.stopped, true);
  assert.deepEqual(step.agent, {
    kind: 'explore',
    status: 'stopped',
    steps: [
      { type: 'note', text: 'Reading.' },
      { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file' },
      { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', stopped: true },
    ],
  });
});

test('a subagent is kept small with its step, and summarised in plain words', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    type: 'tool', title: `Read f${index}.js`, ok: true, server: 'Workspace', tool: 'read_file', output: 'long output',
    agent: { kind: 'general', status: 'done', steps: [] },
  }));
  const [step, other] = normalizeSteps([
    { type: 'tool', title: 'Subagent: Read all', ok: true, server: 'Agents', tool: 'agent_task', agent: { kind: 'explore', status: 'done', steps: [{ type: 'note', text: 'n'.repeat(5000) }, ...many], metrics: { usage: { inputTokens: 5, outputTokens: 1 }, costStatus: 'unpriced' }, rounds: 3 } },
    { type: 'tool', title: 'Subagent: Odd', ok: false, server: 'Agents', tool: 'agent_task', agent: { kind: 'admin', status: 'exploded', steps: 'junk', metrics: 'junk', rounds: -1 } },
  ]);
  assert.equal(step.agent.kind, 'explore');
  assert.equal(step.agent.status, 'done');
  assert.equal(step.agent.rounds, 3);
  assert.deepEqual(step.agent.metrics, { usage: { inputTokens: 5, outputTokens: 1 }, costStatus: 'unpriced' });
  assert.equal(step.agent.steps.length, 50);
  assert.equal(step.agent.steps[0].text.length, 2000);
  assert.ok(step.agent.steps.slice(1).every((item) => !('output' in item) && !('agent' in item)), 'no output and no nested subagent');
  assert.deepEqual(other.agent, { kind: 'general', status: 'failed', steps: [] });
  assert.equal(normalizeSteps([{ type: 'tool', title: 'x', ok: true, agent: 'junk' }])[0].agent, undefined);
  assert.equal(stepSummary([step]), '1 step · Ran a subagent');
  assert.equal(stepSummary([step, { ...step }]), '2 steps · Ran 2 subagents');
});
