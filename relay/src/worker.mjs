// The bug-report relay: POST /report from ScaleMax IDE (lib/bug-report.cjs) → the checks and
// limits in logic.mjs → the developer's Telegram. The bot token, the chat ID and the address salt
// are secrets (README.md). One Limiter Durable Object counts every report, so the limits hold for
// reports that arrive together.
import { DurableObject } from 'cloudflare:workers';
import { validateReport, decide, formatMessage, hashAddress, WINDOW_MS, MAX_BODY_BYTES } from './logic.mjs';

const TELEGRAM_TIMEOUT_MS = 10_000;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** True when Telegram took the message. */
async function sendTelegram(env, text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class Limiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS reports (rid TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS reports_by_key ON reports (scope, key, at)');
  }

  times(scope, key) {
    return this.sql.exec('SELECT at FROM reports WHERE scope = ? AND key = ? ORDER BY at', scope, key).toArray().map((row) => row.at);
  }

  /** Checks the limits, reserves the report, sends it; the reservation goes again if Telegram fails. */
  async submit(report, address) {
    const now = Date.now();
    this.sql.exec('DELETE FROM reports WHERE at <= ?', now - WINDOW_MS);
    const keys = [['install', report.installId], ['address', address], ['total', '*']];
    const [install, byAddress, total] = keys.map(([scope, key]) => this.times(scope, key));
    const decision = decide({ install, address: byAddress, total }, now);
    if (!decision.ok) {
      return { status: 429, body: { ok: false, code: decision.code, resetAt: new Date(decision.resetAt).toISOString() } };
    }
    // Reserved before the send, with no await in between: a report that arrives while Telegram
    // answers is counted against this one.
    const rid = crypto.randomUUID();
    for (const [scope, key] of keys) this.sql.exec('INSERT INTO reports (rid, scope, key, at) VALUES (?, ?, ?, ?)', rid, scope, key, now);
    if (!(await sendTelegram(this.env, formatMessage(report, decision.ordinal)))) {
      this.sql.exec('DELETE FROM reports WHERE rid = ?', rid);
      return { status: 502, body: { ok: false, code: 'TELEGRAM' } };
    }
    return { status: 200, body: { ok: true, remaining: decision.remaining, resetAt: new Date(decision.resetAt).toISOString() } };
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/report') return json(404, { ok: false, code: 'NOT_FOUND' });
    if (request.method !== 'POST') return json(405, { ok: false, code: 'METHOD' }, { allow: 'POST' });
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json(413, { ok: false, code: 'TOO_LARGE' });
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { ok: false, code: 'TOO_LARGE' });
    let body = null;
    try { body = JSON.parse(text); } catch { /* answered as INVALID below */ }
    const checked = validateReport(body);
    if (!checked.ok) return json(400, { ok: false, code: 'INVALID' });
    const address = await hashAddress(env.IP_SALT, request.headers.get('cf-connecting-ip') || 'unknown');
    const limiter = env.LIMITER.get(env.LIMITER.idFromName('global'));
    const { status, body: answer } = await limiter.submit(checked.report, address);
    return json(status, answer);
  },
};
