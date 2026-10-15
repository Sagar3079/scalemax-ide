import test from 'node:test';
import assert from 'node:assert/strict';
import { startScheduler } from '../src/scheduler.js';
import { normalizeAutomations } from '../src/domain.mjs';

// Minimal stand-in for the renderer app object the scheduler drives.
function fakeApp({ automations = [], send, settings = {} } = {}) {
  const sent = [];
  const app = {
    automations,
    tasks: [],
    currentTaskId: null,
    settings: { systemPrompt: '', temperature: 0.7, temperatureEnabled: false, ...settings },
    provider: { configured: true },
    persisted: [],
    toasts: [],
    sent,
    getProviderBridge: () => ({
      send: async (payload) => {
        sent.push(payload);
        return send ? send(payload) : { ok: true, data: { text: `reply ${sent.length}` } };
      },
    }),
    persist(key) { this.persisted.push(key); return Promise.resolve(); },
    renderAutomations() {},
    renderTasks() {},
    renderChat() {},
    showToast(message) { this.toasts.push(message); },
    makeTask(title) { return { id: `t-${this.tasks.length + 1}`, title, messages: [], createdAt: 0, updatedAt: 0 }; },
    // Like src/app.js: a user message fixes a task without a folder to the open one, unless the
    // caller says not to.
    workspace: { root: '' },
    appendMessage(role, text, taskId, extra = {}) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (role === 'user' && !task.messages.some((m) => m.role === 'user')) task.title = text;
      if (role === 'user' && !task.folder && this.workspace.root && extra.bindFolder !== false) {
        task.folder = { name: this.workspace.root.split('/').pop(), path: this.workspace.root };
      }
      task.messages.push({ role, text, time: Date.now() });
      return true;
    },
  };
  return app;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function automation(overrides = {}) {
  return {
    id: 'a1', name: 'Digest', prompt: 'Summarize', schedule: 'daily', time: '09:00',
    dayOfWeek: 1, dayOfMonth: 1, intervalMinutes: null, runAt: null,
    active: true, createdAt: 0, nextRun: Date.now() + 3600000, pendingCatchUp: false,
    lastRun: null, lastStatus: 'idle', lastError: '', history: [], schemaVersion: 2,
    ...overrides,
  };
}

test('run now sends once, records history and appends to the automation task', async (t) => {
  const app = fakeApp({ automations: [automation()], settings: { systemPrompt: 'Be brief.', temperature: 0.3, temperatureEnabled: true } });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  const before = app.automations[0].nextRun;
  assert.equal(await scheduler.runNow('a1'), 'success');
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0].systemPrompt, /User system instructions:\nBe brief\./);
  assert.equal(app.sent[0].temperature, 0.3);
  const [entry] = app.automations[0].history;
  assert.equal(entry.status, 'success');
  assert.equal(entry.preview, 'reply 1');
  assert.equal(app.automations[0].nextRun, before, 'manual run leaves the schedule alone');
  assert.equal(app.tasks[0].title, 'Automation · Digest');
  assert.deepEqual(app.tasks[0].messages.map((m) => m.role), ['user', 'assistant']);
});

test('temperature is omitted when disabled', async (t) => {
  const app = fakeApp({ automations: [automation()] });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.runNow('a1');
  assert.equal(Object.hasOwn(app.sent[0], 'temperature'), false);
});

test('a schedule missed many times while closed catches up exactly once', async (t) => {
  const now = Date.now();
  const restored = normalizeAutomations([automation({ nextRun: now - 10 * 86400000 })], now);
  assert.equal(restored[0].pendingCatchUp, true);
  const app = fakeApp({ automations: restored });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  await scheduler.checkNow();
  await scheduler.checkNow();
  assert.equal(app.sent.length, 1);
  assert.equal(app.automations[0].pendingCatchUp, false);
  assert.ok(app.automations[0].nextRun > now);
});

test('overlapping checks and run-now never double-run the same automation', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = fakeApp({
    automations: [automation({ nextRun: Date.now() - 1000 })],
    send: async () => { await gate; return { ok: true, data: { text: 'done' } }; },
  });
  const scheduler = startScheduler(app); // startup check claims the due run
  t.after(() => scheduler.stop());
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = scheduler.checkNow();
  const manual = await scheduler.runNow('a1');
  assert.equal(manual, 'skipped');
  release();
  await overlapping;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.sent.length, 1);
  assert.equal(app.automations[0].history.length, 1);
});

test('a failed run records the error in status and history', async (t) => {
  const app = fakeApp({
    automations: [automation()],
    send: async () => ({ ok: false, error: { message: 'Rate limited' } }),
  });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  assert.equal(await scheduler.runNow('a1'), 'error');
  assert.equal(app.automations[0].lastStatus, 'error');
  assert.equal(app.automations[0].lastError, 'Rate limited');
  assert.equal(app.automations[0].history[0].status, 'error');
});

test('a one-time schedule deactivates after it fires', async (t) => {
  const app = fakeApp({ automations: [automation({ schedule: 'once', runAt: Date.now() - 1, nextRun: Date.now() - 1 })] });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.checkNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.sent.length, 1);
  assert.equal(app.automations[0].active, false);
  assert.equal(app.automations[0].nextRun, null);
});

test('a run works in the folder and mode the automation was made in, never in whatever is open', async (t) => {
  const folder = { name: 'reports', path: '/Users/you/reports' };
  const app = fakeApp({
    automations: [automation({ folder, mode: 'coding' }), automation({ id: 'a2', name: 'Digest', folder: null, mode: null })],
    settings: { mode: 'working' },
  });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  await scheduler.runNow('a1');
  await scheduler.runNow('a2');
  assert.equal(app.sent[0].folder, '/Users/you/reports');
  assert.equal(app.sent[0].mode, 'coding', 'its own mode, not the one on screen');
  assert.match(app.sent[0].systemPrompt, /Coding/);
  // Made without a folder: no file tools at all (null), not the folder open at the time.
  assert.equal(app.sent[1].folder, null);
  assert.equal(app.sent[1].mode, 'working');
  // Two automations with the same name keep their own tasks, and the first sits in its project.
  assert.equal(app.tasks.length, 2);
  const first = app.tasks.find((task) => task.automationId === 'a1');
  const second = app.tasks.find((task) => task.automationId === 'a2');
  assert.ok(first && second && first !== second);
  assert.deepEqual(first.folder, folder);
  assert.equal(second.folder, undefined);
  // The next run of a1 lands in the same task.
  await scheduler.runNow('a1');
  assert.equal(first.messages.length, 4);
});

test('the folder and mode survive a reload', () => {
  const [saved] = normalizeAutomations([automation({ folder: { name: 'reports', path: '/Users/you/reports' }, mode: 'coding' })]);
  assert.deepEqual(saved.folder, { name: 'reports', path: '/Users/you/reports' });
  assert.equal(saved.mode, 'coding');
  const [broken] = normalizeAutomations([automation({ folder: 'relative/nope', mode: 'plan' })]);
  assert.equal(broken.folder, null);
  assert.equal(broken.mode, null);
  // Made before automations remembered their folder: nothing recorded, which is not "no folder".
  const [legacy] = normalizeAutomations([automation()]);
  assert.equal('folder' in legacy, false);
});

test('an automation from before folders were remembered keeps the open folder', async (t) => {
  const app = fakeApp({ automations: [automation()] });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.ready;
  await scheduler.runNow('a1');
  assert.equal('folder' in app.sent[0], false, 'no folder in the request: main uses the open one');
});

test('an interval schedule keeps its rhythm instead of drifting with the poll', async (t) => {
  const now = Date.now();
  const due = now - 1000;
  const missed = now - 25 * 60000;
  const app = fakeApp({
    automations: [
      automation({ schedule: 'interval', intervalMinutes: 10, nextRun: due }),
      automation({ id: 'a2', schedule: 'interval', intervalMinutes: 10, nextRun: missed }),
    ],
  });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.checkNow();
  await tick();
  // Stepped from the slot that came due, not from when the poll noticed it.
  assert.equal(app.automations[0].nextRun, due + 10 * 60000);
  // Slots that passed meanwhile are skipped (one run), and the next one stays on the grid.
  assert.equal(app.automations[1].nextRun, missed + 30 * 60000);
  assert.equal(app.sent.length, 2);
});

test('a run that comes due while another runs starts at once, never twice for the same automation', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = fakeApp({
    automations: [automation({ nextRun: Date.now() - 1000 }), automation({ id: 'a2', name: 'Other', nextRun: Date.now() + 3600000 })],
    send: async (payload) => {
      if (payload.requestId.startsWith('automation-a1-')) await gate;
      return { ok: true, data: { text: 'done' } };
    },
  });
  const scheduler = startScheduler(app); // the startup check starts a1, which keeps working
  t.after(() => scheduler.stop());
  await tick();
  app.automations[1].nextRun = Date.now() - 1;
  app.automations[0].nextRun = Date.now() - 1; // due again while its first run still works
  await scheduler.checkNow();
  assert.equal(app.automations[1].lastStatus, 'success', 'a2 ran while a1 was still working');
  assert.deepEqual(app.sent.map((payload) => payload.requestId.split('-')[1]), ['a1', 'a2']);
  release();
  await tick();
  await scheduler.checkNow();
  assert.equal(app.sent.filter((payload) => payload.requestId.startsWith('automation-a1-')).length, 2,
    'a1 runs again only once its first run ended');
});

test('start-up catch-up skips an automation check() already ran since start-up', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const now = Date.now();
  const app = fakeApp({
    automations: [
      automation({ pendingCatchUp: true, nextRun: now + 3600000 }),
      // Its next slot is due while the first catch-up still works, so check() runs it.
      automation({ id: 'a2', name: 'Other', pendingCatchUp: true, nextRun: now - 1 }),
    ],
    send: async (payload) => {
      if (payload.requestId.startsWith('automation-a1-')) await gate;
      return { ok: true, data: { text: 'done' } };
    },
  });
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await tick();
  release();
  await scheduler.ready;
  assert.equal(app.sent.filter((payload) => payload.requestId.startsWith('automation-a2-')).length, 1);
  assert.equal(app.sent.filter((payload) => payload.requestId.startsWith('automation-a1-')).length, 1);
});

test('the task of an automation made without a folder is not tied to the open folder', async (t) => {
  const app = fakeApp({ automations: [automation({ folder: null }), automation({ id: 'a2', name: 'Legacy' })] });
  app.workspace.root = '/Users/you/open';
  const scheduler = startScheduler(app);
  t.after(() => scheduler.stop());
  await scheduler.runNow('a1');
  await scheduler.runNow('a2');
  assert.equal(app.tasks.find((task) => task.automationId === 'a1').folder, undefined);
  // Made before automations remembered their folder: it ran in the open folder, as before.
  assert.equal(app.tasks.find((task) => task.automationId === 'a2').folder.path, '/Users/you/open');
});
