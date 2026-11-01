import test from 'node:test';
import assert from 'node:assert/strict';
import { canSend, laterText, outcomeText, systemText, REPORT_ACTION, MIN_LENGTH, MAX_LENGTH } from '../src/report-ui.js';

const RETRY = "The report wasn't sent. Check your connection and try again.";

test('Send report needs 10 to 2,000 characters; spaces around them are not counted', () => {
  assert.equal(MIN_LENGTH, 10);
  assert.equal(MAX_LENGTH, 2000);
  assert.equal(canSend(''), false);
  assert.equal(canSend('   123456789   '), false);
  assert.equal(canSend('1234567890'), true);
  assert.equal(canSend('x'.repeat(2000)), true);
  assert.equal(canSend('x'.repeat(2001)), false);
  assert.equal(canSend(undefined), false);
});

test('after a send: thanks, and how many are left today', () => {
  assert.equal(outcomeText({ sent: true, remaining: 2 }), 'Report sent. Thank you. You can send 2 more today.');
  assert.equal(outcomeText({ sent: true, remaining: 1 }), 'Report sent. Thank you. You can send 1 more today.');
  assert.equal(outcomeText({ sent: true, remaining: 0 }), 'Report sent. Thank you. That was your last one for today.');
});

test('a limit says when the next report can go', () => {
  const now = new Date(2026, 10, 1, 9, 0);
  const today = new Date(2026, 10, 1, 15, 40).toISOString();
  const tomorrow = new Date(2026, 10, 2, 8, 5).toISOString();
  assert.equal(laterText(today, now, 'en-US'), 'after 3:40 PM');
  assert.equal(laterText(tomorrow, now, 'en-US'), 'tomorrow after 8:05 AM');
  assert.equal(outcomeText({ sent: false, code: 'LIMIT', resetAt: today }, now, 'en-US'),
    "You've sent 3 reports today. You can send another after 3:40 PM.");
  assert.equal(outcomeText({ sent: false, code: 'NETWORK_LIMIT', resetAt: tomorrow }, now, 'en-US'),
    'Too many reports came from your network today. You can send another tomorrow after 8:05 AM.');
  assert.equal(outcomeText({ sent: false, code: 'LIMIT', resetAt: null }, now, 'en-US'), "You've sent 3 reports today. Please try again tomorrow.");
  assert.equal(outcomeText({ sent: false, code: 'BUSY', resetAt: today }), 'Reports are paused for today. Please try again tomorrow.');
});

test('anything else asks to try again; a build without reports says so', () => {
  for (const code of ['NETWORK', 'TELEGRAM', 'INVALID_ANSWER', undefined]) assert.equal(outcomeText({ sent: false, code }), RETRY, String(code));
  assert.equal(outcomeText(null), RETRY);
  assert.equal(outcomeText({ sent: false, code: 'INVALID' }), 'Write at least 10 characters, and at most 2,000.');
  assert.equal(outcomeText({ sent: false, code: 'UNAVAILABLE' }), "Bug reports aren't available in this version.");
  assert.equal(outcomeText({ sent: false, code: 'REPORT_ERROR' }), 'The report could not be sent.');
});

test("the card names this computer's system; search finds Report a bug by its words", () => {
  assert.equal(systemText('macOS 15.1 (arm64)'), 'macOS 15.1, arm64');
  assert.equal(systemText('Windows 11 (build 22631, x64)'), 'Windows 11, build 22631, x64');
  assert.equal(systemText(''), '');
  assert.deepEqual({ ...REPORT_ACTION, keywords: [...REPORT_ACTION.keywords] }, {
    id: 'report-bug', title: 'Report a bug', description: 'Tell the developer about a problem', keywords: ['bug', 'report', 'feedback', 'problem'],
  });
});
