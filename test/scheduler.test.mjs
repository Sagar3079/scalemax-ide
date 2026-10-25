import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startScheduler, mergeAutomations, mergeRun, automationContext, automationStatusLabel, automationHistoryLine,
  automationPermissionHint, automationFolderChoices, automationStatusLine,
} from '../src/scheduler.js';
import { normalizeAutomations } from '../src/domain.mjs';

// The window's side of automations: main fires them (lib/automations.cjs, tested in
// test/automations.test.cjs); the window sends the instructions, asks for Run now and takes in
// what main tells it.

function automation(overrides = {}) {
  return {
    id: 'a1', name: 'Digest', prompt: 'Summarize', schedule: 'daily', time: '09:00',
    dayOfWeek: 1, dayOfMonth: 1, intervalMinutes: null, runAt: null,
    active: true, createdAt: 0, nextRun: Date.now() + 3600000, pendingCatchUp: false,
    lastRun: null, lastStatus: 'idle', lastError: '', history: [], schemaVersion: 2,
    ...overrides,
  };
}

// A stand-in for preload.js `automations` (main's answers are given or recorded).
function fakeBridge({ runNow = { ok: true, data: { status: 'success' } }, running = [] } = {}) {
  const calls = { runNow: [], setContext: [], listeners: [] };
  return {
    calls,
    emit: (change) => calls.listeners.forEach((listener) => listener(change)),
    api: {
      state: async () => ({ ok: true, data: { running, background: true } }),
      runNow: async (input) => { calls.runNow.push(input); return typeof runNow === 'function' ? runNow(input) : runNow; },
      setContext: async (input) => { calls.setContext.push(structuredClone(input)); return { ok: true, data: { saved: true } }; },
      onChanged: (listener) => {
        calls.listeners.push(listener);
        return () => { calls.listeners = calls.listeners.filter((item) => item !== listener); };
      },
    },
  };
}

function fakeApp({ automations = [automation()], tasks = [], settings = {} } = {}) {
  return {
    automations,
    tasks,
    currentTaskId: null,
    unreadTasks: new Set(),
    settings: { mode: 'working', systemPrompt: '', temperature: 0.7, temperatureEnabled: false, permission: 'basic', ...settings },
    provider: { configured: true },
    saveQueue: Promise.resolve(),
    persisted: [],
    toasts: [],
    rendered: 0,
    persist(key) { this.persisted.push(key); return Promise.resolve(); },
    renderAutomations() { this.rendered += 1; },
    renderTasks() {},
    renderChat() { this.chatRendered = true; },
    showToast(message) { this.toasts.push(message); },
  };
}

function withBridge(t, bridge) {
  globalThis.window = { scalemaxAPI: { automations: bridge.api } };
  t.after(() => { delete globalThis.window; });
}

test('the instructions for runs are the chat\'s, for both modes, without a temperature unless it is on', () => {
  const app = fakeApp({ settings: { systemPrompt: 'Be brief.' } });
  const context = automationContext(app);
  assert.match(context.systemPrompts.working, /Working mode/);
  assert.match(context.systemPrompts.coding, /Coding mode/);
  assert.match(context.systemPrompts.coding, /User system instructions:\nBe brief\./);
  assert.deepEqual(context.reasoning, { thinking: true, effort: 'medium' });
  assert.equal(Object.hasOwn(context, 'temperature'), false);
  app.settings.temperatureEnabled = true;
  app.settings.temperature = 0.3;
  assert.equal(automationContext(app).temperature, 0.3);
  // The window's own builder (with the custom catalogs) is used when there is one.
  app.buildSystemPrompt = (settings) => `custom ${settings.mode}`;
  assert.deepEqual(automationContext(app).systemPrompts, { working: 'custom working', coding: 'custom coding' });
});

test('main\'s copy of an automation replaces the window\'s unless the window changed it since', () => {
  const own = [
    automation({ id: 'a1', editedAt: 10 }),
    automation({ id: 'a2', editedAt: 50, name: 'Edited here' }),
    automation({ id: 'a3', name: 'Just made here' }),
  ];
  const main = [
    automation({ id: 'a1', editedAt: 10, lastStatus: 'success', history: [{ time: 5, status: 'success', preview: 'ok' }] }),
    automation({ id: 'a2', editedAt: 20, lastStatus: 'error' }),
    automation({ id: 'gone', name: 'Deleted here' }),
  ];
  const merged = mergeAutomations(own, main);
  assert.deepEqual(merged.map((item) => item.id), ['a1', 'a2', 'a3'], 'one only main has was just deleted here');
  assert.equal(merged[0].lastStatus, 'success');
  assert.equal(merged[0].history.length, 1);
  assert.equal(merged[1].name, 'Edited here', 'its save is still on the way to main');
  assert.equal(merged[2].name, 'Just made here');
});

test('a run\'s messages are added to its task once, and its task is made when the window has none', () => {
  const run = {
    runId: 'automation-a1-1',
    task: { id: 'task-1', title: 'Automation · Digest', createdAt: 1, updatedAt: 3, automationId: 'a1', folder: { name: 'reports', path: '/Users/you/reports' } },
    messages: [
      { role: 'user', text: 'Summarize', time: 1, run: 'automation-a1-1' },
      { role: 'assistant', text: 'Done.', time: 3, run: 'automation-a1-1', tools: [{ server: 'Workspace', tool: 'read_file', ok: true, preview: 'x' }], steps: [{ type: 'tool', title: 'Read a.txt', ok: true }], junk: true },
    ],
  };
  const tasks = [{ id: 'task-mine', title: 'Mine', messages: [], createdAt: 0, updatedAt: 0 }];
  const task = mergeRun(tasks, run);
  assert.equal(tasks[0], task, 'listed first, like a new task');
  assert.deepEqual(task.folder, { name: 'reports', path: '/Users/you/reports' });
  assert.equal(task.automationId, 'a1');
  assert.deepEqual(task.messages.map((message) => [message.role, message.text, message.run]), [
    ['user', 'Summarize', 'automation-a1-1'], ['assistant', 'Done.', 'automation-a1-1'],
  ]);
  assert.deepEqual(task.messages[1].tools, [{ server: 'Workspace', tool: 'read_file', ok: true }]);
  assert.equal(task.messages[1].steps.length, 1);
  assert.equal('junk' in task.messages[1], false);
  mergeRun(tasks, run);
  assert.equal(task.messages.length, 2, 'never twice');
  assert.equal(mergeRun(tasks, { task: { id: 1 } }), null);
});

test('what main says after a run reaches the lists, the task and a toast', async (t) => {
  const bridge = fakeBridge();
  withBridge(t, bridge);
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  assert.equal(bridge.calls.setContext.length, 1, 'the instructions go to main at once');
  bridge.emit({ automations: [automation({ lastStatus: 'success', history: [{ time: 1, status: 'success', preview: 'Done.' }] })], running: ['a1'] });
  assert.equal(app.automations[0].lastStatus, 'success');
  bridge.emit({
    automations: normalizeAutomations([automation({ lastStatus: 'success' })]),
    running: [],
    finished: { id: 'a1', name: 'Digest', status: 'success', manual: false },
    run: { runId: 'automation-a1-1', task: { id: 'task-1', title: 'Automation · Digest', createdAt: 1, updatedAt: 2, automationId: 'a1' }, messages: [{ role: 'user', text: 'Summarize', time: 1, run: 'automation-a1-1' }] },
  });
  assert.equal(app.tasks[0].id, 'task-1');
  assert.deepEqual(app.persisted, ['tasks'], 'saved at once, so main stops adding the run');
  assert.equal(app.unreadTasks.has('task-1'), true);
  assert.deepEqual(app.toasts, ['Automation finished: Digest']);
  bridge.emit({ automations: [], running: [], finished: { id: 'a1', name: 'Digest', status: 'error', message: 'Rate limited', manual: false } });
  assert.equal(app.toasts.at(-1), 'Automation failed: Digest — Rate limited');
  bridge.emit({ running: [], finished: { id: 'a1', name: 'Digest', status: 'error', code: 'PROVIDER_NOT_CONFIGURED', manual: true } });
  assert.equal(app.toasts.length, 2, 'Run now says that one itself');
  assert.ok(app.rendered >= 3);
});

test('a window that opens takes in the runs it missed, once', async (t) => {
  const run = {
    runId: 'automation-a1-1',
    task: { id: 'task-1', title: 'Automation · Digest', createdAt: 1, updatedAt: 2, automationId: 'a1' },
    messages: [{ role: 'user', text: 'Summarize', time: 1, run: 'automation-a1-1' }, { role: 'assistant', text: 'Done.', time: 2, run: 'automation-a1-1' }],
  };
  const bridge = fakeBridge();
  bridge.api.state = async () => ({ ok: true, data: { running: ['a1'], background: true, automations: [automation({ lastStatus: 'success' })], runs: [run, run] } });
  withBridge(t, bridge);
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  assert.equal(app.automations[0].lastStatus, 'success');
  assert.equal(app.tasks.length, 1);
  assert.equal(app.tasks[0].messages.length, 2, 'never twice');
  assert.deepEqual(app.toasts, [], 'no toast for what happened before');
});

test('run now goes through main, after the window\'s queued saves', async (t) => {
  let saved = false;
  const bridge = fakeBridge({ runNow: () => ({ ok: true, data: saved ? { status: 'success' } : { status: 'error' } }) });
  withBridge(t, bridge);
  const app = fakeApp();
  app.saveQueue = new Promise((resolve) => setTimeout(() => { saved = true; resolve(); }, 20));
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  assert.equal(await scheduler.runNow('a1'), 'success');
  assert.deepEqual(bridge.calls.runNow, [{ id: 'a1' }]);
  bridge.api.runNow = async () => ({ ok: true, data: { status: 'error', code: 'PROVIDER_NOT_CONFIGURED' } });
  assert.equal(await scheduler.runNow('a1'), 'error');
  assert.equal(app.toasts.at(-1), 'Connect a provider in Assistant first');
  bridge.api.runNow = async () => ({ ok: false, error: { message: 'That automation no longer exists.' } });
  assert.equal(await scheduler.runNow('a1'), 'error');
  assert.equal(app.toasts.at(-1), 'That automation no longer exists.');
});

test('the instructions are sent again only when they change', async (t) => {
  const bridge = fakeBridge();
  withBridge(t, bridge);
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  scheduler.pushContext();
  assert.equal(bridge.calls.setContext.length, 1);
  app.settings.systemPrompt = 'Answer in French.';
  scheduler.pushContext();
  assert.equal(bridge.calls.setContext.length, 2);
  assert.match(bridge.calls.setContext[1].systemPrompts.working, /Answer in French\./);
});

test('without the desktop app Run now says so and nothing else runs', async (t) => {
  globalThis.window = { scalemaxAPI: {} };
  t.after(() => { delete globalThis.window; });
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  assert.equal(await scheduler.runNow('a1'), 'error');
  assert.deepEqual(app.toasts, ['Automations need the desktop app']);
});

test('the folder, the mode and when it was last edited survive a reload', () => {
  const [saved] = normalizeAutomations([automation({ folder: { name: 'reports', path: '/Users/you/reports' }, mode: 'coding', editedAt: 1234 })]);
  assert.deepEqual(saved.folder, { name: 'reports', path: '/Users/you/reports' });
  assert.equal(saved.mode, 'coding');
  assert.equal(saved.editedAt, 1234);
  const [broken] = normalizeAutomations([automation({ folder: 'relative/nope', mode: 'plan', editedAt: 'yesterday' })]);
  assert.equal(broken.folder, null);
  assert.equal(broken.mode, null);
  assert.equal('editedAt' in broken, false);
  // Made before automations remembered their folder: nothing recorded, which is not "no folder".
  const [legacy] = normalizeAutomations([automation()]);
  assert.equal('folder' in legacy, false);
});

test('a run whose tool calls were denied says it needs approval; a run stopped by a delete says nothing', async (t) => {
  const bridge = fakeBridge();
  withBridge(t, bridge);
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  bridge.emit({ running: [], finished: { id: 'a1', name: 'Digest', status: 'denied', manual: false, note: '1 tool call denied: by you' } });
  assert.deepEqual(app.toasts, ['Automation needs approval: Digest — 1 tool call denied: by you']);
  bridge.emit({ running: [], finished: { id: 'a1', name: 'Digest', status: 'error', code: 'CANCELLED', message: 'Stopped: the automation was deleted.' } });
  assert.equal(app.toasts.length, 1, 'the window said "Stopped and deleted" itself');
});

test('the status line can be redrawn on its own, and the window knows which automations run', async (t) => {
  const bridge = fakeBridge();
  withBridge(t, bridge);
  const node = { textContent: '' };
  globalThis.document = { querySelector: (selector) => (selector === '#scheduler-status' ? node : null) };
  t.after(() => { delete globalThis.document; });
  const app = fakeApp({ automations: [automation({ nextRun: Date.UTC(2030, 0, 1) })] });
  app.provider = { configured: false };
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  const rendered = app.rendered;
  assert.equal(node.textContent, 'Connect a provider in Assistant to run schedules.');
  // A provider connected in Assistant: the line follows without a scheduler event.
  app.provider = { configured: true };
  scheduler.refreshStatus();
  assert.match(node.textContent, /^Next run: Digest at /);
  // Paused in the window: no stale "Next run".
  app.automations[0].active = false;
  scheduler.refreshStatus();
  assert.equal(node.textContent, 'No schedules enabled.');
  assert.equal(app.rendered, rendered, 'refreshStatus never redraws the list (renderAutomations calls it)');
  assert.equal(scheduler.isRunning('a1'), false);
  bridge.emit({ running: ['a1'] });
  assert.equal(scheduler.isRunning('a1'), true);
  bridge.emit({ running: [] });
  assert.equal(scheduler.isRunning('a1'), false);
});

test('the Automation view names statuses, history lines, permissions and folder choices', () => {
  assert.equal(automationStatusLabel('denied'), 'Needs approval');
  assert.equal(automationStatusLabel('success'), 'success');
  assert.equal(automationStatusLabel(undefined), 'idle');
  const time = () => 'T';
  assert.equal(automationHistoryLine({ time: 1, status: 'denied', preview: 'Nothing changed.', note: '1 tool call denied: by you' }, time),
    'T · needs approval (1 tool call denied: by you) — Nothing changed.');
  assert.equal(automationHistoryLine({ time: 1, status: 'success', preview: 'Done.' }, time), 'T · success — Done.');
  assert.match(automationPermissionHint('bypass'), /without asking, also while no window is open/);
  assert.match(automationPermissionHint('basic'), /While no window is open, they are denied/);
  assert.equal(automationPermissionHint('nonsense'), automationPermissionHint('basic'));
  const choices = automationFolderChoices({
    current: { name: 'api', path: '/p/api' },
    recent: [{ name: 'api', path: '/p/api' }, { name: 'web', path: '/p/web' }, { path: '/p/docs' }, null],
    automations: [{ folder: { name: 'reports', path: '/p/reports' } }, { folder: null }, { folder: { name: 'web', path: '/p/web' } }],
  });
  assert.deepEqual(choices, [
    { name: 'api', path: '/p/api' }, { name: 'web', path: '/p/web' }, { name: 'docs', path: '/p/docs' }, { name: 'reports', path: '/p/reports' },
  ]);
});

test('a slot main is about to fire is shown as main has it, never moved on by the window', () => {
  // Due a second ago: main fires it now. The window used to move it to the next slot, so the run
  // that came a moment later looked early (and Run now, which sends the list, looked like it
  // shifted the schedule).
  const due = Date.now() - 1000;
  const [shown] = mergeAutomations([automation({ schedule: 'interval', intervalMinutes: 1, nextRun: due })],
    [automation({ schedule: 'interval', intervalMinutes: 1, nextRun: due })]);
  assert.equal(shown.nextRun, due);
  assert.equal(shown.pendingCatchUp, false);
  // Paused by main: no next run at all.
  const [paused] = mergeAutomations([automation()], [automation({ active: false, nextRun: due })]);
  assert.equal(paused.nextRun, null);
});

test('a row shows a run in progress as a state tag: running, or waiting for approval', async (t) => {
  const time = () => 'T';
  const row = automation({ lastStatus: 'success', lastRun: 1, nextRun: 2 });
  assert.deepEqual(automationStatusLine(row, null, time), { tag: null, text: 'success · Last: T · Next: T' });
  assert.deepEqual(automationStatusLine(row, 'running', time), { tag: { state: 'working', text: 'Running…' }, text: 'Last: T · Next: T' });
  assert.deepEqual(automationStatusLine(row, 'waiting', time), { tag: { state: 'waiting', text: 'Waiting for approval' }, text: 'Last: T · Next: T' });
  assert.equal(automationStatusLine(automation({ active: false }), null, time).text, 'idle · Next: paused');
  // What main says about the run in progress.
  const bridge = fakeBridge();
  withBridge(t, bridge);
  const node = { textContent: '' };
  globalThis.document = { querySelector: (selector) => (selector === '#scheduler-status' ? node : null) };
  t.after(() => { delete globalThis.document; });
  const app = fakeApp();
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  assert.equal(scheduler.liveState('a1'), null);
  bridge.emit({ running: ['a1'], waiting: [] });
  assert.equal(scheduler.liveState('a1'), 'running');
  assert.match(node.textContent, /^Running: Digest…/);
  bridge.emit({ running: ['a1'], waiting: ['a1'] });
  assert.equal(scheduler.liveState('a1'), 'waiting');
  assert.match(node.textContent, /^Waiting for your approval: Digest · Next run/);
  bridge.emit({ running: [], waiting: [] });
  assert.equal(scheduler.liveState('a1'), null);
});
