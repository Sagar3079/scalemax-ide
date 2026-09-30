import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt, searchItems, normalizeAutomations, nextRunAt,
  normalizeSettings, toTemperature, requestTemperature, requestReasoning, effectivePermission, normalizeTasks, PERMISSION_MODES,
  folderName, normalizeTaskFolder, isTaskLocked, taskFolderStatus, taskGroups, taskTime, toolCallGroups, toolActivity,
  MODE_IDS, MODE_TOOLS, modeInfo, modeSummary, normalizeMode,
  normalizeMetrics, normalizeCompaction, taskHistoryMessages, compactionMessages, compactionBoundary, compactionInput,
  automaticCompactionPlan, estimateTokens, metricsLabel, taskMetrics, taskMetricsLabel, COMPACTION_TAIL_MESSAGES,
} from '../src/domain.mjs';
import { EXPERTS, SKILLS, CONNECTORS, COMMUNITY_SKILLS } from '../src/data.js';

test('system prompt carries the base contract and the basic-permission default', () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /You are ScaleMax, an assistant/);
  assert.match(prompt, /Working mode/);
  assert.match(prompt, /Basic permission/);
  assert.match(prompt, /Never pretend tools executed/);
});

test('coding mode switches the mode paragraph', () => {
  const prompt = buildSystemPrompt({ mode: 'coding' });
  assert.match(prompt, /Coding mode/);
  assert.doesNotMatch(prompt, /Working mode/);
});

// ---- The mode shown in the composer (pills, chip, menu) ----

test('only the two modes exist and anything else is Working', () => {
  assert.deepEqual([...MODE_IDS], ['working', 'coding']);
  assert.equal(normalizeMode('coding'), 'coding');
  assert.equal(normalizeMode('Working'), 'working');
  assert.equal(normalizeMode(undefined), 'working');
  assert.equal(normalizeSettings({ mode: 'coding' }).mode, 'coding');
  assert.equal(normalizeSettings({ mode: 'nonsense' }).mode, 'working');
});

test('modeSummary names the tool families the mode can use', () => {
  assert.deepEqual([...MODE_TOOLS.working], ['Files', 'Web', 'Clipboard', 'Specs']);
  assert.deepEqual([...MODE_TOOLS.coding], ['Files', 'Web', 'Specs']);
  // Coding has no computer tools (lib/modes.cjs), so the clipboard is not offered there; writing a
  // feature down before building it belongs to both.
  assert.equal(modeSummary('working'), 'Files · Web · Clipboard · Specs');
  assert.equal(modeSummary('coding'), 'Files · Web · Specs');
  assert.equal(modeSummary('nonsense'), modeSummary('working'));
});

test('modeInfo gives each mode one short line for the pills and the menu', () => {
  for (const id of MODE_IDS) {
    const info = modeInfo(id);
    assert.equal(info.id, id);
    for (const key of ['label', 'note', 'desc', 'detail']) {
      assert.equal(typeof info[key], 'string');
      assert.ok(info[key].trim().length > 0, `${id} has a ${key}`);
      assert.ok(info[key].length <= 80, `${id} keeps ${key} short`);
    }
    assert.deepEqual(info.tools, [...MODE_TOOLS[id]]);
  }
  assert.equal(modeInfo('working').label, 'Working');
  assert.equal(modeInfo('coding').label, 'Coding');
  assert.match(modeInfo('coding').note, /runs your tests/);
  // The returned lists are copies: a caller cannot edit the shared labels.
  const info = modeInfo('working');
  info.tools.push('Nope');
  assert.deepEqual([...MODE_TOOLS.working], ['Files', 'Web', 'Clipboard', 'Specs']);
});

test('a selected expert contributes its prompt context', () => {
  const expert = EXPERTS.find((item) => item.id === 'security-auditor');
  const prompt = buildSystemPrompt({ expertId: 'security-auditor' });
  assert.match(prompt, /Selected expert: Security Auditor/);
  assert.ok(prompt.includes(expert.prompt));
});

test('an installed skill contributes its template with the input slot resolved', () => {
  const skill = SKILLS.find((item) => item.id === 'code-review');
  const prompt = buildSystemPrompt({ skillId: 'code-review' });
  assert.match(prompt, /Selected skill: Focused Code Review/);
  assert.ok(!prompt.includes('{{input}}'));
  assert.ok(prompt.includes(skill.prompt.split('{{input}}')[0].trim().slice(0, 60)));
});

test('the user system prompt is included and permissions map to distinct instructions', () => {
  const prompt = buildSystemPrompt({ systemPrompt: 'Always answer in one line.', permission: 'manual' });
  assert.match(prompt, /User system instructions:\nAlways answer in one line\./);
  assert.match(prompt, /Manual permission/);
  assert.match(buildSystemPrompt({ permission: 'bypass', bypassConsent: true }), /Autonomous mode/);
  // Bypass without recorded consent is only Basic.
  assert.match(buildSystemPrompt({ permission: 'bypass' }), /Basic permission/);
});

test('unknown expert and skill ids are ignored', () => {
  const prompt = buildSystemPrompt({ expertId: 'nope', skillId: 'nope' });
  assert.doesNotMatch(prompt, /Selected expert/);
  assert.doesNotMatch(prompt, /Selected skill/);
});

test('search covers task titles, task messages and every catalog', () => {
  const tasks = [{ id: 't1', title: 'Ship the parser', messages: [{ role: 'user', text: 'about tokenizers' }] }];
  assert.ok(searchItems('parser', tasks).some((item) => item.kind === 'task' && item.id === 't1'));
  assert.ok(searchItems('tokenizers', tasks).some((item) => item.kind === 'task' && item.id === 't1'));
  assert.ok(searchItems('security', tasks).some((item) => item.kind === 'expert'));
  assert.ok(searchItems('security', tasks).some((item) => item.kind === 'skill'));
  assert.ok(searchItems('github', tasks).some((item) => item.kind === 'connector'));
  assert.ok(searchItems('anthropic', tasks).some((item) => item.kind === 'community'));
  assert.deepEqual(searchItems('', tasks), []);
  assert.deepEqual(searchItems('zzzzz-no-match', tasks), []);
});

test('every expert injects its prompt context into the request', () => {
  assert.equal(EXPERTS.length, 8);
  for (const expert of EXPERTS) {
    const prompt = buildSystemPrompt({ expertId: expert.id });
    assert.ok(prompt.includes(`Selected expert: ${expert.name}`), `${expert.id} is named in the prompt`);
    assert.ok(prompt.includes(expert.prompt), `${expert.id} contributes its full prompt text`);
  }
});

test('every skill injects its template with the input slot resolved', () => {
  assert.equal(SKILLS.length, 30);
  for (const skill of SKILLS) {
    const prompt = buildSystemPrompt({ skillId: skill.id });
    assert.ok(prompt.includes(`Selected skill: ${skill.name}`), `${skill.id} is named in the prompt`);
    assert.ok(!prompt.includes('{{input}}'), `${skill.id} resolves the input slot`);
    const head = skill.prompt.split('{{input}}')[0].trim().slice(0, 60);
    assert.ok(prompt.includes(head), `${skill.id} contributes its template text`);
  }
});

test('selecting an expert and a skill together keeps both', () => {
  const prompt = buildSystemPrompt({ expertId: 'devops-engineer', skillId: 'unit-test-drafting' });
  assert.match(prompt, /Selected expert: DevOps Engineer/);
  assert.match(prompt, /Selected skill: Unit Test Drafting/);
});

test('every catalog record carries the fields the detail view renders', () => {
  for (const skill of SKILLS) {
    assert.equal(typeof skill.prompt, 'string');
    assert.ok(skill.prompt.length > 100, `${skill.id} prompt is substantive`);
  }
  for (const connector of CONNECTORS) {
    assert.equal(typeof connector.auth, 'string');
    assert.ok(Array.isArray(connector.setupSteps) && connector.setupSteps.length >= 2);
    assert.match(connector.docsUrl, /^https:\/\//);
  }
  for (const expert of EXPERTS) assert.equal(typeof expert.prompt, 'string');
  for (const entry of COMMUNITY_SKILLS) assert.match(entry.sourceUrl, /^https:\/\//);
});

test('weekly schedules resolve to the requested weekday in the future', () => {
  const now = Date.now();
  const next = nextRunAt({ schedule: 'weekly', time: '09:00', dayOfWeek: 3 }, now);
  assert.ok(next > now);
  assert.equal(new Date(next).getDay(), 3);
});

test('monthly schedules never roll into the next month', () => {
  const next = nextRunAt({ schedule: 'monthly', time: '08:30', dayOfMonth: 31 }, Date.UTC(2026, 0, 1));
  assert.equal(new Date(next).getDate(), 31);
});

test('legacy automations without day fields are normalised and paused', () => {
  const [automation] = normalizeAutomations([
    { id: 'a1', name: 'Legacy', prompt: 'ping', schedule: 'weekly', time: '09:00', active: true },
  ]);
  assert.equal(automation.schemaVersion, 2);
  assert.equal(automation.active, false);
  assert.equal(automation.dayOfWeek, 1);
});

// ---- Settings round-trip (TASK 1) ----

test('normalizeSettings round-trips systemPrompt, temperature and temperatureEnabled', () => {
  const input = { systemPrompt: 'Answer in French.', temperature: 1.3, temperatureEnabled: true, permission: 'manual', theme: 'system', thinking: false, reasoningEffort: 'high' };
  const once = normalizeSettings(input);
  assert.equal(once.systemPrompt, 'Answer in French.');
  assert.equal(once.temperature, 1.3);
  assert.equal(once.temperatureEnabled, true);
  assert.equal(once.theme, 'system');
  assert.equal(once.permission, 'manual');
  assert.equal(once.thinking, false);
  assert.equal(once.reasoningEffort, 'high');
  // Persist + reload through JSON must be lossless.
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(once))), once);
});

test('temperature from a range input string becomes a number; invalid values fall back', () => {
  assert.equal(toTemperature('0.7'), 0.7);
  assert.equal(toTemperature(0.30000000000000004), 0.3);
  assert.equal(toTemperature('abc'), undefined);
  assert.equal(toTemperature(3), undefined);
  assert.equal(normalizeSettings({ temperature: '1.5' }).temperature, 1.5);
  assert.equal(normalizeSettings({ temperature: 9 }).temperature, 0.7);
});

test('requestTemperature is sent only when enabled', () => {
  assert.equal(requestTemperature({ temperature: 0.4, temperatureEnabled: false }), undefined);
  assert.equal(requestTemperature({ temperature: '0.4', temperatureEnabled: true }), 0.4);
  assert.equal(requestTemperature(null), undefined);
});

// ---- nextRunAt edge cases (TASK 2) ----
function withTZ(tz, run) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
}

test('daily schedule later today stays today; earlier time rolls to tomorrow', () => withTZ('UTC', () => {
  const after = Date.UTC(2026, 4, 10, 8, 0);
  assert.equal(nextRunAt({ schedule: 'daily', time: '09:00' }, after), Date.UTC(2026, 4, 10, 9, 0));
  assert.equal(nextRunAt({ schedule: 'daily', time: '07:00' }, after), Date.UTC(2026, 4, 11, 7, 0));
  // Exactly at the slot is not "after": next day.
  assert.equal(nextRunAt({ schedule: 'daily', time: '08:00' }, after), Date.UTC(2026, 4, 11, 8, 0));
}));

test('weekly on the same weekday after the time rolls a full week', () => withTZ('UTC', () => {
  const after = Date.UTC(2026, 4, 13, 12, 0); // Wednesday
  assert.equal(nextRunAt({ schedule: 'weekly', time: '09:00', dayOfWeek: 3 }, after), Date.UTC(2026, 4, 20, 9, 0));
}));

test('monthly day 31 skips short months and Feb 29 waits for a leap year', () => withTZ('UTC', () => {
  assert.equal(nextRunAt({ schedule: 'monthly', time: '10:00', dayOfMonth: 31 }, Date.UTC(2026, 3, 1)), Date.UTC(2026, 4, 31, 10, 0));
  assert.equal(nextRunAt({ schedule: 'monthly', time: '10:00', dayOfMonth: 29 }, Date.UTC(2027, 1, 1)), Date.UTC(2027, 2, 29, 10, 0));
}));

test('hourly uses the minute past each hour', () => withTZ('UTC', () => {
  const after = Date.UTC(2026, 4, 10, 8, 20);
  assert.equal(nextRunAt({ schedule: 'hourly', time: '00:15' }, after), Date.UTC(2026, 4, 10, 9, 15));
  assert.equal(nextRunAt({ schedule: 'hourly', time: '00:45' }, after), Date.UTC(2026, 4, 10, 8, 45));
}));

test('interval adds N minutes and validates the range', () => {
  assert.equal(nextRunAt({ schedule: 'interval', intervalMinutes: 15 }, 1_000_000), 1_000_000 + 15 * 60000);
  assert.throws(() => nextRunAt({ schedule: 'interval', intervalMinutes: 0 }, 1), RangeError);
});

test('once returns runAt in the future and rejects a past runAt', () => {
  assert.equal(nextRunAt({ schedule: 'once', runAt: 5000, time: '09:00' }, 1000), 5000);
  assert.throws(() => nextRunAt({ schedule: 'once', runAt: 500, time: '09:00' }, 1000), /already run/);
});

test('daily keeps local wall-clock time across the DST spring-forward day', () => withTZ('America/New_York', () => {
  // 2026-03-08 is the US spring-forward day (02:00 -> 03:00).
  const after = new Date(2026, 2, 7, 10, 0).getTime();
  const next = nextRunAt({ schedule: 'daily', time: '09:00' }, after);
  const date = new Date(next);
  assert.equal(date.getDate(), 8);
  assert.equal(date.getHours(), 9);
  // 23 wall-clock hours minus the skipped hour = 22 real hours.
  assert.equal(next - after, 22 * 3600000);
  // A time inside the gap moves forward instead of looping or throwing.
  const gap = new Date(nextRunAt({ schedule: 'daily', time: '02:30' }, new Date(2026, 2, 7, 12, 0).getTime()));
  assert.equal(gap.getDate(), 8);
  assert.equal(gap.getHours(), 3);
}));

test('daily across DST fall-back runs once at the local time', () => withTZ('America/New_York', () => {
  const after = new Date(2026, 10, 1, 0, 0).getTime(); // Nov 1 00:00 (fall back at 02:00)
  const next = new Date(nextRunAt({ schedule: 'daily', time: '09:00' }, after));
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 9);
}));

test('normalizeAutomations flags a missed slot for one catch-up and keeps history bounded', () => {
  const now = Date.UTC(2026, 4, 10, 12, 0);
  const history = Array.from({ length: 15 }, (_, i) => ({ time: now - i, status: 'success', preview: `r${i}` }));
  const [automation] = normalizeAutomations([{
    id: 'a2', name: 'Daily', prompt: 'ping', schedule: 'daily', time: '09:00', active: true,
    schemaVersion: 2, nextRun: now - 5 * 86400000, history,
  }], now);
  assert.equal(automation.pendingCatchUp, true);
  assert.ok(automation.nextRun > now);
  assert.equal(automation.history.length, 10);
  const [future] = normalizeAutomations([{ ...automation, nextRun: now + 1000 }], now);
  assert.equal(future.pendingCatchUp, false);
  assert.equal(future.nextRun, now + 1000);
});

test('normalizeAutomations accepts interval and once schedules', () => {
  const now = Date.UTC(2026, 4, 10, 12, 0);
  const list = normalizeAutomations([
    { id: 'i1', name: 'I', prompt: 'p', schedule: 'interval', intervalMinutes: 30, active: true, schemaVersion: 2 },
    { id: 'o1', name: 'O', prompt: 'p', schedule: 'once', runAt: now + 60000, time: '12:01', active: true, schemaVersion: 2 },
    { id: 'bad', name: 'B', prompt: 'p', schedule: 'interval', intervalMinutes: -1, active: true, schemaVersion: 2 },
  ], now);
  assert.deepEqual(list.map((item) => item.id), ['i1', 'o1']);
  assert.equal(list[0].nextRun, now + 30 * 60000);
  assert.equal(list[1].nextRun, now + 60000);
});

test('search includes valid custom experts and skills and skips invalid ones', () => {
  const experts = [
    { id: 'custom-expert-legal', name: 'Contract Reviewer', role: 'Legal', prompt: 'Review contracts carefully.', custom: true },
    { id: 'bad', name: '', prompt: 'x' },
  ];
  const skills = [{ id: 'custom-skill-release', name: 'Release notes writer', prompt: 'Summarize {{input}}.', custom: true }];
  const found = searchItems('contract reviewer', [], { experts, skills });
  assert.deepEqual(found.map((item) => [item.kind, item.id]), [['expert', 'custom-expert-legal']]);
  assert.ok(searchItems('release notes', [], { experts, skills }).some((item) => item.kind === 'skill'
    && item.id === 'custom-skill-release'));
  // Built-in search keeps working without custom catalogs.
  assert.ok(searchItems('security', []).some((item) => item.kind === 'expert'));
  assert.deepEqual(searchItems('bad', [], { experts: 'not a list', skills: null }).filter((item) => item.id === 'bad'), []);
});

test('permission modes: legacy values migrate, bypass needs recorded consent', () => {
  assert.equal(normalizeSettings({}).permission, 'basic');
  // 'plan' is a real mode now, and the old read-only value is exactly that.
  for (const [legacy, mode] of [['ask', 'basic'], ['auto-write', 'basic'], ['full', 'basic'], ['readonly', 'plan'], ['plan', 'plan']]) {
    assert.equal(normalizeSettings({ permission: legacy }).permission, mode, legacy);
  }
  const consented = normalizeSettings({ permission: 'bypass', bypassConsent: true });
  assert.deepEqual([consented.permission, consented.bypassConsent], ['bypass', true]);
  assert.equal(effectivePermission(consented), 'bypass');
  const unconsented = normalizeSettings({ permission: 'bypass' });
  assert.deepEqual([unconsented.permission, unconsented.bypassConsent], ['basic', false]);
  // Consent never outlives a switch to another mode.
  assert.equal(normalizeSettings({ permission: 'manual', bypassConsent: true }).bypassConsent, false);
  assert.equal(effectivePermission({ permission: 'bypass', bypassConsent: false }), 'basic');
  assert.equal(effectivePermission({ permission: 'nonsense' }), 'basic');
});

test('reasoning preferences default to thinking on at medium effort', () => {
  assert.deepEqual(requestReasoning({}), { thinking: true, effort: 'medium' });
  assert.deepEqual(requestReasoning(normalizeSettings({ thinking: false, reasoningEffort: 'low' })), { thinking: false, effort: 'low' });
  assert.equal(normalizeSettings({ reasoningEffort: 'max' }).reasoningEffort, 'medium');
  assert.equal(normalizeSettings({ thinking: 'no' }).thinking, true);
});

test('assistant messages keep their thinking time and thinking text across a reload', () => {
  const [task] = normalizeTasks([{
    id: 't1', title: 'Math', createdAt: 1, updatedAt: 2,
    messages: [
      { role: 'user', text: '17*23?', time: 1, thinkingMs: 5 },
      { role: 'assistant', text: '391', time: 2, thinkingMs: 4200, reasoning: '17 × 23 = 391' },
      { role: 'assistant', text: 'x', time: 3, thinkingMs: -1, reasoning: '   ' },
    ],
  }]);
  assert.equal(task.messages[0].thinkingMs, undefined);
  assert.equal(task.messages[1].thinkingMs, 4200);
  assert.equal(task.messages[1].reasoning, '17 × 23 = 391');
  assert.equal(task.messages[2].thinkingMs, undefined);
  assert.equal(task.messages[2].reasoning, undefined);
});

// ---- Folder-first tasks ----
const ALPHA = { name: 'alpha', path: '/work/alpha' };
const BETA = { name: 'beta', path: '/work/beta' };
const said = (text, time = 1) => ({ role: 'user', text, time });
const replied = (text, time = 2) => ({ role: 'assistant', text, time });

test('folder names and stored task folders', () => {
  assert.equal(folderName('/Users/me/Desktop'), 'Desktop');
  assert.equal(folderName('/Users/me/project/'), 'project');
  assert.equal(folderName('/'), '/');
  assert.equal(folderName(''), '');
  assert.deepEqual(normalizeTaskFolder(ALPHA), ALPHA);
  assert.equal(normalizeTaskFolder({ name: 'alpha', path: 'work/alpha' }), null, 'relative paths are refused');
  assert.equal(normalizeTaskFolder({ name: ' ', path: '/work/alpha' }), null);
  assert.equal(normalizeTaskFolder('/work/alpha'), null);
});

test('a task is locked once it has a folder and a message from the user', () => {
  assert.equal(isTaskLocked({ folder: ALPHA, messages: [said('hi'), replied('hello')] }), true);
  // A draft: the folder follows the user's choice until the first message.
  assert.equal(isTaskLocked({ folder: ALPHA, messages: [] }), false);
  // Chats from before tasks had folders stay unlocked until their next message.
  assert.equal(isTaskLocked({ messages: [said('hi')] }), false);
  assert.equal(isTaskLocked({ folder: ALPHA, messages: [replied('automation output')] }), false);
  assert.equal(isTaskLocked({ folder: { name: 'x', path: 'relative' }, messages: [said('hi')] }), false);
  assert.equal(isTaskLocked(null), false);
});

test('task folder status: ready, waiting for a folder, or another folder', () => {
  assert.equal(taskFolderStatus({ folder: ALPHA, messages: [] }, '/work/alpha'), 'ready');
  assert.equal(taskFolderStatus({ messages: [] }, '/work/alpha'), 'ready', 'a task without a folder takes the open one');
  assert.equal(taskFolderStatus({ messages: [] }, ''), 'none');
  assert.equal(taskFolderStatus(undefined, ''), 'none');
  assert.equal(taskFolderStatus({ folder: ALPHA, messages: [said('hi')] }, '/work/beta'), 'mismatch');
  assert.equal(taskFolderStatus({ folder: ALPHA, messages: [said('hi')] }, ''), 'mismatch');
});

test('sidebar groups: folders by recent activity, tasks newest first, earlier chats last', () => {
  const tasks = [
    { id: 'a1', title: 'Old alpha', folder: ALPHA, messages: [said('a')], updatedAt: 100 },
    { id: 'b1', title: 'Beta', folder: BETA, messages: [said('b')], updatedAt: 300 },
    { id: 'a2', title: 'New alpha', folder: ALPHA, messages: [said('a')], updatedAt: 200 },
    { id: 'l1', title: 'Before folders', messages: [said('x')], updatedAt: 900 },
    { id: 'l2', title: 'Also before', messages: [said('y')], updatedAt: 950 },
    { id: 'e1', title: 'New Task', messages: [], updatedAt: 999 },
    { id: 'e2', title: 'New Task', folder: ALPHA, messages: [], updatedAt: 998 },
  ];
  const { groups, legacy } = taskGroups(tasks, 'b1');
  assert.deepEqual(groups.map((group) => [group.path, group.name, group.updatedAt]), [['/work/beta', 'beta', 300], ['/work/alpha', 'alpha', 200]]);
  assert.deepEqual(groups[1].tasks.map((task) => task.id), ['a2', 'a1']);
  // Empty tasks are not listed unless they are the current task with a folder.
  assert.deepEqual(legacy.map((task) => task.id), ['l2', 'l1']);
  assert.ok(!groups.some((group) => group.tasks.some((task) => task.id.startsWith('e'))));
  const withDraft = taskGroups(tasks, 'e2');
  assert.deepEqual(withDraft.groups.map((group) => group.path), ['/work/alpha', '/work/beta']);
  assert.deepEqual(withDraft.groups[0].tasks.map((task) => task.id), ['e2', 'a2', 'a1']);
  // The current empty task without a folder stays out.
  assert.equal(taskGroups(tasks, 'e1').groups.flatMap((group) => group.tasks).some((task) => task.id === 'e1'), false);
  assert.deepEqual(taskGroups('nope', null), { groups: [], legacy: [] });
});

test('sidebar task times are short and relative', () => {
  const now = new Date(2026, 4, 10, 15, 30).getTime();
  assert.equal(taskTime(now - 20000, now), 'Just now');
  assert.equal(taskTime(now + 5000, now), 'Just now');
  assert.equal(taskTime(now - 12 * 60000, now), '12m ago');
  assert.equal(taskTime(new Date(2026, 4, 10, 9, 5).getTime(), now), '09:05');
  assert.equal(taskTime(new Date(2026, 4, 9, 23, 59).getTime(), now), 'Yesterday');
  assert.equal(taskTime(new Date(2026, 3, 3, 12, 0).getTime(), now), 'Apr 3');
  assert.equal(taskTime(new Date(2025, 11, 24, 12, 0).getTime(), now), 'Dec 24, 2025');
  assert.equal(taskTime(Number.NaN, now), '');
});

test('tool calls of a reply are grouped with plain labels', () => {
  const groups = toolCallGroups([
    { server: 'Workspace', tool: 'read_file', ok: true },
    { server: 'Workspace', tool: 'list_files', ok: true },
    { server: 'Workspace', tool: 'read_file', ok: true },
    { server: 'Workspace', tool: 'edit_file', ok: true },
    { server: 'Workspace', tool: 'edit_file', ok: false },
    { server: 'Workspace', tool: 'run_command', ok: false },
    { server: 'GitHub', tool: 'search_code', ok: true },
    { server: 'GitHub', tool: 'search_code', ok: true },
    { server: '', tool: 'lonely', ok: true },
    { tool: 42 },
    null,
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.ok]), [
    ['Read 2 files', true],
    ['Listed a folder', true],
    ['Made 2 edits · 1 failed', false],
    ['Ran a command · failed', false],
    ['GitHub · search_code ×2', true],
    ['lonely', true],
  ]);
  assert.equal(groups[2].title, 'Workspace · edit_file: 2 calls, 1 failed');
  assert.equal(groups[1].title, 'Workspace · list_files: 1 call');
  assert.deepEqual(toolCallGroups(undefined), []);
});

test('tool activity reads like a sentence for workspace tools', () => {
  assert.deepEqual(toolActivity('Workspace', 'read_file'), { text: 'Reading a file', friendly: true });
  assert.deepEqual(toolActivity('Workspace', 'run_command'), { text: 'Running a command', friendly: true });
  assert.deepEqual(toolActivity('GitHub', 'search_code'), { text: 'GitHub · search_code', friendly: false });
  assert.deepEqual(toolActivity('', 'echo'), { text: 'echo', friendly: false });
});

// ---- Usage/cost persistence and conversation compaction -----------------------------------

test('settings preserve automatic compaction and metrics retain unknown prices instead of zero', () => {
  assert.equal(normalizeSettings({}).autoCompact, true);
  assert.equal(normalizeSettings({ autoCompact: false }).autoCompact, false);
  const metric = normalizeMetrics({
    model: 'demo', usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 },
    costMicroUsd: 1800, costStatus: 'priced',
    rounds: [{ model: 'demo', usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, costMicroUsd: 1800 }],
  });
  assert.equal(metricsLabel(metric), '1.2k in · 300 out · $0.0018');
  assert.equal(normalizeMetrics({ usage: { totalTokens: 12 }, costStatus: 'unpriced' }).costStatus, 'unpriced');
  assert.equal(normalizeMetrics({ usage: { totalTokens: -1 } }), null);
});

test('compacted task history has one clearly marked summary and preserves the raw tail', () => {
  const messages = [
    { role: 'user', text: 'first goal', time: 1 },
    { role: 'assistant', text: 'first answer', time: 2 },
    { role: 'user', text: 'latest request', time: 3 },
  ];
  const task = { messages, compaction: { summary: 'Earlier goal and answer.', through: 2, time: 4 } };
  assert.deepEqual(normalizeCompaction(task.compaction), { summary: 'Earlier goal and answer.', through: 2, time: 4 });
  const history = taskHistoryMessages(task);
  assert.equal(history.length, 2);
  assert.match(history[0].content, /untrusted historical data/);
  assert.match(history[0].content, /Earlier goal and answer/);
  assert.deepEqual(history[1], { role: 'user', content: 'latest request' });
  assert.deepEqual(compactionMessages(task, 3).map((turn) => turn.content), [
    history[0].content,
    'latest request',
  ]);
  assert.equal(compactionBoundary({ messages: Array.from({ length: COMPACTION_TAIL_MESSAGES + 2 }, (_, index) => ({ role: 'user', text: String(index) })) }), 2);
});

test('automatic compaction uses model metadata and never invents a threshold without it', () => {
  const task = { messages: Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: 'x'.repeat(3000) })) };
  assert.equal(automaticCompactionPlan(task, { systemPrompt: 's' }), null);
  const plan = automaticCompactionPlan(task, { systemPrompt: 's', contextWindow: 6000, maxOutputTokens: 128 });
  assert.ok(plan && plan.estimate > plan.limit && Number.isInteger(plan.through) && plan.through > 0);
  assert.ok(estimateTokens(taskHistoryMessages(task), 's') > 0);
});

test('task totals include compacting cost but report unknown provider prices honestly', () => {
  const task = {
    messages: [{ role: 'assistant', text: 'a', metrics: { usage: { totalTokens: 10 }, costStatus: 'unpriced' } }],
    compaction: { summary: 'old', through: 1, metrics: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, costMicroUsd: 20, costStatus: 'priced' } },
  };
  const totals = taskMetrics(task);
  assert.equal(totals.totalTokens, 25);
  assert.equal(totals.costNanoUsd, 20000);
  assert.equal(totals.unavailablePrice, true);
  assert.equal(taskMetricsLabel(task), '25 tokens · $0.00002 + unpriced');
});


test('task totals retain every prior compaction cost after a newer summary replaces it', () => {
  const task = {
    messages: [{ role: 'user', text: 'latest' }],
    compaction: {
      summary: 'new', through: 1,
      metrics: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, costNanoUsd: 300, costMicroUsd: 0, costStatus: 'priced' },
      priorMetrics: [{ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costNanoUsd: 200, costMicroUsd: 0, costStatus: 'priced' }],
    },
  };
  const totals = taskMetrics(task);
  assert.equal(totals.compactions, 2);
  assert.equal(totals.totalTokens, 5);
  assert.equal(totals.costNanoUsd, 500);
  assert.equal(taskMetricsLabel(task), '5 tokens · $0.0000005');
});


test('long conversations compact in bounded prefixes and retain indices beyond five hundred', () => {
  const task = { messages: Array.from({ length: 510 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` })) };
  const bounded = compactionInput(task, 502);
  assert.equal(bounded.through, 400, 'main can accept this first bounded prefix');
  assert.ok(bounded.messages.length <= 400);
  assert.ok(normalizeCompaction({ summary: 'long history', through: 502 }), 'a later chunk index survives normalization');
});


test('plan is a real permission mode and a read-only legacy value becomes it', () => {
  assert.deepEqual([...PERMISSION_MODES], ['plan', 'manual', 'basic', 'bypass']);
  assert.equal(normalizeSettings({ permission: 'plan' }).permission, 'plan');
  assert.equal(effectivePermission({ permission: 'plan' }), 'plan', 'plan needs no extra consent');
  assert.equal(normalizeSettings({ permission: 'readonly' }).permission, 'plan');
  // Plan must not silently become a mode that can change files.
  assert.equal(normalizeSettings({ permission: 'plan' }).bypassConsent, false);
  const prompt = buildSystemPrompt({ permission: 'plan' });
  assert.match(prompt, /Plan permission: read-only/);
  assert.match(prompt, /Run this plan/);
});
