import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, searchItems, normalizeAutomations, nextRunAt } from '../src/domain.mjs';
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
