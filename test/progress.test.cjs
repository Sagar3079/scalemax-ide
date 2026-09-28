'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressForwarder } = require('../lib/progress.cjs');

// A forwarder with a hand-driven timer: tick() runs the pending flush.
function forwarder(options = {}) {
  const sent = [];
  let pending = null;
  const forward = createProgressForwarder({
    send: (event) => sent.push(event),
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    ...options,
  });
  const tick = () => { const fn = pending; pending = null; fn?.(); };
  return { forward, sent, tick, hasTimer: () => pending !== null };
}
const R = 'r1';

test('text pieces are gathered and sent together', () => {
  const { forward, sent, tick, hasTimer } = forwarder();
  forward.push({ requestId: R, phase: 'thinking', round: 0 });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'Hel' });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'lo ' });
  forward.push({ requestId: R, phase: 'delta', kind: 'reasoning', text: 'think' });
  assert.equal(sent.length, 1);
  assert.equal(hasTimer(), true);
  tick();
  assert.deepEqual(sent.slice(1), [
    { requestId: R, phase: 'delta', kind: 'reasoning', text: 'think' },
    { requestId: R, phase: 'delta', kind: 'text', text: 'Hello ' },
  ]);
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'world' });
  tick();
  assert.deepEqual(sent.at(-1), { requestId: R, phase: 'delta', kind: 'text', text: 'world' });
});

test('a repair that changes sent text sends the whole round again', () => {
  const restore = (text) => text.replace('Model X-app', 'kiro-app');
  const { forward, sent, tick } = forwarder({ restore });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'Open Model X' });
  tick();
  assert.deepEqual(sent.at(-1), { requestId: R, phase: 'delta', kind: 'text', text: 'Open Model X' });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: '-app now' });
  tick();
  assert.deepEqual(sent.at(-1), { requestId: R, phase: 'text-set', kind: 'text', text: 'Open kiro-app now' });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: '.' });
  tick();
  assert.deepEqual(sent.at(-1), { requestId: R, phase: 'delta', kind: 'text', text: '.' });
});

test('other events keep their order after the text before them, and a new round starts fresh', () => {
  const { forward, sent, tick } = forwarder();
  forward.push({ requestId: R, phase: 'thinking', round: 0 });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'Reading first.' });
  forward.push({ requestId: R, phase: 'preparing', serverId: 'Workspace', toolName: 'read_file' });
  forward.push({ requestId: R, phase: 'preparing', serverId: 'Workspace', toolName: 'read_file' });
  forward.push({ requestId: R, phase: 'tool', callId: 'step-1', title: 'Read a.js', serverId: 'Workspace', toolName: 'read_file' });
  forward.push({ requestId: R, phase: 'tool-output', callId: 'step-1', text: 'a' });
  forward.push({ requestId: R, phase: 'tool-output', callId: 'step-1', text: 'b' });
  forward.push({ requestId: R, phase: 'tool-done', callId: 'step-1', ok: true });
  forward.push({ requestId: R, phase: 'thinking', round: 1 });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'Done.' });
  tick();
  assert.deepEqual(sent.map((event) => [event.phase, event.text || event.callId || '']), [
    ['thinking', ''],
    ['delta', 'Reading first.'],
    ['preparing', ''],
    ['tool', 'step-1'],
    ['tool-output', 'ab'],
    ['tool-done', 'step-1'],
    ['thinking', ''],
    ['delta', 'Done.'],
  ]);
});

test('close sends what is left and drops later events; broken windows and repairs do no harm', () => {
  const { forward, sent } = forwarder({ restore: () => { throw new Error('bad'); } });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'partial' });
  forward.close();
  assert.deepEqual(sent, [{ requestId: R, phase: 'delta', kind: 'text', text: 'partial' }]);
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'late' });
  forward.push({ requestId: R, phase: 'tool-done', callId: 'x', ok: true });
  forward.close();
  assert.equal(sent.length, 1);
  const broken = createProgressForwarder({ send: () => { throw new Error('destroyed'); } });
  broken.push({ requestId: R, phase: 'thinking', round: 0 });
  broken.close();
});

test('real timers send within the interval', async () => {
  const sent = [];
  const forward = createProgressForwarder({ send: (event) => sent.push(event), intervalMs: 10 });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'x' });
  assert.equal(sent.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(sent, [{ requestId: R, phase: 'delta', kind: 'text', text: 'x' }]);
  forward.close();
});

test('finished lines are repaired once; only the line being written is repaired again', () => {
  const seen = [];
  const restore = (text) => { seen.push(text); return text.split('Model X-app').join('kiro-app'); };
  const { forward, sent, tick } = forwarder({ restore });
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'First line about Model X-app.\nSecond ' });
  tick();
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: 'line: Model X' });
  tick();
  forward.push({ requestId: R, phase: 'delta', kind: 'text', text: '-app\nThird.' });
  tick();
  assert.equal(sent.map((event) => (event.phase === 'text-set' ? event.text : '')).filter(Boolean).at(-1),
    'First line about kiro-app.\nSecond line: kiro-app\nThird.');
  // The first line went through the repair once, however many sends followed.
  assert.equal(seen.filter((text) => text.includes('First line')).length, 1);
  assert.ok(seen.every((text) => text.length < 40), 'no send repaired the whole text again');
});
