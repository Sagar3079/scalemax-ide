import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt, searchItems, normalizeAutomations, nextRunAt,
  normalizeSettings, toTemperature, requestTemperature,
} from '../src/domain.mjs';
import { EXPERTS, SKILLS, CONNECTORS, COMMUNITY_SKILLS } from '../src/data.js';

test('system prompt carries the base contract and the ask-first default', () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /You are ScaleMax, an assistant/);
  assert.match(prompt, /Working mode/);
  assert.match(prompt, /Ask-first permission/);
  assert.match(prompt, /Never pretend tools executed/);
});

test('coding mode switches the mode paragraph', () => {
  const prompt = buildSystemPrompt({ mode: 'coding' });
  assert.match(prompt, /Coding mode/);
  assert.doesNotMatch(prompt, /Working mode/);
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
  const prompt = buildSystemPrompt({ systemPrompt: 'Always answer in one line.', permission: 'full' });
  assert.match(prompt, /User system instructions:\nAlways answer in one line\./);
  assert.match(prompt, /Full access/);
  assert.match(buildSystemPrompt({ permission: 'readonly' }), /Read-only permission/);
  assert.match(buildSystemPrompt({ permission: 'plan' }), /Plan-only permission/);
  assert.match(buildSystemPrompt({ permission: 'auto-write' }), /Auto-approve file writes/);
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
  const input = { systemPrompt: 'Answer in French.', temperature: 1.3, temperatureEnabled: true, permission: 'plan', theme: 'system' };
  const once = normalizeSettings(input);
  assert.equal(once.systemPrompt, 'Answer in French.');
  assert.equal(once.temperature, 1.3);
  assert.equal(once.temperatureEnabled, true);
  assert.equal(once.theme, 'system');
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
