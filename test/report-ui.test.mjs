import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSend, laterText, outcomeText, outcomeFromResult, systemText, bindReportUi, openReportDialog, REPORT_ACTION, MIN_LENGTH, MAX_LENGTH,
} from '../src/report-ui.js';

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

test('a narrow no-break space before AM or PM (some ICU versions print one) reads as a space', () => {
  const format = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleTimeString = () => '3:40\u202fPM';
  try {
    const now = new Date(2026, 10, 1, 9, 0);
    assert.equal(laterText(new Date(2026, 10, 1, 15, 40).toISOString(), now, 'en-US'), 'after 3:40 PM');
    assert.equal(laterText(new Date(2026, 10, 2, 15, 40).toISOString(), now, 'en-US'), 'tomorrow after 3:40 PM');
  } finally {
    Date.prototype.toLocaleTimeString = format;
  }
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

test("main's answer to a send becomes an outcome: its data, REPORT_ERROR when main failed, else no connection", () => {
  const sent = { sent: true, remaining: 2, resetAt: '2026-11-02T10:00:00.000Z' };
  const refused = { sent: false, code: 'LIMIT', resetAt: null };
  assert.equal(outcomeFromResult({ ok: true, data: sent }), sent);
  assert.equal(outcomeFromResult({ ok: true, data: refused }), refused);
  // Main itself failed (it could not read or keep the install ID): not a connection problem, and
  // its message (which can hold a file path) is never taken.
  assert.deepEqual(outcomeFromResult({ ok: false, error: { code: 'X', message: '/Users/someone/state.json is locked' } }), { sent: false, code: 'REPORT_ERROR' });
  assert.deepEqual(outcomeFromResult({ ok: false }), { sent: false, code: 'REPORT_ERROR' });
  for (const garbage of [undefined, null, 'sent', 7, [], {}, { ok: true }, { ok: true, data: null }, { ok: true, data: 'sent' }, { ok: true, data: [] }, { ok: 'yes', data: sent }]) {
    assert.deepEqual(outcomeFromResult(garbage), { sent: false, code: 'NETWORK' }, JSON.stringify(garbage));
  }
  assert.equal(outcomeText(outcomeFromResult({ ok: false, error: {} })), 'The report could not be sent.');
  assert.equal(outcomeText(outcomeFromResult(undefined)), RETRY);
});

// The few elements the dialog touches; every other lookup finds nothing, as in test/app-send.test.mjs.
function stand(extra = {}) {
  const listeners = {};
  return { value: '', textContent: '', disabled: false, hidden: false, listeners, addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }, focus() {}, ...extra };
}

test('while a report is sent Cancel and Escape wait; a reopened dialog keeps what was typed', async () => {
  const dialog = stand({ open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const nodes = {
    '#report-dialog': dialog, '#report-message': stand(), '#report-count': stand(), '#report-error': stand({ hidden: true }),
    '#report-send': stand(), '#report-cancel': stand(),
  };
  const { '#report-message': box, '#report-count': count, '#report-error': error, '#report-send': send, '#report-cancel': cancel } = nodes;
  let finish;
  const toasts = [];
  globalThis.window = globalThis;
  globalThis.document = { querySelector: (selector) => nodes[selector] || null };
  window.scalemaxAPI = {
    report: {
      get: async () => ({ ok: true, data: { available: true, osLabel: 'macOS 15.1 (arm64)' } }),
      send: () => new Promise((resolve) => { finish = resolve; }),
    },
  };
  bindReportUi({ showToast: (text) => toasts.push(text) });
  await new Promise((resolve) => setImmediate(resolve));
  const escape = () => { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const listener of dialog.listeners.cancel) listener(event); return event.defaultPrevented; };

  // /bug words fill the box; the person adds to them, cancels and comes back: nothing is lost.
  openReportDialog('The editor froze');
  assert.equal(dialog.open, true);
  assert.equal(box.value, 'The editor froze');
  box.value = 'The editor froze after Undo all.';
  for (const listener of box.listeners.input) listener();
  assert.equal(escape(), false, 'Escape closes the dialog when nothing is being sent');
  cancel.listeners.click[0]();
  assert.equal(dialog.open, false);
  error.textContent = 'An old line';
  error.hidden = false;
  openReportDialog();
  assert.equal(box.value, 'The editor froze after Undo all.', 'no words given: the text stays');
  assert.equal(count.textContent, '32 / 2,000');
  assert.equal(send.disabled, false);
  assert.equal(error.hidden, true, 'the old line is gone');
  openReportDialog('');
  assert.equal(box.value, 'The editor froze after Undo all.');
  openReportDialog('Another problem, in words');
  assert.equal(box.value, 'Another problem, in words', 'words after /bug replace the text');
  box.value = 'The editor froze after Undo all.';
  for (const listener of box.listeners.input) listener();

  // Sending: Cancel is off and Escape is refused, so a failure lands where the person is looking.
  send.listeners.click[0]();
  assert.equal(send.textContent, 'Sending…');
  assert.equal(cancel.disabled, true);
  assert.equal(box.disabled, true);
  assert.equal(escape(), true, 'Escape does not close the dialog while a report is sent');
  finish({ ok: false, error: { code: 'INTERNAL', message: '/Users/someone/state.json is locked' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancel.disabled, false);
  assert.equal(dialog.open, true);
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'The report could not be sent.');
  assert.equal(box.value, 'The editor froze after Undo all.', 'a refused send keeps the text');
  assert.equal(escape(), false);

  // A sent report closes the dialog, empties the box and says thanks.
  send.listeners.click[0]();
  finish({ ok: true, data: { sent: true, remaining: 1, resetAt: null } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialog.open, false);
  assert.equal(box.value, '');
  assert.deepEqual(toasts, ['Report sent. Thank you. You can send 1 more today.']);
});
