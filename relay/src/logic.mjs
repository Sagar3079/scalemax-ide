// The relay's rules (src/worker.mjs uses them): what a report may hold, the three limits, the
// Telegram text and how an address is kept. No Cloudflare APIs here, so `node --test` runs them
// (test/bug-relay.test.mjs).

export const LIMITS = Object.freeze({ install: 3, address: 10, total: 100 });
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 16 * 1024;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 2000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const OS = /^[\x20-\x7E]{1,80}$/;
// Control characters except tab and newline (so a Windows \r goes too).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** { ok: true, report } with the message cleaned and only the four fields, or { ok: false }. */
export function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const { installId, message, version, os } = body;
  if (typeof installId !== 'string' || !UUID_V4.test(installId)) return { ok: false };
  if (typeof version !== 'string' || !VERSION.test(version)) return { ok: false };
  if (typeof os !== 'string' || !OS.test(os)) return { ok: false };
  if (typeof message !== 'string') return { ok: false };
  const cleaned = message.replace(CONTROL, '').trim();
  if (cleaned.length < MIN_MESSAGE || cleaned.length > MAX_MESSAGE) return { ok: false };
  return { ok: true, report: { installId, message: cleaned, version, os } };
}

/**
 * Whether one more report may go now. Each list holds the times (ms, oldest first) of the reports
 * counted in the last 24 hours. The install is checked first, then the address, then the total.
 * resetAt: when the next report frees up in the scope that answers.
 */
export function decide({ install = [], address = [], total = [] }, now) {
  for (const [times, limit, code] of [
    [install, LIMITS.install, 'LIMIT'], [address, LIMITS.address, 'NETWORK_LIMIT'], [total, LIMITS.total, 'BUSY'],
  ]) {
    if (times.length >= limit) return { ok: false, code, resetAt: times[times.length - limit] + WINDOW_MS };
  }
  const ordinal = install.length + 1;
  return { ok: true, ordinal, remaining: LIMITS.install - ordinal, resetAt: (install[0] ?? now) + WINDOW_MS };
}

/** The Telegram message, sent as plain text, so nothing in the report is read as formatting. */
export function formatMessage(report, ordinal) {
  return [
    `🐞 Bug report · ${report.version} · ${report.os}`,
    `Install ${report.installId.slice(0, 8)} · ${ordinal} of ${LIMITS.install} today`,
    '',
    report.message,
  ].join('\n');
}

/** sha256(salt + address) in hex: the relay never keeps an address itself. */
export async function hashAddress(salt, address) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}${address}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
