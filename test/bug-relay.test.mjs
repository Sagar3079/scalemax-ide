import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReport, decide, formatMessage, hashAddress, LIMITS, WINDOW_MS, MAX_BODY_BYTES } from '../relay/src/logic.mjs';

const ID = '3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f';
const good = { installId: ID, message: 'The editor froze after Undo all.', version: '1.0.0-beta.8', os: 'macOS 15.1 (arm64)' };

test('the limits are 3 per install, 10 per address and 100 in all, over 24 hours', () => {
  assert.deepEqual(LIMITS, { install: 3, address: 10, total: 100 });
  assert.equal(WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(MAX_BODY_BYTES, 16 * 1024);
});

test('a report with every field right is accepted, its message cleaned and nothing else kept', () => {
  const result = validateReport({ ...good, message: '  Line one\r\nline two\u0007 here  ', extra: 'dropped' });
  assert.equal(result.ok, true);
  assert.equal(result.report.message, 'Line one\nline two here');
  assert.deepEqual(Object.keys(result.report).sort(), ['installId', 'message', 'os', 'version']);
  assert.equal(validateReport({ ...good, message: '0123456789' }).ok, true);
  assert.equal(validateReport({ ...good, message: 'x'.repeat(2000) }).ok, true);
});

test('each field is checked', () => {
  const bad = [
    null, [], 'text',
    { ...good, installId: 'not-a-uuid' },
    { ...good, installId: ID.toUpperCase() },
    { ...good, installId: '3f2a9c1e-7b4d-1c2a-9e1f-0a1b2c3d4e5f' },
    { ...good, message: 'too short' },
    { ...good, message: '   \u0000\u0001   ' },
    { ...good, message: 'x'.repeat(2001) },
    { ...good, message: 42 },
    { ...good, version: '' },
    { ...good, version: '1.0.0 beta' },
    { ...good, version: 'v'.repeat(41) },
    { ...good, os: '' },
    { ...good, os: 'o'.repeat(81) },
    { ...good, os: 'macOS\n15' },
  ];
  for (const body of bad) assert.equal(validateReport(body).ok, false, JSON.stringify(body));
});

test('the install, then the address, then the total: the first limit hit is the answer', () => {
  const now = 1_800_000_000_000;
  const minute = 60_000;
  const start = now - 5 * 60 * minute;
  const times = (count) => Array.from({ length: count }, (_, index) => start + index * minute);
  assert.deepEqual(decide({ install: [], address: [], total: [] }, now), { ok: true, ordinal: 1, remaining: 2, resetAt: now + WINDOW_MS });
  assert.deepEqual(decide({ install: times(2), address: times(2), total: times(2) }, now), { ok: true, ordinal: 3, remaining: 0, resetAt: start + WINDOW_MS });
  assert.deepEqual(decide({ install: times(3), address: times(10), total: times(100) }, now), { ok: false, code: 'LIMIT', resetAt: start + WINDOW_MS });
  assert.deepEqual(decide({ install: times(1), address: times(10), total: times(100) }, now), { ok: false, code: 'NETWORK_LIMIT', resetAt: start + WINDOW_MS });
  assert.deepEqual(decide({ install: [], address: times(3), total: times(100) }, now), { ok: false, code: 'BUSY', resetAt: start + WINDOW_MS });
  // Over the limit (it shouldn't happen): the next one frees up when the oldest of the last 3 expires.
  assert.equal(decide({ install: times(4), address: [], total: [] }, now).resetAt, times(4)[1] + WINDOW_MS);
});

test('the Telegram text: version and system, a short install ID, the count, then the message as sent', () => {
  const text = formatMessage({ ...good, message: '<b>bold</b> and *stars* stay as typed' }, 2);
  assert.equal(text, '🐞 Bug report · 1.0.0-beta.8 · macOS 15.1 (arm64)\nInstall 3f2a9c1e · 2 of 3 today\n\n<b>bold</b> and *stars* stay as typed');
});

test('an address is kept only as sha256(salt + address)', async () => {
  const hash = await hashAddress('pepper', '203.0.113.7');
  assert.equal(hash, createHash('sha256').update('pepper203.0.113.7').digest('hex'));
  assert.notEqual(hash, await hashAddress('other', '203.0.113.7'));
});
