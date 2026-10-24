import test from 'node:test';
import assert from 'node:assert/strict';
import { createReply, applyProgress, statusText, partialReply, replyReasoning, timedSteps } from '../src/reply-ui.js';
import { normalizeSteps, stepSummary } from '../src/domain.mjs';

const R = 'chat-t1-1';
// The window's clock for progress events: each one arrives 100 ms after the one before.
let clock = 1_000_000;
const feed = (reply, events) => events.map((event) => applyProgress(reply, { requestId: R, ...event }, clock += 100));

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
  // Stopped 250 ms after the last event: the running command keeps the time it ran until then.
  const midTool = partialReply(reply, clock + 250);
  assert.equal(midTool.text, '');
  assert.deepEqual(midTool.steps, [
    { type: 'note', text: 'Reading first.' },
    { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file', durationMs: 100 },
    { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', output: 'running…', stopped: true, durationMs: 350 },
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
  assert.equal(stepSummary(steps), '3 steps · Read 2 files · Tried to run a command · failed');
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

test('changes partly undone in the editor are kept, summarised, and named to the model', async () => {
  const { normalizeChanges, changesSummary, historyMessages } = await import('../src/domain.mjs');
  const changes = normalizeChanges({
    id: 'chat-task-1-3',
    files: [
      { path: 'src/format-date.js', kind: 'modified', added: 1, removed: 1, status: 'changed', partly: { changes: 1, lines: [21, 'x', -3, 0] } },
      { path: 'src/pad.js', kind: 'modified', added: 1, removed: 0, status: 'undone' },
      { path: 'src/odd.js', kind: 'modified', added: 1, removed: 0, partly: { changes: 0, lines: [2] } },
      { path: 'src/kept.js', kind: 'modified', added: 2, removed: 2, status: 'kept', partly: { changes: 2, lines: [4, 9, 12, 15, 18, 30] } },
    ],
  });
  assert.deepEqual(changes.files.map((file) => file.partly), [{ changes: 1, lines: [21] }, undefined, undefined, { changes: 2, lines: [4, 9, 12, 15, 18, 30] }]);
  assert.equal(changesSummary(changes), '4 files changed · +5 −3 · 1 undone · 1 kept · 1 partly undone');
  const turns = historyMessages([
    { role: 'user', text: 'Tidy it.' },
    { role: 'assistant', text: 'Tidied.', changes },
    { role: 'user', text: 'Next?' },
  ]);
  assert.deepEqual(turns[2], {
    role: 'user',
    content: '[Note from ScaleMax, the app: after that reply the user undid its changes to src/pad.js, so this file is back as it was before it.'
      + ' Also, after that reply the user undid some of its changes in the editor: 1 change to src/format-date.js (at line 21); 2 changes to src/kept.js (at lines 4, 9, 12, 15, 18, …).'
      + ' Those parts are back as they were before that reply; its other changes are still there.]',
  });
  // Partly undone alone is a note too.
  const alone = historyMessages([{ role: 'assistant', text: 'Tidied.', changes: { id: 'c', files: [{ path: 'a.js', status: 'changed', partly: { changes: 1, lines: [] } }] } }]);
  assert.equal(alone[1].content, '[Note from ScaleMax, the app: after that reply the user undid some of its changes in the editor: 1 change to a.js. Those parts are back as they were before that reply; its other changes are still there.]');
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
  const [step] = partialReply(reply, clock + 250).steps;
  assert.equal(step.stopped, true);
  assert.equal(step.durationMs, 750, 'the subagent ran from its call until Stop');
  assert.deepEqual(step.agent, {
    kind: 'explore',
    status: 'stopped',
    steps: [
      { type: 'note', text: 'Reading.' },
      { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file', durationMs: 100 },
      { type: 'tool', title: 'Ran npm test', ok: false, server: 'Workspace', tool: 'run_command', stopped: true, durationMs: 250 },
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

test('every step keeps how long it ran; waiting for approval does not count', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  const at = (time, event) => applyProgress(reply, { requestId: R, ...event }, time);
  at(1000, { phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' });
  assert.equal(reply.items[0].startedAt, 1000);
  at(1420, { phase: 'tool-done', callId: 'step-1', ok: true });
  assert.equal(reply.items[0].durationMs, 420);
  // Asked first: the clock starts when the user allowed it.
  at(2000, { phase: 'approval', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' });
  assert.equal(reply.items[1].startedAt, undefined);
  at(9000, { phase: 'tool', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' });
  at(9500, { phase: 'tool', callId: 'step-2', title: 'Ran npm test', serverId: 'Workspace', toolName: 'run_command' });
  assert.equal(reply.items[1].startedAt, 9000, 'a repeated event does not restart it');
  at(72_000, { phase: 'tool-done', callId: 'step-2', ok: false });
  assert.equal(reply.items[1].durationMs, 63_000);
  // Refused at the prompt: it never ran, so it has no time.
  at(80_000, { phase: 'approval', callId: 'step-3', title: 'Wrote b.js', serverId: 'Workspace', toolName: 'write_file' });
  at(85_000, { phase: 'tool-done', callId: 'step-3', ok: false });
  assert.equal(reply.items[2].durationMs, undefined);
  assert.deepEqual(partialReply(reply, 90_000).steps.map((step) => step.durationMs), [420, 63_000, undefined]);
  // Kept bounded with the reply.
  assert.deepEqual(normalizeSteps([
    { type: 'tool', title: 'a', ok: true, durationMs: 420 },
    { type: 'tool', title: 'b', ok: true, durationMs: -1 },
    { type: 'tool', title: 'c', ok: true, durationMs: 1.5 },
    { type: 'tool', title: 'd', ok: true, durationMs: '12' },
    { type: 'tool', title: 'e', ok: true, durationMs: 8 * 24 * 3600 * 1000 },
  ]).map((step) => step.durationMs), [420, undefined, undefined, undefined, undefined]);
});

test('main\'s steps of a finished reply get the times the window measured, call by call', () => {
  const reply = createReply({ taskId: 't1', requestId: R });
  const at = (time, event) => applyProgress(reply, { requestId: R, ...event }, time);
  at(0, { phase: 'delta', kind: 'text', text: 'Looking.' });
  at(100, { phase: 'tool', callId: 'step-1', title: 'Read   a.js', serverId: 'Workspace', toolName: 'read_file' });
  at(400, { phase: 'tool-done', callId: 'step-1', ok: true });
  at(500, { phase: 'tool', callId: 'step-5', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' });
  at(550, { phase: 'tool-done', callId: 'step-5', ok: true });
  at(600, agentStep);
  at(700, status('running'));
  at(800, nested({ phase: 'tool', callId: 'step-1', title: 'Searched for "x"', serverId: 'Workspace', toolName: 'search' }));
  at(1100, nested({ phase: 'tool-done', callId: 'step-1', ok: true }));
  at(1900, { phase: 'tool-done', callId: 'step-2', ok: true });
  const fromMain = [
    { type: 'note', text: 'Looking.' },
    { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file' },
    // Main lists a call that never started (cut off): it gets no time and takes no live step.
    { type: 'tool', title: 'Wrote b.js', ok: false, server: 'Workspace', tool: 'write_file' },
    { type: 'tool', title: 'Read a.js', ok: true, server: 'Workspace', tool: 'read_file' },
    { type: 'tool', title: 'Subagent: Find the parser', ok: true, server: 'Agents', tool: 'agent_task', agent: { kind: 'explore', status: 'done', steps: [
      { type: 'tool', title: 'Searched for "x"', ok: true },
    ] } },
  ];
  const timed = timedSteps(fromMain, reply);
  assert.deepEqual(timed.map((step) => step.durationMs), [undefined, 300, undefined, 50, 1300]);
  assert.equal(timed[4].agent.steps[0].durationMs, 300, 'the subagent\'s own steps too');
  assert.equal(fromMain[1].durationMs, undefined, 'main\'s list is not changed');
  assert.equal(normalizeSteps(timed)[4].agent.steps[0].durationMs, 300, 'kept with the reply');
  assert.equal(timedSteps(undefined, reply), undefined);
  assert.deepEqual(timedSteps(fromMain, null), fromMain);
});
