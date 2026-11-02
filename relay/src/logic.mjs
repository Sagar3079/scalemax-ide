// The relay's rules (src/worker.mjs uses them): what a report may hold, the three limits, the
// Telegram text, how an address is kept and which secrets must be set. No Cloudflare APIs here, so
// `node --test` runs them (test/bug-relay.test.mjs).

export const LIMITS = Object.freeze({ install: 3, address: 10, total: 100 });
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 16 * 1024;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 2000;
const MIN_SALT = 16;

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

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV4_TAIL = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/** The 8 groups of an IPv6 address (lowercase, no leading zeros), or null when it isn't one. */
function ipv6Groups(text) {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/i.test(text)) return null;
  let head = text;
  const tail = IPV4_TAIL.exec(text);
  if (tail) {
    // A dotted IPv4 ending ("::ffff:1.2.3.4") is two groups.
    const octets = tail.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    head = `${text.slice(0, tail.index + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const gap = 8 - left.length - right.length;
  // "::" stands for one group of zeros or more; without it all 8 groups are written.
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...right];
  if (!groups.every((group) => IPV6_GROUP.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase());
}

/**
 * What the per-address limit counts: an IPv4 address as it is, an IPv4-mapped IPv6 address as its
 * IPv4 address, any other IPv6 address as its /64 (one network can use every address in it, so
 * counting them one by one would never reach the limit). Anything else, 'unknown' included (the
 * value used when the header is missing), comes back as it was.
 */
export function networkKey(address) {
  if (typeof address !== 'string' || IPV4.test(address)) return address;
  const groups = ipv6Groups(address.split('%')[0]);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === '0') && groups[5] === 'ffff') {
    const [high, low] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return groups.slice(0, 4).join(':');
}

/** The names of the Worker secrets that are not set (README.md step 4); the salt needs 16 characters. */
export function missingSecrets(env) {
  return ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'IP_SALT'].filter((name) => {
    const value = env?.[name];
    return typeof value !== 'string' || value.length === 0 || (name === 'IP_SALT' && value.length < MIN_SALT);
  });
}

/** sha256(salt + address) in hex: the relay never keeps an address itself. */
export async function hashAddress(salt, address) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}${address}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
