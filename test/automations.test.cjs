'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/state.cjs');
const { createAutomations, nextRunAt, mergeAutomations, deniedSummary, runPermission } = require('../lib/automations.cjs');

const CONTEXT = {
  systemPrompts: { working: 'You are ScaleMax. Working mode.', coding: 'You are ScaleMax. Coding mode.' },
  temperature: 0.3,
  reasoning: { thinking: true, effort: 'high' },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The real state store (lib/state.cjs) on a throwaway file: it refuses what the app's would.
function tempStore(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-automations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  return createStore(file);
}

function automation(overrides = {}) {
  return {
    id: 'a1', name: 'Digest', prompt: 'Summarize', schedule: 'daily', time: '09:00',
    dayOfWeek: 1, dayOfMonth: 1, intervalMinutes: null, runAt: null,
    active: true, createdAt: 0, nextRun: Date.now() + 3600000, pendingCatchUp: false,
    lastRun: null, lastStatus: 'idle', lastError: '', history: [], schemaVersion: 2,
    ...overrides,
  };
}

// The scheduler with a fake chat path: `reply` answers each request (a function gets it).
function setup(t, { automations = [automation()], tasks, context = CONTEXT, reply, configured = true, windowOpen = true, settings, openFolder, cancel, clock } = {}) {
  const store = tempStore(t, {
    automations,
    ...(tasks ? { tasks } : {}),
    ...(settings ? { settings } : {}),
    ...(context ? { automationContext: context } : {}),
  });
  const sent = [];
  const notices = [];
  const state = { windowOpen, configured };
  const scheduler = createAutomations({
    store,
    send: async (input) => {
      sent.push(input);
      if (typeof reply === 'function') return reply(input, scheduler);
      return { text: `reply ${sent.length}`, toolCalls: [{ server: 'Workspace', tool: 'read_file', ok: true, preview: 'x' }], steps: [{ type: 'tool', title: 'Read a.txt', ok: true }] };
    },
    configured: () => state.configured,
    windowOpen: () => state.windowOpen,
    openFolder: openFolder || (() => null),
    notify: (change) => notices.push(structuredClone(change)),
    ...(cancel ? { cancel } : {}),
    ...(clock || {}),
  });
  t.after(() => scheduler.stop());
  const saved = () => store.readAll();
  const record = (id = 'a1') => saved().automations.find((item) => item.id === id);
  return { scheduler, store, sent, notices, state, saved, record };
}

// ---- Schedule math -------------------------------------------------------------------------

test('the schedule math is exactly the window\'s (src/domain.mjs), DST and month ends included', async () => {
  const domain = await import('../src/domain.mjs');
  // A fixed pseudo-random sequence, so a failure can be reproduced.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const times = ['00:00', '00:15', '01:30', '02:30', '03:00', '09:00', '12:45', '23:59'];
  // Around both DST switches, month ends and leap days.
  const anchors = [Date.UTC(2026, 2, 8, 6), Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 0, 31, 23), Date.UTC(2028, 1, 28, 12), Date.UTC(2026, 9, 16, 9), Date.UTC(2026, 11, 31, 23, 59)];
  const outcome = (fn) => {
    try { return { value: fn() }; } catch (error) { return { error: error.message }; }
  };
  let compared = 0;
  for (let index = 0; index < 4000; index += 1) {
    const after = pick(anchors) + Math.floor((random() - 0.5) * 40 * 86400000);
    const schedule = pick(['once', 'hourly', 'daily', 'weekly', 'monthly', 'interval', 'yearly']);
    const record = {
      schedule,
      time: random() < 0.95 ? pick(times) : '25:00',
      dayOfWeek: random() < 0.95 ? Math.floor(random() * 7) : 9,
      dayOfMonth: random() < 0.95 ? 1 + Math.floor(random() * 31) : 0,
      intervalMinutes: random() < 0.95 ? pick([1, 7, 15, 60, 1440, 525600]) : 0,
      runAt: random() < 0.5 ? after + Math.floor((random() - 0.3) * 86400000) : null,
    };
    const from = random() < 0.5 ? after - Math.floor(random() * 5 * 86400000) : (random() < 0.5 ? null : after + 1000);
    assert.deepEqual(outcome(() => nextRunAt(record, after, { from })), outcome(() => domain.nextRunAt(record, after, { from })), JSON.stringify({ record, after, from }));
    compared += 1;
  }
  assert.equal(compared, 4000);
  assert.deepEqual(outcome(() => nextRunAt(null)), outcome(() => domain.nextRunAt(null)));
  assert.deepEqual(outcome(() => nextRunAt({ schedule: 'daily', time: '09:00' }, Number.NaN)), outcome(() => domain.nextRunAt({ schedule: 'daily', time: '09:00' }, Number.NaN)));
});

// ---- Runs ----------------------------------------------------------------------------------

test('run now goes through the chat path once, records history and appends to the automation task', async (t) => {
  const { scheduler, sent, notices, record, saved } = setup(t, { automations: [automation({ mode: 'coding', folder: null })] });
  const before = record().nextRun;
  assert.deepEqual(await scheduler.runNow('a1'), { status: 'success' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].requestId, /^automation-a1-\d+$/);
  assert.deepEqual({ ...sent[0], requestId: undefined }, {
    requestId: undefined,
    folder: null,
    messages: [{ role: 'user', content: 'Summarize' }],
    mode: 'coding',
    systemPrompt: CONTEXT.systemPrompts.coding,
    temperature: 0.3,
    reasoning: { thinking: true, effort: 'high' },
  });
  const [entry] = record().history;
  assert.equal(entry.status, 'success');
  assert.equal(entry.preview, 'reply 1');
  assert.equal(record().lastStatus, 'success');
  assert.equal(record().nextRun, before, 'a manual run leaves the schedule alone');
  const [task] = saved().tasks;
  assert.equal(task.title, 'Automation · Digest');
  assert.equal(task.automationId, 'a1');
  assert.equal(task.folder, undefined, 'made without a folder: not tied to the open one');
  assert.deepEqual(task.messages.map((message) => [message.role, message.text, message.run]), [
    ['user', 'Summarize', sent[0].requestId],
    ['assistant', 'reply 1', sent[0].requestId],
  ]);
  assert.deepEqual(task.messages[1].tools, [{ server: 'Workspace', tool: 'read_file', ok: true }]);
  assert.deepEqual(task.messages[1].steps, [{ type: 'tool', title: 'Read a.txt', ok: true }]);
  // The window hears that it started, and how it ended with the messages for its task.
  assert.deepEqual(notices[0].running, ['a1']);
  const last = notices.at(-1);
  assert.deepEqual(last.running, []);
  assert.deepEqual(last.finished, { id: 'a1', name: 'Digest', status: 'success', manual: true });
  assert.deepEqual(last.run.task, { id: task.id, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, automationId: 'a1' });
  assert.deepEqual(last.run.messages, task.messages);
  await assert.rejects(() => scheduler.runNow('missing'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => scheduler.runNow('../bad'), (error) => error.code === 'INVALID_AUTOMATION');
});

test('the temperature is left out when the window sends none', async (t) => {
  const { scheduler, sent } = setup(t, { context: { systemPrompts: CONTEXT.systemPrompts } });
  await scheduler.runNow('a1');
  assert.equal(Object.hasOwn(sent[0], 'temperature'), false);
  assert.equal(Object.hasOwn(sent[0], 'reasoning'), false);
});

test('a schedule missed many times while ScaleMax was closed catches up exactly once', async (t) => {
  const now = Date.now();
  const { scheduler, sent, record } = setup(t, { automations: [automation({ nextRun: now - 10 * 86400000 })] });
  await scheduler.check();
  await scheduler.whenIdle();
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
  assert.equal(record().pendingCatchUp, false);
  assert.ok(record().nextRun > now);
});

test('overlapping checks and run now never run the same automation twice', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { scheduler, sent, record } = setup(t, {
    automations: [automation({ nextRun: Date.now() - 1000 })],
    reply: async () => { await gate; return { text: 'done' }; },
  });
  const first = scheduler.check();
  await tick();
  const overlapping = scheduler.check();
  assert.deepEqual(await scheduler.runNow('a1'), { status: 'skipped' });
  release();
  await Promise.all([first, overlapping]);
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
  assert.equal(record().history.length, 1);
});

test('a failed run records the error and adds nothing to the task', async (t) => {
  const { scheduler, record, saved, notices } = setup(t, { reply: async () => { throw new Error('Rate limited'); } });
  assert.deepEqual(await scheduler.runNow('a1'), { status: 'error', message: 'Rate limited' });
  assert.equal(record().lastStatus, 'error');
  assert.equal(record().lastError, 'Rate limited');
  assert.equal(record().history[0].status, 'error');
  assert.equal(record().history[0].preview, 'Rate limited');
  assert.equal(saved().tasks, undefined);
  assert.equal(notices.at(-1).finished.message, 'Rate limited');
  assert.equal(notices.at(-1).run, undefined);
});

test('without a provider a run is recorded as skipped, with a code the window recognises', async (t) => {
  const { scheduler, sent, record } = setup(t, { configured: false });
  const result = await scheduler.runNow('a1');
  assert.deepEqual(result, { status: 'error', code: 'PROVIDER_NOT_CONFIGURED', message: 'Provider not configured; scheduled run skipped.' });
  assert.equal(sent.length, 0);
  assert.equal(record().lastError, 'Provider not configured; scheduled run skipped.');
});

test('a one-time schedule switches itself off once it has fired', async (t) => {
  const { scheduler, sent, record } = setup(t, { automations: [automation({ schedule: 'once', runAt: Date.now() - 1, nextRun: Date.now() - 1 })] });
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
  assert.equal(record().active, false);
  assert.equal(record().nextRun, null);
});

test('a run works in the folder and mode it was made in, never in whatever is open', async (t) => {
  const folder = { name: 'reports', path: '/Users/you/reports' };
  const open = { name: 'open', path: '/Users/you/open' };
  const { scheduler, sent, saved } = setup(t, {
    automations: [
      automation({ folder, mode: 'coding' }),
      automation({ id: 'a2', name: 'Digest', folder: null, mode: null }),
      automation({ id: 'a3', name: 'Legacy' }),
    ],
    settings: { mode: 'working' },
    openFolder: () => open,
  });
  await scheduler.runNow('a1');
  await scheduler.runNow('a2');
  await scheduler.runNow('a3');
  assert.equal(sent[0].folder, '/Users/you/reports');
  assert.equal(sent[0].mode, 'coding', 'its own mode, not the one on screen');
  assert.equal(sent[0].systemPrompt, CONTEXT.systemPrompts.coding);
  assert.equal(sent[1].folder, null, 'made without a folder: no file tools at all');
  assert.equal(sent[1].mode, 'working');
  assert.equal(Object.hasOwn(sent[2], 'folder'), false, 'made before folders were remembered: main uses the open one');
  const tasks = saved().tasks;
  assert.equal(tasks.length, 3, 'two automations with the same name keep their own tasks');
  assert.deepEqual(tasks.find((task) => task.automationId === 'a1').folder, folder);
  assert.equal(tasks.find((task) => task.automationId === 'a2').folder, undefined);
  assert.deepEqual(tasks.find((task) => task.automationId === 'a3').folder, open);
  await scheduler.runNow('a1');
  assert.equal(saved().tasks.find((task) => task.automationId === 'a1').messages.length, 4, 'the next run lands in the same task');
});

test('an output task from before tasks remembered their automation is adopted by its title', async (t) => {
  const old = { id: 'task-old', title: 'Automation · Digest', messages: [{ role: 'user', text: 'Summarize', time: 1 }], createdAt: 1, updatedAt: 1 };
  const { scheduler, saved } = setup(t, { tasks: [old] });
  await scheduler.runNow('a1');
  const [task] = saved().tasks;
  assert.equal(task.id, 'task-old');
  assert.equal(task.automationId, 'a1');
  assert.equal(task.messages.length, 3);
});

test('an interval schedule keeps its rhythm: stepped from the slot that came due, passed slots skipped', async (t) => {
  const now = Date.now();
  const due = now - 1000;
  const missed = now - 25 * 60000;
  const { scheduler, sent, record, store } = setup(t, { automations: [] });
  // Caught up already (nothing was missed at start).
  await scheduler.check();
  store.update((draft) => {
    draft.automations = [
      automation({ schedule: 'interval', intervalMinutes: 10, nextRun: due }),
      automation({ id: 'a2', schedule: 'interval', intervalMinutes: 10, nextRun: missed }),
    ];
  });
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(record('a1').nextRun, due + 10 * 60000);
  assert.equal(record('a2').nextRun, missed + 30 * 60000);
  assert.equal(sent.length, 2);
});

// A fake clock: the timer main sets is recorded (its delay), never fired on its own.
function fakeClock(start = Date.now()) {
  const clock = { time: start, timers: [] };
  clock.now = () => clock.time;
  clock.setTimer = (fn, delay) => {
    const timer = { fn, delay, cleared: false };
    clock.timers.push(timer);
    return timer;
  };
  clock.clearTimer = (timer) => { if (timer) timer.cleared = true; };
  clock.armed = () => clock.timers.filter((timer) => !timer.cleared);
  // Moves the clock to when the armed timer wakes, and wakes it.
  clock.fire = async () => {
    const [timer] = clock.armed();
    clock.time += timer.delay;
    timer.cleared = true;
    timer.fn();
    await tick();
  };
  return clock;
}

test('the timer wakes for the exact next run, not on a 30 s poll', async (t) => {
  const clock = fakeClock();
  const slot = clock.time + 12_345;
  const { scheduler, sent, record, store } = setup(t, {
    automations: [automation({ schedule: 'interval', intervalMinutes: 1, nextRun: slot })],
    clock: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  scheduler.start();
  await tick();
  assert.equal(clock.armed().length, 1);
  assert.equal(clock.armed()[0].delay, 12_345, 'it wakes when the row says');
  await clock.fire();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1, 'fired at its slot');
  assert.equal(record().nextRun, slot + 60_000);
  assert.equal(clock.armed().length, 1);
  assert.equal(clock.armed()[0].delay, 30_000, 'a minute away: it still looks at least every 30 s');
  // The window makes a schedule due sooner: the timer is set again for it.
  store.update((draft) => { draft.automations.push(automation({ id: 'a2', name: 'Soon', nextRun: clock.time + 2_000 })); });
  scheduler.fromWindow('automations', store.readAll().automations);
  assert.equal(clock.armed().length, 1, 'one timer at a time');
  assert.equal(clock.armed()[0].delay, 2_000);
  scheduler.stop();
  assert.equal(clock.armed().length, 0);
});

test('a due run that cannot fire yet is looked at again later, not in a loop', async (t) => {
  const clock = fakeClock();
  const { scheduler, sent } = setup(t, {
    context: null,
    automations: [automation({ nextRun: clock.time - 1000 })],
    clock: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  scheduler.start();
  await tick();
  assert.equal(sent.length, 0, 'no instructions from the window yet');
  assert.deepEqual(clock.armed().map((timer) => timer.delay), [30_000]);
});

test('run now neither moves the next slot nor makes it fire twice; a slot held up by an approval is skipped', async (t) => {
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  const clock = fakeClock();
  const slot = clock.time + 10_000;
  const { scheduler, sent, record, notices } = setup(t, {
    automations: [automation({ schedule: 'interval', intervalMinutes: 1, nextRun: slot })],
    reply: async () => { await gate; return { text: 'done' }; },
    clock: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  scheduler.start();
  await tick();
  const manual = scheduler.runNow('a1');
  await tick();
  // It waits for the user's answer to an approval in the window.
  const runId = sent[0].requestId;
  assert.equal(scheduler.asking(runId, true), true);
  assert.deepEqual(notices.at(-1).waiting, ['a1']);
  assert.deepEqual(notices.at(-1).running, ['a1']);
  assert.equal(record().nextRun, slot, 'Run now leaves the schedule alone');
  // Its slot comes due while it still waits.
  await clock.fire();
  assert.equal(sent.length, 1, 'no second run while the first one works');
  assert.equal(record().nextRun, slot + 60_000, 'the held-up slot is rolled forward');
  scheduler.asking(runId, false);
  assert.deepEqual(notices.at(-1).waiting, []);
  release();
  await manual;
  await scheduler.whenIdle();
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1, 'and none as soon as it ends');
  assert.equal(scheduler.asking('chat-request', true), false, 'other replies are not counted');
  // The next slot runs as usual.
  gate = Promise.resolve();
  clock.time = slot + 60_000;
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 2);
  assert.equal(record().nextRun, slot + 120_000);
});

test('a run that comes due while another works starts at once; a slot of the one still working is skipped', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { scheduler, sent, record, store } = setup(t, {
    automations: [],
    reply: async (input) => {
      if (input.requestId.startsWith('automation-a1-')) await gate;
      return { text: 'done' };
    },
  });
  await scheduler.check();
  store.update((draft) => {
    draft.automations = [automation({ nextRun: Date.now() - 1000 }), automation({ id: 'a2', name: 'Other', nextRun: Date.now() + 3600000 })];
  });
  void scheduler.check();
  await tick();
  store.update((draft) => {
    for (const item of draft.automations) item.nextRun = Date.now() - 1;
  });
  await scheduler.check();
  assert.equal(record('a2').lastStatus, 'success', 'a2 ran while a1 was still working');
  assert.deepEqual(sent.map((input) => input.requestId.split('-')[1]), ['a1', 'a2']);
  assert.ok(record('a1').nextRun > Date.now(), 'the slot that came due while a1 worked is rolled forward');
  release();
  await scheduler.whenIdle();
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.filter((input) => input.requestId.startsWith('automation-a1-')).length, 1,
    'the run that held the slot up is not followed by a second one when it ends');
});

test('the start-up catch-up skips an automation a check already ran since', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const now = Date.now();
  const { scheduler, sent, store } = setup(t, {
    automations: [
      automation({ pendingCatchUp: true, nextRun: now + 3600000 }),
      automation({ id: 'a2', name: 'Other', pendingCatchUp: true, nextRun: now + 3600000 }),
    ],
    reply: async (input) => {
      if (input.requestId.startsWith('automation-a1-')) await gate;
      return { text: 'done' };
    },
  });
  void scheduler.check();
  await tick();
  // a2's next slot comes due while a1's catch-up still works: a check runs it, and that was its run.
  store.update((draft) => { draft.automations[1].nextRun = Date.now() - 1; });
  await scheduler.check();
  release();
  await scheduler.whenIdle();
  assert.equal(sent.filter((input) => input.requestId.startsWith('automation-a2-')).length, 1);
  assert.equal(sent.filter((input) => input.requestId.startsWith('automation-a1-')).length, 1);
});

test('nothing fires before the window has sent its instructions once; they are kept for later starts', async (t) => {
  const { scheduler, sent, store } = setup(t, { context: null, automations: [automation({ nextRun: Date.now() - 1000 })] });
  await scheduler.check();
  assert.equal(sent.length, 0);
  assert.throws(() => scheduler.setContext({ systemPrompts: { working: 'x' } }), (error) => error.code === 'INVALID_CONTEXT');
  assert.throws(() => scheduler.setContext({ systemPrompts: { working: 'x', coding: 'y'.repeat(300 * 1024) } }), (error) => error.code === 'INVALID_CONTEXT');
  assert.deepEqual(scheduler.setContext({ ...CONTEXT, temperature: 9, reasoning: { effort: 'max' } }), { saved: true });
  await scheduler.whenIdle();
  assert.equal(sent.length, 1, 'the instructions let the waiting run go');
  assert.equal(Object.hasOwn(sent[0], 'temperature'), false, 'an impossible temperature is dropped');
  assert.deepEqual(sent[0].reasoning, { thinking: true, effort: 'medium' });
  assert.deepEqual(store.readAll().automationContext.systemPrompts, CONTEXT.systemPrompts);
  // Never readable through the window's store bridge (not a public key).
  assert.throws(() => store.get('automationContext'), /not publicly accessible/);
});

test('with Preferences > Automations off, runs wait for a window and then run once', async (t) => {
  const { scheduler, sent, state } = setup(t, {
    automations: [automation({ nextRun: Date.now() - 3 * 86400000 })],
    settings: { automationsInBackground: false },
    windowOpen: false,
  });
  await scheduler.check();
  assert.equal(sent.length, 0);
  assert.equal(scheduler.state().background, false);
  state.windowOpen = true;
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
});

test('runs fire with no window open by default', async (t) => {
  const { scheduler, sent } = setup(t, { automations: [automation({ nextRun: Date.now() - 1000 })], windowOpen: false });
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
  assert.equal(scheduler.state().background, true);
});

test('a call that needs approval with no window open is denied and named under the reply', async (t) => {
  const { scheduler, saved } = setup(t, {
    reply: (input, self) => {
      assert.equal(self.owns(input.requestId), true);
      assert.equal(self.unattended(input.requestId, 'Workspace · write_file'), true);
      assert.equal(self.unattended(input.requestId, 'Workspace · write_file'), true);
      assert.equal(self.unattended(input.requestId, 'GitHub · create_issue'), true);
      assert.equal(self.unattended('chat-request-1', 'Workspace · write_file'), false, 'a chat reply is not an automation run');
      return { text: 'I could not write the file.' };
    },
  });
  await scheduler.runNow('a1');
  const answer = saved().tasks[0].messages[1].text;
  assert.equal(answer, 'I could not write the file.\n\n[Note from ScaleMax: 3 tool calls needed your approval, but no ScaleMax window was open to ask in, so they were denied: Workspace · write_file (2×), GitHub · create_issue. Open ScaleMax and choose Run now to approve them.]');
  assert.equal(scheduler.owns('automation-a1-0'), false);
});

test('an automation deleted while it ran keeps its run in its task and stays deleted', async (t) => {
  const { scheduler, saved, store } = setup(t, {
    reply: () => {
      store.update((draft) => { draft.automations = []; });
      return { text: 'done' };
    },
  });
  await scheduler.runNow('a1');
  assert.deepEqual(saved().automations, []);
  assert.equal(saved().tasks[0].messages.length, 2);
});

test('a run whose calls were denied with no window open is recorded as denied, not as a success', async (t) => {
  const { scheduler, saved, record, notices } = setup(t, {
    reply: (input, self) => {
      self.unattended(input.requestId, 'Workspace · write_file');
      return { text: 'I could not change CHANGELOG.md.' };
    },
  });
  assert.deepEqual(await scheduler.runNow('a1'), { status: 'denied', message: '1 tool call denied: no window was open' });
  assert.equal(record().lastStatus, 'denied');
  assert.equal(record().lastError, '');
  const [entry] = record().history;
  assert.equal(entry.status, 'denied');
  assert.equal(entry.note, '1 tool call denied: no window was open');
  assert.match(entry.preview, /^I could not change CHANGELOG\.md\./);
  // The reply (and the note naming the denied call) still reach its task.
  const [task] = saved().tasks;
  assert.equal(task.messages.length, 2);
  assert.match(task.messages[1].text, /^I could not change CHANGELOG\.md\.\n\n\[Note from ScaleMax: a tool call needed your approval/);
  const last = notices.at(-1);
  assert.deepEqual(last.finished, { id: 'a1', name: 'Digest', status: 'denied', manual: true, note: '1 tool call denied: no window was open' });
  assert.equal(last.run.messages.length, 2);
});

test('a call the user denied in the window makes the run denied too; other replies are not counted', async (t) => {
  const { scheduler, record } = setup(t, {
    reply: (input, self) => {
      assert.equal(self.refused(input.requestId, 'Workspace · write_file', 'user'), true);
      assert.equal(self.refused('chat-request-1', 'Workspace · write_file', 'user'), false, 'a chat reply is not an automation run');
      return { text: 'Denied, so nothing changed.' };
    },
  });
  const outcome = await scheduler.runNow('a1');
  assert.equal(outcome.status, 'denied');
  assert.equal(record().history[0].note, '1 tool call denied: by you');
  assert.equal(record().lastStatus, 'denied');
});

test('a run knows its automation\'s name and the permission it works under', async (t) => {
  const seen = [];
  const { scheduler } = setup(t, {
    automations: [automation({ permission: 'bypass', bypassConsent: true }), automation({ id: 'a2', name: 'Plain' })],
    reply: (input, self) => {
      seen.push(self.info(input.requestId));
      return { text: 'ok' };
    },
  });
  await scheduler.runNow('a1');
  await scheduler.runNow('a2');
  assert.deepEqual(seen, [{ name: 'Digest', permission: 'bypass' }, { name: 'Plain', permission: null }]);
  assert.equal(scheduler.info('automation-a1-0'), null, 'nothing once the run ended');
  assert.equal(scheduler.info(undefined), null);
  // Bypass only with the consent the window recorded for this automation.
  assert.equal(runPermission({ permission: 'bypass' }), 'basic');
  assert.equal(runPermission({ permission: 'bypass', bypassConsent: true }), 'bypass');
  assert.equal(runPermission({ permission: 'plan' }), 'plan');
  assert.equal(runPermission({ permission: 'everything' }), null);
  assert.equal(runPermission({}), null);
  assert.equal(runPermission(null), null);
});

test('the denied note says how many calls and why', () => {
  assert.equal(deniedSummary([], []), '');
  assert.equal(deniedSummary(['Workspace · write_file'], []), '1 tool call denied: no window was open');
  assert.equal(deniedSummary(['a', 'b', 'c'], []), '3 tool calls denied: no window was open');
  assert.equal(deniedSummary([], [{ label: 'a', how: 'user' }]), '1 tool call denied: by you');
  assert.equal(deniedSummary([], [{ label: 'a', how: 'timeout' }, { label: 'b', how: 'timeout' }]), '2 tool calls denied: nobody answered');
  assert.equal(deniedSummary(['a'], [{ label: 'b', how: 'user' }]), '2 tool calls denied: 1 by you, 1 no window was open');
  assert.equal(deniedSummary([], [{ label: 'a', how: 'closed' }, { label: 'b', how: 'user' }]), '2 tool calls denied: 1 the window closed, 1 by you');
});

test('deleting an automation in the window while it runs stops its run, which records nothing', async (t) => {
  const cancelled = [];
  let release;
  const { scheduler, saved, notices } = setup(t, {
    cancel: (requestId) => { cancelled.push(requestId); release(); return true; },
    // The request stays out until it is cancelled (provider:cancel rejects it, like Stop).
    reply: () => new Promise((_resolve, reject) => {
      release = () => reject(Object.assign(new Error('Provider request was cancelled.'), { code: 'CANCELLED' }));
      // The window deletes it while the request is out.
      setImmediate(() => scheduler.fromWindow('automations', []));
    }),
  });
  const outcome = await scheduler.runNow('a1');
  assert.deepEqual(outcome, { status: 'error', code: 'CANCELLED', message: 'Stopped: the automation was deleted.' });
  assert.equal(cancelled.length, 1);
  assert.match(cancelled[0], /^automation-a1-\d+$/);
  assert.deepEqual(saved().automations, []);
  assert.equal(saved().tasks, undefined, 'nothing appended to any task');
  assert.equal(notices.at(-1).finished.code, 'CANCELLED');
  assert.equal(notices.at(-1).run, undefined);
  // A request that answers anyway after the delete is dropped too.
  const late = setup(t, {
    reply: (input, self) => {
      self.fromWindow('automations', []);
      return { text: 'done anyway' };
    },
  });
  assert.equal((await late.scheduler.runNow('a1')).code, 'CANCELLED');
  assert.equal(late.saved().tasks, undefined);
});

// ---- The hand-off: the window and main write the same keys ------------------------------

test('a tasks snapshot the window took before a run never drops the run; once it shows it, main stops adding it', async (t) => {
  const mine = { id: 'task-mine', title: 'My chat', messages: [{ role: 'user', text: 'hello', time: 1 }], createdAt: 1, updatedAt: 1 };
  const { scheduler, saved, notices } = setup(t, { tasks: [mine] });
  await scheduler.runNow('a1');
  const run = notices.at(-1).run;
  // The window's queued snapshot from before the run, plus its own new message.
  const stale = [{ ...mine, messages: [...mine.messages, { role: 'assistant', text: 'hi', time: 2 }] }];
  scheduler.fromWindow('tasks', stale);
  const [added, chat] = saved().tasks;
  assert.equal(added.id, run.task.id, 'the run\'s task is put back, first like a new task');
  assert.deepEqual(added.messages, run.messages);
  assert.equal(chat.messages.length, 2, 'and the window\'s own change is kept');
  // The window merged the run (src/scheduler.js mergeRun) and saved: from now on what it writes
  // stands, a deleted task included.
  scheduler.fromWindow('tasks', [{ ...run.task, messages: run.messages }, stale[0]]);
  scheduler.fromWindow('tasks', [stale[0]]);
  assert.deepEqual(saved().tasks.map((task) => task.id), ['task-mine']);
});

test('a window that opens hears about runs it has not saved back yet', async (t) => {
  const { scheduler } = setup(t);
  assert.deepEqual(scheduler.state().runs, []);
  await scheduler.runNow('a1');
  const { runs, automations, running, background } = scheduler.state();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].messages.length, 2);
  assert.equal(automations[0].lastStatus, 'success');
  assert.deepEqual(running, []);
  assert.equal(background, true);
  scheduler.fromWindow('tasks', [{ ...runs[0].task, messages: runs[0].messages }]);
  assert.deepEqual(scheduler.state().runs, [], 'saved back: nothing left to hand over');
});

test('a run appended to a task the window has is added at the end of that task', async (t) => {
  const { scheduler, saved, notices } = setup(t);
  await scheduler.runNow('a1');
  const first = notices.at(-1).run;
  // The window has the task with the first run and something else; a second run happens.
  const known = { ...first.task, messages: first.messages };
  scheduler.fromWindow('tasks', [known]);
  await scheduler.runNow('a1');
  scheduler.fromWindow('tasks', [known]);
  const [task] = saved().tasks;
  assert.equal(task.messages.length, 4);
  assert.deepEqual(task.messages.slice(2), notices.at(-1).run.messages);
  assert.ok(task.updatedAt >= notices.at(-1).run.task.updatedAt);
});

test('a stale copy of the automations never rolls back a schedule main already ran', async (t) => {
  const due = Date.now() - 1000;
  const { scheduler, sent, record, notices } = setup(t, { automations: [automation({ nextRun: due, editedAt: 100 })] });
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1);
  const advanced = record().nextRun;
  assert.ok(advanced > Date.now());
  // The window writes what it had before the run (it renamed another automation meanwhile).
  const stale = [automation({ nextRun: due, editedAt: 100, name: 'Digest' }), automation({ id: 'a2', name: 'New', editedAt: Date.now() })];
  notices.length = 0;
  scheduler.fromWindow('automations', stale);
  assert.equal(record().nextRun, advanced, 'the slot that ran is not due again');
  assert.equal(record().history.length, 1);
  assert.equal(record().lastStatus, 'success');
  assert.equal(record('a2').name, 'New', 'a new automation is taken as it is');
  assert.equal(notices.length, 1, 'the window hears what it missed');
  await scheduler.check();
  await scheduler.whenIdle();
  assert.equal(sent.length, 1, 'never run twice');
  // An edit (newer editedAt) decides the schedule: paused here, it stays paused.
  scheduler.fromWindow('automations', [{ ...record(), name: 'Renamed', active: false, editedAt: Date.now() + 1 }]);
  assert.equal(record().active, false);
  assert.equal(record().name, 'Renamed');
  assert.equal(record().history.length, 1, 'how its runs went stays main\'s');
  assert.equal(record('a2'), undefined, 'deleted in the window');
});

test('the merge keeps the window\'s copy of records main never ran', () => {
  const legacy = { id: 'old', name: 'Old', prompt: 'x', schedule: 'daily', time: '09:00', active: true, nextRun: 5 };
  const normalized = { ...legacy, active: false, schemaVersion: 2, nextRun: null };
  assert.deepEqual(mergeAutomations([legacy], [normalized]), [normalized], 'paused by the window when it was upgraded');
  const running = automation({ lastStatus: 'running' });
  const reviewed = automation({ lastStatus: 'interrupted', active: false });
  assert.deepEqual(mergeAutomations([running], [reviewed]), [reviewed]);
  assert.equal(mergeAutomations(null, 'not a list'), 'not a list');
});

test('the window\'s writes of other keys are not touched, and bad lists are refused by the store', (t) => {
  const { scheduler, store } = setup(t);
  assert.equal(scheduler.merges('tasks'), true);
  assert.equal(scheduler.merges('automations'), true);
  assert.equal(scheduler.merges('settings'), false);
  assert.throws(() => scheduler.fromWindow('automations', { not: 'a list' }), /automations must be an array/);
  assert.equal(store.readAll().automations.length, 1);
});
