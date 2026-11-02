import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReport, decide, formatMessage, hashAddress, networkKey, missingSecrets, LIMITS, WINDOW_MS, MAX_BODY_BYTES } from '../relay/src/logic.mjs';

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

test('a network is counted by its IPv4 address, or by its IPv6 /64, so one network cannot pose as many', () => {
  // IPv4 as is.
  assert.equal(networkKey('1.2.3.4'), '1.2.3.4');
  assert.equal(networkKey('203.0.113.7'), '203.0.113.7');
  // IPv4-mapped IPv6 (any case, dotted or hex) is the IPv4 address.
  assert.equal(networkKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(networkKey('::FFFF:1.2.3.4'), '1.2.3.4');
  assert.equal(networkKey('::ffff:0102:0304'), '1.2.3.4');
  // Other IPv6: the first four groups, spelled one way, however the address is written.
  assert.equal(networkKey('2001:db8:0:1:aaaa::1'), '2001:db8:0:1');
  assert.equal(networkKey('2001:0DB8:0:1::2'), '2001:db8:0:1');
  assert.equal(networkKey('2001:DB8:0000:0001:0002:0003:0004:0005'), '2001:db8:0:1');
  assert.equal(networkKey('2001:db8::1'), '2001:db8:0:0');
  assert.equal(networkKey('::1'), '0:0:0:0');
  assert.equal(networkKey('2001:db8:0:1::'), '2001:db8:0:1');
  assert.equal(networkKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0');
  assert.notEqual(networkKey('2001:db8:0:1::1'), networkKey('2001:db8:0:2::1'));
  assert.equal(networkKey('2001:db8:0:1:1111:2222:3333:4444'), networkKey('2001:db8:0:1:ffff:eeee:dddd:cccc'));
  // A zone id is dropped.
  assert.equal(networkKey('fe80::1%eth0'), 'fe80:0:0:0');
  // Anything else comes back as it was, the missing-header value included.
  for (const other of ['unknown', '', 'not an address', '1:2:3', '1::2::3', '12345::1', '::ffff:1.2.3.999', ':::', '::a1.2.3.4', '::1.2.3.4.5']) {
    assert.equal(networkKey(other), other, JSON.stringify(other));
  }
});

test('the relay names the secrets it is missing, and a short salt counts as missing', () => {
  const secrets = { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '12345', IP_SALT: 'a'.repeat(16) };
  assert.deepEqual(missingSecrets(secrets), []);
  assert.deepEqual(missingSecrets({ ...secrets, IP_SALT: 'a'.repeat(64) }), []);
  assert.deepEqual(missingSecrets({}), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'IP_SALT']);
  assert.deepEqual(missingSecrets(undefined), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'IP_SALT']);
  assert.deepEqual(missingSecrets({ ...secrets, TELEGRAM_BOT_TOKEN: undefined }), ['TELEGRAM_BOT_TOKEN']);
  assert.deepEqual(missingSecrets({ ...secrets, TELEGRAM_CHAT_ID: '' }), ['TELEGRAM_CHAT_ID']);
  assert.deepEqual(missingSecrets({ ...secrets, TELEGRAM_BOT_TOKEN: 123, TELEGRAM_CHAT_ID: null }), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  assert.deepEqual(missingSecrets({ ...secrets, IP_SALT: 'a'.repeat(15) }), ['IP_SALT']);
  assert.deepEqual(missingSecrets({ ...secrets, IP_SALT: '' }), ['IP_SALT']);
  // A short token or chat ID is still a value: only the salt has a minimum length.
  assert.deepEqual(missingSecrets({ ...secrets, TELEGRAM_CHAT_ID: '1' }), []);
});
