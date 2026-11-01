'use strict';
// Bug reports (Preferences & about → Report a bug, /bug, search; src/report-ui.js): the person's
// message, the app's version and the system, posted to the relay in relay/ (a Cloudflare Worker
// that forwards it to the developer's Telegram, 3 per install in 24 hours). Nothing else is sent.
// The install ID is random, made at the first report and sent only with reports.
const os = require('node:os');
const { randomUUID } = require('node:crypto');

// The deployed relay's /report URL (relay/README.md). Empty: reports are off in this build.
const REPORT_URL = '';
const MIN_LENGTH = 10;
const MAX_LENGTH = 2000;
const TIMEOUT_MS = 15_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Control characters except tab and newline, as the relay removes them (relay/src/logic.mjs).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
// The relay's refusals; any other answer counts as none.
const RELAY_CODES = new Set(['INVALID', 'LIMIT', 'NETWORK_LIMIT', 'BUSY', 'TELEGRAM']);

/** "macOS 15.1 (arm64)", "Windows 11 (build 22631, x64)", "linux 6.8.0 (x64)". */
function osLabel({ platform, arch, systemVersion, release = os.release() }) {
  if (platform === 'darwin') return `macOS ${String(systemVersion).replace(/\.0$/, '')} (${arch})`;
  if (platform === 'win32') {
    const build = Number(String(systemVersion).split('.')[2]) || 0;
    return `Windows ${build >= 22000 ? 11 : 10} (build ${build}, ${arch})`;
  }
  return `${platform} ${release} (${arch})`;
}

const isoOrNull = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/**
 * @param {{ url?: string, version: string, platform?: string, arch?: string, systemVersion?: string,
 *   release?: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   store: { readAll(): object, update(change: (draft: object) => void): object } }} options
 *   store: lib/state.cjs's store (the install ID is kept under reportInstallId).
 */
function createReporter({
  url = REPORT_URL, version, platform = process.platform, arch = process.arch,
  systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
  release = os.release(), fetchImpl = fetch, store, timeoutMs = TIMEOUT_MS,
}) {
  const label = osLabel({ platform, arch, systemVersion, release });

  function installId() {
    const saved = store.readAll().reportInstallId;
    if (typeof saved === 'string' && UUID_V4.test(saved)) return saved;
    const made = randomUUID();
    store.update((draft) => { draft.reportInstallId = made; });
    return made;
  }

  return {
    /** Whether this build sends reports, and the system as a report names it. */
    get: () => ({ available: Boolean(url), osLabel: label }),

    /** Never throws for an outcome: { sent: true, remaining, resetAt } or { sent: false, code, resetAt }. */
    async send(text) {
      if (!url) return { sent: false, code: 'UNAVAILABLE' };
      const message = typeof text === 'string' ? text.replace(CONTROL, '').trim() : '';
      if (message.length < MIN_LENGTH || message.length > MAX_LENGTH) return { sent: false, code: 'INVALID' };
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': `ScaleMax-IDE/${version}` },
          body: JSON.stringify({ installId: installId(), message, version, os: label }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { sent: false, code: 'NETWORK' };
      }
      let body = null;
      try { body = await response.json(); } catch { /* not JSON: no answer from the relay */ }
      if (response.ok && body?.ok === true) {
        return { sent: true, remaining: Number.isInteger(body.remaining) ? body.remaining : 0, resetAt: isoOrNull(body.resetAt) };
      }
      return { sent: false, code: RELAY_CODES.has(body?.code) ? body.code : 'NETWORK', resetAt: isoOrNull(body?.resetAt) };
    },
  };
}

module.exports = { REPORT_URL, MIN_LENGTH, MAX_LENGTH, osLabel, createReporter };
