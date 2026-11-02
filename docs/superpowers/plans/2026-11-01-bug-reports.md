# Bug Reports to Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People using ScaleMax IDE can send a short bug report from the app. It arrives in the developer's Telegram, and one install can send at most 3 in 24 hours.

**Architecture:** A Cloudflare Worker in `relay/` holds the Telegram bot token as a secret and counts reports in one SQLite-backed Durable Object: 3 per install, 10 per network address and 100 in total, each over a rolling 24 hours. The app's main process (`lib/bug-report.cjs`) posts `{ installId, message, version, os }` to the Worker, because the page has `connect-src 'none'`. The page (`src/report-ui.js`) adds a card in Preferences & about, a dialog, a `/bug` slash command and a search entry. All of it stays hidden while `REPORT_URL` is empty.

**Tech Stack:**
- the app: Electron 33 (main process Node 20, global `fetch`), vanilla ES modules in `src/`, `node --test`;
- the relay: a Cloudflare Worker with a Durable Object (SQLite storage API) and wrangler 4 through `npx`. It has no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-bug-reports-design.md`

## Global Constraints

**Code and git:**
- Work on branch `feat/bug-reports`, cut from `main` at `d6b40a1`. Use `/usr/bin/git` (the git at `/usr/local/bin` is 2.15 and lacks options used here).
- Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Add no npm dependency to the app, and give `relay/` no `package.json`.
- The page's Content-Security-Policy stays `connect-src 'none'`. All networking happens in main.
- Build the page's DOM with `createElement` and `textContent` only, never HTML strings.
- Never write a bot token, chat ID or salt into any file. They exist only as Worker secrets.

**Limits** (rolling 24 hours):
- 3 per install (`LIMIT`);
- 10 per network address (`NETWORK_LIMIT`);
- 100 in total (`BUSY`).

**What a report may hold:**
- a message of 10–2,000 characters after trimming, with control characters other than `\n` and `\t` removed;
- `installId`, a lowercase v4 UUID;
- `version` matching `^[0-9A-Za-z.+-]{1,40}$`;
- `os` of 1–80 printable ASCII characters;
- a request body of at most 16 KB.

**Timeouts:** the app waits 15 s for the Worker, and the Worker waits 10 s for Telegram.

**Copy** (exact):
- toast after a send: "Report sent. Thank you. You can send N more today." with N > 0, or "Report sent. Thank you. That was your last one for today." at 0;
- `LIMIT`: "You've sent 3 reports today. You can send another after 3:40 PM." ("tomorrow after …" when not today; "Please try again tomorrow." when there is no time);
- `NETWORK_LIMIT`: "Too many reports came from your network today. You can send another after …";
- `BUSY`: "Reports are paused for today. Please try again tomorrow.";
- `UNAVAILABLE`: "Bug reports aren't available in this version.";
- anything else: "The report wasn't sent. Check your connection and try again."

**Where tests run:**
- Single test files run locally in about a second: `node --test test/<file>`.
- The full suite (`npm test`), the Electron smoke check and the wrangler dry run are heavy. Run them in GitHub Actions on the PR (macOS and Windows) or on the VPS (`ssh cpu`), never on this Mac.

---

## File Structure

| File | Responsibility |
|---|---|
| `relay/src/logic.mjs` (new) | Pure rules: `validateReport`, `decide`, `formatMessage`, `hashAddress`, constants. No Cloudflare APIs, so `node --test` imports it. |
| `relay/src/worker.mjs` (new) | The fetch handler (`POST /report`) and the `Limiter` Durable Object (check → reserve → Telegram → release on failure). |
| `relay/wrangler.toml` (new) | Worker name, the `LIMITER` binding and the SQLite class migration. |
| `relay/README.md` (new) | One-time setup: the bot, the chat ID, secrets, deploy, a curl test. |
| `lib/bug-report.cjs` (new) | Main process: `REPORT_URL`, `osLabel`, `createReporter` (install ID, request, outcome mapping). |
| `main.js`, `preload.js` | `report:get` and `report:send` IPC, and `scalemaxAPI.report`. Smoke runs get a stub. |
| `src/report-ui.js` (new) | Text helpers (`canSend`, `laterText`, `outcomeText`, `systemText`, `REPORT_ACTION`) and the card and dialog (`bindReportUi`, `openReportDialog`, `reportAvailable`). |
| `src/index.html`, `src/styles.css` | The card above Updates, the dialog, three small style rules. |
| `src/app.js` | Binds the UI, passes the search action, opens it from search. |
| `src/slash-ui.js`, `lib/slash-commands.cjs` | The `/bug` built-in. |
| `src/domain.mjs` | `searchItems(…, { actions })`. |
| `build/smoke-check.cjs` | One new check, `bugReport`. |
| `test/bug-relay.test.mjs`, `test/bug-report.test.cjs`, `test/report-ui.test.mjs` (new), `test/domain.test.mjs` | Tests. |
| `README.md`, `HANDOFF.md` | Docs. |

---

### Task 0: Branch

- [ ] **Step 1: Cut the branch**

```bash
cd /Users/sagaraggarwal/Desktop/scalemax-ide
/usr/bin/git fetch origin -q && /usr/bin/git checkout -b feat/bug-reports origin/main
/usr/bin/git log --oneline -1
```
Expected: `d6b40a1 Merge PR #12: CI: check Windows updates, through the real Update now` (or a later main).

- [ ] **Step 2: Commit the spec and this plan**

```bash
/usr/bin/git add docs/superpowers/specs/2026-11-01-bug-reports-design.md docs/superpowers/plans/2026-11-01-bug-reports.md
/usr/bin/git commit -q -F - <<'EOF'
Docs: the bug-report design and its plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 1: The relay's rules (`relay/src/logic.mjs`)

**Files:**
- Create: `relay/src/logic.mjs`
- Test: `test/bug-relay.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 2):
  - `LIMITS = { install: 3, address: 10, total: 100 }`, `WINDOW_MS = 86_400_000`, `MAX_BODY_BYTES = 16384`.
  - `validateReport(body) → { ok: true, report: { installId, message, version, os } } | { ok: false }`.
  - `decide({ install: number[], address: number[], total: number[] }, now: number)`. Each array holds the times (ms) of the counted reports in the last 24 hours, oldest first. It returns `{ ok: true, ordinal, remaining, resetAt }` or `{ ok: false, code: 'LIMIT'|'NETWORK_LIMIT'|'BUSY', resetAt }`.
  - `formatMessage(report, ordinal) → string`.
  - `async hashAddress(salt, address) → 64-char lowercase hex`.

- [ ] **Step 1: Write the failing test**

Create `test/bug-relay.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/bug-relay.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `relay/src/logic.mjs`.

- [ ] **Step 3: Write `relay/src/logic.mjs`**

```js
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
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/bug-relay.test.mjs`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add relay/src/logic.mjs test/bug-relay.test.mjs
/usr/bin/git commit -q -F - <<'EOF'
Relay: what a bug report may hold, its limits and its Telegram text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The Worker and its counter (`relay/`)

**Files:**
- Create: `relay/src/worker.mjs`, `relay/wrangler.toml`, `relay/README.md`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: the HTTP contract that Task 3 relies on.
  - `POST /report` with a JSON body `{ installId, message, version, os }`.
  - `200 { ok: true, remaining, resetAt }`.
  - `429 { ok: false, code: 'LIMIT'|'NETWORK_LIMIT'|'BUSY', resetAt }`.
  - `400 { ok: false, code: 'INVALID' }`, `502 { ok: false, code: 'TELEGRAM' }`, `413 { ok: false, code: 'TOO_LARGE' }`, `404`, `405`.
  - `resetAt` is an ISO 8601 string.

- [ ] **Step 1: Write `relay/src/worker.mjs`**

```js
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
```

- [ ] **Step 2: Write `relay/wrangler.toml`**

```toml
# The bug-report relay (README.md). Its secrets are set with `npx wrangler secret put`, never here:
# TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, IP_SALT.
name = "scalemax-bug-relay"
main = "src/worker.mjs"
compatibility_date = "2025-10-01"
workers_dev = true

[[durable_objects.bindings]]
name = "LIMITER"
class_name = "Limiter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Limiter"]
```

- [ ] **Step 3: Write `relay/README.md`**

````markdown
# Bug-report relay

A Cloudflare Worker that takes bug reports from ScaleMax IDE (`lib/bug-report.cjs`) and forwards
each one to your Telegram. It holds the bot token, so the app never does. It allows 3 reports per
install, 10 per network address and 100 in total, each over a rolling 24 hours (`src/logic.mjs`).
It keeps addresses only as salted hashes, and forgets every count after 24 hours.

It is not part of the app: `package.json`'s `build.files` leaves this folder out.

## Set it up (once)

1. **Make a bot.** In Telegram, message @BotFather, send `/newbot`, and copy the token it gives you.
2. **Find your chat ID.** Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. The number at
   `result[0].message.chat.id` is your chat ID.
3. **Log in to Cloudflare** (a free account is enough) from this folder:
   ```bash
   cd relay
   npx --yes wrangler@4 login
   ```
4. **Add the secrets.** Each command asks for the value. The salt can be any long random string.
   ```bash
   npx --yes wrangler@4 secret put TELEGRAM_BOT_TOKEN
   npx --yes wrangler@4 secret put TELEGRAM_CHAT_ID
   openssl rand -hex 32 | npx --yes wrangler@4 secret put IP_SALT
   ```
5. **Deploy.**
   ```bash
   npx --yes wrangler@4 deploy
   ```
   It prints the Worker's address, `https://scalemax-bug-relay.<your-subdomain>.workers.dev`.
6. **Send a test report.** It should arrive in Telegram within a few seconds. It counts as one of
   that install ID's 3 for the next 24 hours.
   ```bash
   curl -sS -X POST "https://scalemax-bug-relay.<your-subdomain>.workers.dev/report" \
     -H 'content-type: application/json' \
     -d '{"installId":"3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f","message":"Test report from curl.","version":"1.0.0-beta.8","os":"macOS 15.1 (arm64)"}'
   ```
   The answer is `{"ok":true,"remaining":2,"resetAt":"…"}`.
7. **Turn reports on in the app.** Set `REPORT_URL` in `lib/bug-report.cjs` to that address plus
   `/report`, then release.

## Answers

| Status | Body | When |
|---|---|---|
| 200 | `{ ok: true, remaining, resetAt }` | sent |
| 400 | `{ ok: false, code: "INVALID" }` | a field is missing or wrong |
| 413 | `{ ok: false, code: "TOO_LARGE" }` | the body is over 16 KB |
| 429 | `{ ok: false, code: "LIMIT" \| "NETWORK_LIMIT" \| "BUSY", resetAt }` | a limit was reached |
| 502 | `{ ok: false, code: "TELEGRAM" }` | Telegram didn't take it (the report isn't counted) |
````

- [ ] **Step 4: Check that the Worker bundles (on the VPS, not this Mac)**

```bash
cd /Users/sagaraggarwal/Desktop/scalemax-ide
ssh cpu 'rm -rf /tmp/scalemax-relay && mkdir -p /tmp/scalemax-relay'
scp -q -r relay/src relay/wrangler.toml cpu:/tmp/scalemax-relay/
ssh cpu 'cd /tmp/scalemax-relay && npx --yes wrangler@4 deploy --dry-run --outdir /tmp/scalemax-relay-out 2>&1 | tail -15'
```
Expected:
- the output lists the binding `env.LIMITER (Limiter)` as a Durable Object;
- it ends with `--dry-run: exiting now.`;
- there is no build error.

No login is needed for a dry run.

- [ ] **Step 5: Confirm the app's package still leaves `relay/` out**

Run: `node -p "require('./package.json').build.files.some((pattern) => pattern.startsWith('relay'))"`
Expected: `false`

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add relay/src/worker.mjs relay/wrangler.toml relay/README.md
/usr/bin/git commit -q -F - <<'EOF'
Relay: a Cloudflare Worker that forwards bug reports to Telegram

One SQLite Durable Object counts every report (3 per install, 10 per address, 100 in all,
over 24 hours) and reserves a report before sending it, so reports that arrive together
can't get past the limits. The bot token stays a Worker secret.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The app's reporter and its bridge (`lib/bug-report.cjs`, `main.js`, `preload.js`)

**Files:**
- Create: `lib/bug-report.cjs`
- Modify: `main.js` (a require near line 15; a new block after the Updates block that ends with `function scheduleUpdateChecks() { … }`, around line 990), `preload.js` (after the `updates: { … },` block, around line 34)
- Test: `test/bug-report.test.cjs`

**Interfaces:**
- Consumes: the HTTP contract from Task 2.
- Produces (used by Tasks 5 and 6):
  - `scalemaxAPI.report.get() → { ok: true, data: { available: boolean, osLabel: string } }`.
  - `scalemaxAPI.report.send(message) → { ok: true, data: { sent: true, remaining: number, resetAt: string|null } | { sent: false, code: string, resetAt?: string|null } }`.
  - The codes are `INVALID`, `LIMIT`, `NETWORK_LIMIT`, `BUSY`, `TELEGRAM`, `NETWORK` and `UNAVAILABLE`. A failed IPC call answers `{ ok: false, error: { code, message } }`.
  - Module exports: `{ REPORT_URL, MIN_LENGTH, MAX_LENGTH, osLabel, createReporter }`.
  - The install ID is stored under the main-only state key `reportInstallId`. It is not in `PUBLIC_KEYS`, so the page can't read it.

- [ ] **Step 1: Write the failing test**

Create `test/bug-report.test.cjs`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReporter, osLabel, REPORT_URL } = require('../lib/bug-report.cjs');

const RELAY = 'https://relay.example/report';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE = 'The editor froze after Undo all.';

// The two calls lib/state.cjs's store offers that the reporter uses.
function memoryStore(initial = {}) {
  let data = { ...initial };
  return {
    readAll: () => data,
    update: (change) => { const draft = structuredClone(data); change(draft); data = draft; return data; },
    get data() { return data; },
  };
}
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function reporter(overrides = {}) {
  const calls = [];
  const store = overrides.store || memoryStore();
  const fetchImpl = overrides.fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    return answer(200, { ok: true, remaining: 2, resetAt: '2026-11-02T10:00:00.000Z' });
  });
  const made = createReporter({
    url: RELAY, version: '1.0.0-beta.8', platform: 'darwin', arch: 'arm64', systemVersion: '15.1.0', release: '24.1.0',
    ...overrides, fetchImpl, store,
  });
  return { made, calls, store };
}

test('the system is named the way people know it', () => {
  assert.equal(osLabel({ platform: 'darwin', arch: 'arm64', systemVersion: '15.1.0' }), 'macOS 15.1 (arm64)');
  assert.equal(osLabel({ platform: 'darwin', arch: 'arm64', systemVersion: '14.7.1' }), 'macOS 14.7.1 (arm64)');
  assert.equal(osLabel({ platform: 'win32', arch: 'x64', systemVersion: '10.0.22631' }), 'Windows 11 (build 22631, x64)');
  assert.equal(osLabel({ platform: 'win32', arch: 'x64', systemVersion: '10.0.19045' }), 'Windows 10 (build 19045, x64)');
  assert.equal(osLabel({ platform: 'linux', arch: 'x64', systemVersion: '6.8.0-45-generic', release: '6.8.0-45-generic' }), 'linux 6.8.0-45-generic (x64)');
});

test('a report posts the message, the version and the system, with an install ID made once', async () => {
  const { made, calls, store } = reporter();
  assert.deepEqual(made.get(), { available: true, osLabel: 'macOS 15.1 (arm64)' });
  assert.equal(store.data.reportInstallId, undefined, 'no ID before the first report');
  assert.deepEqual(await made.send(`  ${MESSAGE}  `), { sent: true, remaining: 2, resetAt: '2026-11-02T10:00:00.000Z' });
  const id = store.data.reportInstallId;
  assert.match(id, UUID_V4);
  assert.equal(calls[0].url, RELAY);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['user-agent'], 'ScaleMax-IDE/1.0.0-beta.8');
  assert.deepEqual(JSON.parse(calls[0].init.body), { installId: id, message: MESSAGE, version: '1.0.0-beta.8', os: 'macOS 15.1 (arm64)' });
  await made.send('A second report from the same install.');
  assert.equal(JSON.parse(calls[1].init.body).installId, id);
});

test('a saved install ID is reused, and a damaged one replaced', async () => {
  const saved = '3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f';
  const kept = reporter({ store: memoryStore({ reportInstallId: saved }) });
  await kept.made.send(MESSAGE);
  assert.equal(JSON.parse(kept.calls[0].init.body).installId, saved);
  const damaged = reporter({ store: memoryStore({ reportInstallId: 'nope' }) });
  await damaged.made.send(MESSAGE);
  assert.match(damaged.store.data.reportInstallId, UUID_V4);
});

test('a message under 10 or over 2,000 characters is not sent', async () => {
  const { made, calls } = reporter();
  assert.deepEqual(await made.send('   short   '), { sent: false, code: 'INVALID' });
  assert.deepEqual(await made.send('x'.repeat(2001)), { sent: false, code: 'INVALID' });
  assert.deepEqual(await made.send(null), { sent: false, code: 'INVALID' });
  assert.equal(calls.length, 0);
});

test("the relay's refusals come back with their code and time", async () => {
  for (const [status, body, expected] of [
    [429, { ok: false, code: 'LIMIT', resetAt: '2026-11-02T10:00:00.000Z' }, { sent: false, code: 'LIMIT', resetAt: '2026-11-02T10:00:00.000Z' }],
    [429, { ok: false, code: 'NETWORK_LIMIT', resetAt: '2026-11-02T11:00:00.000Z' }, { sent: false, code: 'NETWORK_LIMIT', resetAt: '2026-11-02T11:00:00.000Z' }],
    [429, { ok: false, code: 'BUSY', resetAt: 'not a date' }, { sent: false, code: 'BUSY', resetAt: null }],
    [502, { ok: false, code: 'TELEGRAM' }, { sent: false, code: 'TELEGRAM', resetAt: null }],
    [400, { ok: false, code: 'INVALID' }, { sent: false, code: 'INVALID', resetAt: null }],
    [500, { ok: false, code: 'SOMETHING_ELSE' }, { sent: false, code: 'NETWORK', resetAt: null }],
  ]) {
    const { made } = reporter({ fetchImpl: async () => answer(status, body) });
    assert.deepEqual(await made.send(MESSAGE), expected, body.code);
  }
  const { made } = reporter({ fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
  assert.deepEqual(await made.send(MESSAGE), { sent: false, code: 'NETWORK', resetAt: null });
});

test('no answer in time, or no network, is NETWORK', async () => {
  const hanging = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const slow = reporter({ fetchImpl: hanging, timeoutMs: 20 });
  assert.deepEqual(await slow.made.send(MESSAGE), { sent: false, code: 'NETWORK' });
  const offline = reporter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await offline.made.send(MESSAGE), { sent: false, code: 'NETWORK' });
});

test('without a relay URL reports are off and nothing is sent', async () => {
  const { made, calls } = reporter({ url: '' });
  assert.equal(made.get().available, false);
  assert.deepEqual(await made.send(MESSAGE), { sent: false, code: 'UNAVAILABLE' });
  assert.equal(calls.length, 0);
  assert.ok(REPORT_URL === '' || /^https:\/\/[^/]+\/report$/.test(REPORT_URL), 'the relay URL is https and ends in /report');
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/bug-report.test.cjs`
Expected: FAIL with `Cannot find module '../lib/bug-report.cjs'`.

- [ ] **Step 3: Write `lib/bug-report.cjs`**

```js
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
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/bug-report.test.cjs`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Wire it into main**

In `main.js`, next to `const { createUpdater } = require('./lib/updates.cjs');` (line 15), add:

```js
const { createReporter } = require('./lib/bug-report.cjs');
```

Right after the closing `}` of `function scheduleUpdateChecks() { … }` (around line 990), add:

```js

// ---------------------------------------------------------------------------
// Bug reports (lib/bug-report.cjs): the message, the version and the system, to the developer's
// Telegram through the relay in relay/. The smoke run answers from a stub and never goes online.
// ---------------------------------------------------------------------------
const REPORT_SMOKE = process.env.SCALEMAX_SMOKE === '1' ? {
  url: 'https://smoke.invalid/report',
  // A message with "smoke-limit" in it is refused the way the relay refuses a 4th report.
  fetchImpl: async (_url, init) => {
    const limited = JSON.parse(init.body).message.includes('smoke-limit');
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return new Response(JSON.stringify(limited ? { ok: false, code: 'LIMIT', resetAt } : { ok: true, remaining: 2, resetAt }),
      { status: limited ? 429 : 200, headers: { 'content-type': 'application/json' } });
  },
} : {};
const reporter = createReporter({ version: app.getVersion(), store: stateStore, ...REPORT_SMOKE });
const REPORT_FALLBACK = { code: 'REPORT_ERROR', message: 'The report could not be sent.' };
ipcMain.handle('report:get', wrap(() => reporter.get(), REPORT_FALLBACK));
ipcMain.handle('report:send', wrap((_event, message) => reporter.send(message), REPORT_FALLBACK));
```

(`wrap` is a function declaration further down, so it is already defined here, as for the update channels above.)

- [ ] **Step 6: Expose it in preload**

In `preload.js`, after the `updates: { … },` block (its closing `},` is around line 34), add:

```js

  /**
   * Bug reports (lib/bug-report.cjs): the message, with the app's version and the system, to the
   * developer. get() → { available, osLabel }; send(message) → { sent, remaining?, resetAt?, code? }.
   */
  report: {
    get: () => ipcRenderer.invoke('report:get'),
    send: (message) => ipcRenderer.invoke('report:send', message)
  },
```

- [ ] **Step 7: Check the syntax**

Run: `node --check main.js && node --check preload.js && node --check lib/bug-report.cjs && echo ok`
Expected: `ok`

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add lib/bug-report.cjs test/bug-report.test.cjs main.js preload.js
/usr/bin/git commit -q -F - <<'EOF'
Bug reports: send the message, version and system to the relay from main

Off while REPORT_URL is empty. The install ID is random, made at the first report and
kept where the page can't read it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: What the person is told (`src/report-ui.js`, text helpers)

**Files:**
- Create: `src/report-ui.js` (helpers only; Task 5 adds the DOM part to the same file)
- Test: `test/report-ui.test.mjs`

**Interfaces:**
- Consumes: the outcome shapes from Task 3.
- Produces (used by Tasks 5 and 6):
  - `MIN_LENGTH = 10`, `MAX_LENGTH = 2000`;
  - `REPORT_ACTION = { id: 'report-bug', title: 'Report a bug', description: 'Tell the developer about a problem', keywords: ['bug', 'report', 'feedback', 'problem'] }`;
  - `canSend(text) → boolean`;
  - `laterText(resetAt, now?, locale?) → 'after 3:40 PM' | 'tomorrow after 8:05 AM'`;
  - `outcomeText(outcome, now?, locale?) → string`;
  - `systemText(osLabel) → 'macOS 15.1, arm64'`.

- [ ] **Step 1: Write the failing test**

Create `test/report-ui.test.mjs`:

```js
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
  for (const code of ['NETWORK', 'TELEGRAM', 'REPORT_ERROR', 'INVALID_ANSWER', undefined]) assert.equal(outcomeText({ sent: false, code }), RETRY, String(code));
  assert.equal(outcomeText(null), RETRY);
  assert.equal(outcomeText({ sent: false, code: 'INVALID' }), 'Write at least 10 characters, and at most 2,000.');
  assert.equal(outcomeText({ sent: false, code: 'UNAVAILABLE' }), "Bug reports aren't available in this version.");
});

test("the card names this computer's system; search finds Report a bug by its words", () => {
  assert.equal(systemText('macOS 15.1 (arm64)'), 'macOS 15.1, arm64');
  assert.equal(systemText('Windows 11 (build 22631, x64)'), 'Windows 11, build 22631, x64');
  assert.equal(systemText(''), '');
  assert.deepEqual({ ...REPORT_ACTION, keywords: [...REPORT_ACTION.keywords] }, {
    id: 'report-bug', title: 'Report a bug', description: 'Tell the developer about a problem', keywords: ['bug', 'report', 'feedback', 'problem'],
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `node --test test/report-ui.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/report-ui.js`.

- [ ] **Step 3: Write the helpers in `src/report-ui.js`**

```js
// Bug reports (lib/bug-report.cjs through the bridge's `report`): the Report a bug card in
// Preferences & about, its dialog, /bug in the message box (src/slash-ui.js) and the Report a bug
// entry in search (src/domain.mjs searchItems). A report is the person's message; main adds the
// app's version and the system and sends nothing else. DOM by createElement / textContent only.

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 2000;

/** The search entry: src/app.js renderSearch passes it to searchItems while reports are on. */
export const REPORT_ACTION = Object.freeze({
  id: 'report-bug',
  title: 'Report a bug',
  description: 'Tell the developer about a problem',
  keywords: Object.freeze(['bug', 'report', 'feedback', 'problem']),
});

/** True when the text, trimmed, has 10–2,000 characters. */
export function canSend(text) {
  const length = String(text ?? '').trim().length;
  return length >= MIN_LENGTH && length <= MAX_LENGTH;
}

/** "after 3:40 PM", or "tomorrow after 8:05 AM" when that isn't today (local time). */
export function laterText(resetAt, now = new Date(), locale = undefined) {
  const at = new Date(resetAt);
  // ICU puts a narrow no-break space before AM/PM; the sentence reads the same with a space.
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ');
  return at.toDateString() === now.toDateString() ? `after ${time}` : `tomorrow after ${time}`;
}

/** What the person is told after report.send() answered: the toast when sent, else the dialog's line. */
export function outcomeText(outcome, now = new Date(), locale = undefined) {
  if (outcome?.sent) {
    const left = Number(outcome.remaining) || 0;
    return left > 0 ? `Report sent. Thank you. You can send ${left} more today.` : 'Report sent. Thank you. That was your last one for today.';
  }
  const until = (lead) => (typeof outcome?.resetAt === 'string' && Number.isFinite(Date.parse(outcome.resetAt))
    ? `${lead} You can send another ${laterText(outcome.resetAt, now, locale)}.`
    : `${lead} Please try again tomorrow.`);
  switch (outcome?.code) {
    case 'LIMIT': return until("You've sent 3 reports today.");
    case 'NETWORK_LIMIT': return until('Too many reports came from your network today.');
    case 'BUSY': return 'Reports are paused for today. Please try again tomorrow.';
    case 'UNAVAILABLE': return "Bug reports aren't available in this version.";
    case 'INVALID': return 'Write at least 10 characters, and at most 2,000.';
    default: return "The report wasn't sent. Check your connection and try again.";
  }
}

/** "macOS 15.1, arm64" from main's "macOS 15.1 (arm64)", for the card's sentence. */
export function systemText(osLabel) {
  return String(osLabel || '').replace(' (', ', ').replace(/\)$/, '');
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test test/report-ui.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/report-ui.js test/report-ui.test.mjs
/usr/bin/git commit -q -F - <<'EOF'
Bug reports: what the person is told after a send

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: The card and the dialog

**Files:**
- Modify: `src/report-ui.js` (append the DOM part), `src/index.html` (the card before `<!-- Updates (src/updates-ui.js, lib/updates.cjs): newer releases from GitHub. -->`, and the dialog after the `#confirm-dialog` element, before `<div id="toast"`), `src/styles.css` (after the `.updates-card .preference-row` rule, around line 1914), `src/app.js` (the import near line 22, and the bind next to `bindUpdatesUi(this);` at line 332), `build/smoke-check.cjs` (a new block before `const checks = probe ? {`, around line 1524, a new check, and `report` in the result line)

**Interfaces:**
- Consumes:
  - from Task 3: `scalemaxAPI.report.get()` and `.send()`;
  - from Task 4: `canSend`, `outcomeText`, `systemText`, `MAX_LENGTH`;
  - from `app`: `showToast(message)`.
- Produces (used by Task 6):
  - `bindReportUi(app)`;
  - `openReportDialog(text = '')`: it shows the UNAVAILABLE toast instead when reports are off;
  - `reportAvailable() → boolean`;
  - DOM ids: `#report-card`, `#report-desc`, `#report-open`, `#report-dialog`, `#report-message`, `#report-count`, `#report-error`, `#report-cancel`, `#report-send`.

- [ ] **Step 1: Add the markup to `src/index.html`**

Immediately before the line `            <!-- Updates (src/updates-ui.js, lib/updates.cjs): newer releases from GitHub. -->`, add:

```html
            <!-- Bug reports (src/report-ui.js, lib/bug-report.cjs): to the developer through relay/. Shown once main says reports are on. -->
            <section id="report-card" class="settings-card report-card" aria-labelledby="report-title" hidden>
              <h2 id="report-title">Report a bug</h2>
              <p id="report-desc" class="status-text">Something not working? Tell the developer.</p>
              <div class="button-row"><button id="report-open" class="button secondary" type="button">Report a bug…</button></div>
            </section>
```

Immediately before `  <div id="toast" role="status" aria-live="polite" aria-atomic="true"></div>`, add:

```html
  <!-- A bug report (src/report-ui.js): the message only; main adds the version and the system. -->
  <dialog id="report-dialog" class="consent-dialog report-dialog" aria-labelledby="report-dialog-title" aria-describedby="report-dialog-desc">
    <div class="dialog-header">
      <div><h2 id="report-dialog-title">Report a bug</h2></div>
    </div>
    <div class="dialog-body">
      <p id="report-dialog-desc" class="body-copy">The developer gets your message, the app's version and your system. Nothing else.</p>
      <label for="report-message" class="commit-label">What went wrong?</label>
      <textarea id="report-message" rows="6" maxlength="2000" placeholder="What you did, what you expected, what happened" spellcheck="true"></textarea>
      <p id="report-count" class="commit-hint report-count">0 / 2,000</p>
      <p id="report-error" class="report-error" role="alert" hidden></p>
      <div class="button-row consent-actions">
        <button id="report-cancel" class="button secondary" type="button">Cancel</button>
        <button id="report-send" class="button primary" type="button" disabled>Send report</button>
      </div>
    </div>
  </dialog>

```

- [ ] **Step 2: Add the styles to `src/styles.css`**

After the `.updates-card .preference-row { … }` rule (around line 1914), add:

```css

/* Report a bug (src/report-ui.js): the dialog's box, its count and what went wrong. */
.report-dialog textarea {
  display: block;
  width: 100%;
  min-height: 132px;
  margin-top: 8px;
  resize: vertical;
}

.report-count {
  margin: 4px 0 0;
  text-align: end;
  font-variant-numeric: tabular-nums;
}

.report-error {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--sm-error-foreground);
}
```

- [ ] **Step 3: Append the DOM part to `src/report-ui.js`**

Add at the end of the file:

```js

const $ = (selector) => document.querySelector(selector);
const state = { app: null, info: { available: false, osLabel: '' }, bound: false, sending: false };

/** Whether this build sends reports (main's REPORT_URL is set). */
export function reportAvailable() {
  return state.info.available === true;
}

function setError(text) {
  const node = $('#report-error');
  if (!node) return;
  node.textContent = text;
  node.hidden = !text;
}

function renderForm() {
  const input = $('#report-message');
  const count = $('#report-count');
  if (count) count.textContent = `${(input?.value.length || 0).toLocaleString('en-US')} / 2,000`;
  const send = $('#report-send');
  if (send) {
    send.disabled = state.sending || !canSend(input?.value);
    send.textContent = state.sending ? 'Sending…' : 'Send report';
  }
  if (input) input.disabled = state.sending;
}

function renderCard() {
  const card = $('#report-card');
  if (card) card.hidden = !reportAvailable();
  const description = $('#report-desc');
  if (description && state.info.osLabel) {
    description.textContent = `Something not working? Tell the developer. ScaleMax sends your message, the app's version and your system (${systemText(state.info.osLabel)}), nothing else: no files, chats or keys. Up to 3 reports a day.`;
  }
}

/** Opens the dialog with `text` already in the box (/bug some words). Reports off: says so instead. */
export function openReportDialog(text = '') {
  if (!reportAvailable()) {
    state.app?.showToast?.(outcomeText({ sent: false, code: 'UNAVAILABLE' }));
    return;
  }
  const dialog = $('#report-dialog');
  const input = $('#report-message');
  if (!dialog || !input) return;
  if (!state.sending) input.value = String(text || '').slice(0, MAX_LENGTH);
  setError('');
  renderForm();
  if (!dialog.open) dialog.showModal();
  input.focus();
}

async function send() {
  const input = $('#report-message');
  if (!input || state.sending || !canSend(input.value)) return;
  state.sending = true;
  setError('');
  renderForm();
  let outcome = { sent: false, code: 'NETWORK' };
  try {
    const result = await window.scalemaxAPI?.report?.send?.(input.value);
    if (result?.ok && result.data) outcome = result.data;
  } catch { /* no answer: the line below says so */ }
  state.sending = false;
  renderForm();
  if (outcome.sent) {
    input.value = '';
    $('#report-dialog')?.close();
    state.app?.showToast?.(outcomeText(outcome));
    return;
  }
  // The text stays in the box, so nothing typed is lost.
  setError(outcomeText(outcome));
  input.focus();
}

export function bindReportUi(app) {
  state.app = app;
  if (state.bound) return;
  state.bound = true;
  $('#report-open')?.addEventListener('click', () => openReportDialog());
  $('#report-message')?.addEventListener('input', () => renderForm());
  $('#report-send')?.addEventListener('click', () => send());
  $('#report-cancel')?.addEventListener('click', () => $('#report-dialog')?.close());
  renderCard();
  window.scalemaxAPI?.report?.get?.().then((result) => {
    if (!result?.ok) return;
    state.info = { available: result.data?.available === true, osLabel: String(result.data?.osLabel || '') };
    renderCard();
  }).catch(() => {});
}
```

- [ ] **Step 4: Bind it in `src/app.js`**

After `import { bindUpdatesUi } from './updates-ui.js';` (line 22), add:

```js
import { bindReportUi } from './report-ui.js';
```

After `    bindUpdatesUi(this);` (line 332), add:

```js
    bindReportUi(this);
```

- [ ] **Step 5: Re-run the helper tests (the module now has DOM code too, and must still import without a page)**

Run: `node --test test/report-ui.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 6: Add the smoke check in `build/smoke-check.cjs`**

Immediately before `  const checks = probe ? {` (around line 1524), add:

```js
  // Report a bug: the card shows (main answers from a stub in the smoke run), the dialog opens,
  // Send report waits for 10 characters, a refused send keeps the text and says why, and a sent
  // one closes it with the thank-you toast.
  let report = null;
  try {
    report = await win.webContents.executeJavaScript(`(async () => {
      const until = async (test, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (test()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
        return Boolean(test());
      };
      const info = await window.scalemaxAPI.report.get();
      const card = document.querySelector('#report-card');
      const cardShown = await until(() => !card.hidden, 3000);
      const cardText = document.querySelector('#report-desc').textContent;
      document.querySelector('#report-open').click();
      const dialog = document.querySelector('#report-dialog');
      const opened = dialog.open;
      const input = document.querySelector('#report-message');
      const send = document.querySelector('#report-send');
      input.value = 'short';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const shortDisabled = send.disabled;
      // Main's stub refuses a message with "smoke-limit" in it, as the relay refuses a 4th report.
      const kept = 'smoke-limit: this text stays in the box.';
      input.value = kept;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
      const refusedShown = await until(() => !document.querySelector('#report-error').hidden, 4000);
      const refusedText = document.querySelector('#report-error').textContent;
      const textKept = input.value === kept && dialog.open;
      input.value = 'The smoke check found a bug.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const count = document.querySelector('#report-count').textContent;
      const longEnabled = !send.disabled;
      send.click();
      const toasted = await until(() => /^Report sent\\. Thank you\\. You can send 2 more today\\.$/.test(document.querySelector('#toast')?.textContent || ''), 4000);
      return { info: info && info.ok ? info.data : null, cardShown, cardText, opened, shortDisabled, refusedShown, refusedText, textKept, longEnabled, count, toasted, closed: !dialog.open };
    })()`);
  } catch (error) {
    errors.push(`report check failed: ${error.message}`);
  }

```

In the `checks` object, after `hasBridge: probe.hasBridge,`, add:

```js
    // Report a bug: card, dialog and a send through main's stub (src/report-ui.js, lib/bug-report.cjs).
    bugReport: Boolean(report && report.info && report.info.available === true && report.cardShown
      && /^Something not working\? Tell the developer\. ScaleMax sends your message, the app's version and your system \(.+\), nothing else: no files, chats or keys\. Up to 3 reports a day\.$/.test(report.cardText)
      && report.refusedShown && /^You've sent 3 reports today\. You can send another (tomorrow )?after .+\.$/.test(report.refusedText) && report.textKept
      && report.opened && report.shortDisabled && report.longEnabled && report.count === '28 / 2,000' && report.toasted && report.closed),
```

In the result line, change:

```js
  console.log('SMOKE_RESULT ' + JSON.stringify({ ok, checks, probe, e2e, automation, workspace, live, errors, logs }, null, 2));
```

to:

```js
  console.log('SMOKE_RESULT ' + JSON.stringify({ ok, checks, probe, e2e, automation, workspace, live, report, errors, logs }, null, 2));
```

- [ ] **Step 7: Check the syntax**

Run (the `src/*.js` files are ES modules in a package without `"type": "module"`, so `node --check` reads them through `.mjs` copies):

```bash
CHECK=/private/tmp/claude-501/-Users-sagaraggarwal-Desktop/c0ecae47-17fe-40d6-837b-d2e8d3b5cf5d/scratchpad/syntax
mkdir -p "$CHECK" && cp src/app.js "$CHECK/app.mjs" && cp src/report-ui.js "$CHECK/report-ui.mjs"
node --check build/smoke-check.cjs && node --check "$CHECK/app.mjs" && node --check "$CHECK/report-ui.mjs" && echo ok
```
Expected: `ok`

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add src/report-ui.js src/index.html src/styles.css src/app.js build/smoke-check.cjs
/usr/bin/git commit -q -F - <<'EOF'
Bug reports: a Report a bug card in Preferences & about, and its dialog

Hidden while reports are off. A failed send keeps the text and says why; a sent one closes
with a thank-you that says how many are left today. The smoke run checks it through main's
stub.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: `/bug` and the search entry

**Files:**
- Modify:
  - `lib/slash-commands.cjs:28` (`BUILTIN_NAMES`);
  - `src/slash-ui.js`:
    - the header comment (lines 1–11);
    - `BUILTIN_COMMANDS` (line 22);
    - `commandList` (line 116);
    - the `runSlashCommand` switch (line 159);
  - `src/domain.mjs:1540` (`searchItems`);
  - `src/app.js`:
    - the import;
    - `renderSearch` (around line 4227);
    - `openSearchResult` (around line 4268);
    - the slash comment at line 2960;
  - `build/smoke-check.cjs` (extend the Task 5 block and check).
- Test: `test/domain.test.mjs` (add one test); `test/slash-ui.test.mjs` and `test/slash-commands.test.cjs` must keep passing.

**Interfaces:**
- Consumes from Task 5: `openReportDialog(text)`, `reportAvailable()`. From Task 4: `REPORT_ACTION`.
- Produces:
  - `searchItems(query, tasks, { experts, skills, actions })`. `actions` is a list of `{ id, title, description, keywords }`, and a match adds `{ kind: 'action', id, title, description }` after the tasks and before the resources.
  - The `/bug [what went wrong]` built-in.

- [ ] **Step 1: Write the failing search test**

Add at the end of `test/domain.test.mjs`:

```js
test('search lists an app action by its words, only when one is passed in', () => {
  const action = { id: 'report-bug', title: 'Report a bug', description: 'Tell the developer about a problem', keywords: ['bug', 'report', 'feedback', 'problem'] };
  for (const query of ['bug', 'Feedback', 'problem', 'report']) {
    assert.deepEqual(searchItems(query, [], { actions: [action] }).filter((item) => item.kind === 'action'),
      [{ kind: 'action', id: 'report-bug', title: 'Report a bug', description: 'Tell the developer about a problem' }], query);
  }
  assert.equal(searchItems('bug', []).some((item) => item.kind === 'action'), false);
  assert.equal(searchItems('zzz-nothing-matches', [], { actions: [action] }).length, 0);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/domain.test.mjs`
Expected: the new test FAILs (no `action` results); the others pass.

- [ ] **Step 3: Add actions to `searchItems` in `src/domain.mjs`**

Change the signature line:

```js
export function searchItems(query, tasks, { experts = [], skills = [] } = {}) {
```

to:

```js
export function searchItems(query, tasks, { experts = [], skills = [], actions = [] } = {}) {
```

Between the end of the tasks `for` loop (the `}` after `if (result.length === 100) return result;`) and `const customExperts = …`, add:

```js
  // The app's own actions (src/report-ui.js REPORT_ACTION), found by their words.
  for (const action of actions) {
    if (![action.title, action.description, ...(action.keywords || [])].some((text) => String(text).toLowerCase().includes(needle))) continue;
    result.push({ kind: 'action', id: action.id, title: action.title, description: action.description });
    if (result.length === 100) return result;
  }
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/domain.test.mjs`
Expected: all pass, `# fail 0`.

- [ ] **Step 5: Add `/bug` to both built-in lists**

In `lib/slash-commands.cjs`, change:

```js
const BUILTIN_NAMES = Object.freeze(['clear', 'compact', 'cost', 'help', 'init', 'mode', 'model', 'plan', 'review']);
```

to:

```js
const BUILTIN_NAMES = Object.freeze(['bug', 'clear', 'compact', 'cost', 'help', 'init', 'mode', 'model', 'plan', 'review']);
```

In `src/slash-ui.js`, make the first entry of `BUILTIN_COMMANDS`:

```js
  { name: 'bug', description: 'Report a bug to the developer', argumentHint: '[what went wrong]', run: true },
```

Add the import below the existing ones (line 13):

```js
import { openReportDialog, reportAvailable } from './report-ui.js';
```

In `commandList`, change:

```js
  const commands = mergeCommands(custom);
```

to:

```js
  // /bug only while this build sends reports (src/report-ui.js).
  const commands = mergeCommands(custom).filter((command) => command.name !== 'bug' || reportAvailable());
```

In `runSlashCommand`'s `switch (key) {`, add before `case 'clear': {`:

```js
    case 'bug':
      // Opens Report a bug with the words after /bug in its box; never sent to the model.
      handled();
      openReportDialog(parsed.args);
      return { handled: true };
```

In the header comment (line 6), change `(/clear,\n * /plan, /model, /mode, /cost, /help: never sent to the model)` to read `(/bug, /clear,\n * /plan, /model, /mode, /cost, /help: never sent to the model)`. In `src/app.js` around line 2960, change the comment `// Slash commands (src/slash-ui.js): /clear, /plan, /model, /mode, /cost and /help act here and` to `// Slash commands (src/slash-ui.js): /bug, /clear, /plan, /model, /mode, /cost and /help act here and`.

- [ ] **Step 6: Run the slash tests**

Run: `node --test test/slash-ui.test.mjs test/slash-commands.test.cjs`
Expected: all pass. The two built-in lists still match, and no custom command can be named `bug`.

- [ ] **Step 7: Show and open the search entry in `src/app.js`**

Change the import added in Task 5 to:

```js
import { bindReportUi, openReportDialog, reportAvailable, REPORT_ACTION } from './report-ui.js';
```

In `renderSearch`, change:

```js
    const results = searchItems(query, this.tasks, { experts: this.customExperts, skills: this.customSkills });
```

to:

```js
    const results = searchItems(query, this.tasks, {
      experts: this.customExperts, skills: this.customSkills, actions: reportAvailable() ? [REPORT_ACTION] : [],
    });
```

In `openSearchResult`, change:

```js
    if (!row.dataset.resourceKind) return;
    this.toggleSearch(false);
    openResourceDetail(this, row.dataset.resourceKind, row.dataset.resourceId);
```

to:

```js
    if (!row.dataset.resourceKind) return;
    this.toggleSearch(false);
    // The app's own actions (src/report-ui.js): Report a bug opens its dialog.
    if (row.dataset.resourceKind === 'action') {
      if (row.dataset.resourceId === REPORT_ACTION.id) openReportDialog();
      return;
    }
    openResourceDetail(this, row.dataset.resourceKind, row.dataset.resourceId);
```

- [ ] **Step 8: Extend the smoke check**

In the Task 5 block in `build/smoke-check.cjs`, replace its last line:

```js
      return { info: info && info.ok ? info.data : null, cardShown, cardText, opened, shortDisabled, refusedShown, refusedText, textKept, longEnabled, count, toasted, closed: !dialog.open };
```

with:

```js
      const closed = !dialog.open;
      // Search: "bug" lists Report a bug, which opens the dialog.
      document.querySelector('#search-btn').click();
      const search = document.querySelector('#search-input');
      search.value = 'bug';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const found = await until(() => Boolean(document.querySelector('.search-result[data-resource-kind="action"]')), 2000);
      document.querySelector('.search-result[data-resource-kind="action"]')?.click();
      const fromSearch = await until(() => dialog.open, 2000);
      dialog.close();
      // /bug with words: the dialog opens with them in its box, and nothing goes to the model.
      const chat = document.querySelector('#chat-input');
      chat.value = '/bug Typed after the slash command.';
      chat.dispatchEvent(new Event('input', { bubbles: true }));
      const sendReady = await until(() => !document.querySelector('#send-btn').disabled, 2000);
      document.querySelector('#send-btn').click();
      const fromSlash = await until(() => dialog.open, 2000);
      const slashText = input.value;
      const chatCleared = chat.value === '';
      dialog.close();
      return { info: info && info.ok ? info.data : null, cardShown, cardText, opened, shortDisabled, refusedShown, refusedText, textKept, longEnabled, count, toasted, closed,
        found, fromSearch, sendReady, fromSlash, slashText, chatCleared };
```

In the `bugReport` check, change its last line:

```js
      && report.opened && report.shortDisabled && report.longEnabled && report.count === '28 / 2,000' && report.toasted && report.closed),
```

to:

```js
      && report.opened && report.shortDisabled && report.longEnabled && report.count === '28 / 2,000' && report.toasted && report.closed
      && report.found && report.fromSearch && report.sendReady && report.fromSlash
      && report.slashText === 'Typed after the slash command.' && report.chatCleared),
```

If `sendReady` comes back false in CI, Send is disabled at that point in the run, because there's no folder or model. In that case, move the `/bug` part into the e2e block, right after an existing `document.querySelector('#send-btn').click();` that sends while a folder and the stub model are set.

- [ ] **Step 9: Check the syntax**

```bash
CHECK=/private/tmp/claude-501/-Users-sagaraggarwal-Desktop/c0ecae47-17fe-40d6-837b-d2e8d3b5cf5d/scratchpad/syntax
mkdir -p "$CHECK" && cp src/app.js "$CHECK/app.mjs" && cp src/slash-ui.js "$CHECK/slash-ui.mjs"
node --check build/smoke-check.cjs && node --check lib/slash-commands.cjs && node --check "$CHECK/app.mjs" && node --check "$CHECK/slash-ui.mjs" && echo ok
```
Expected: `ok`

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add lib/slash-commands.cjs src/slash-ui.js src/domain.mjs src/app.js build/smoke-check.cjs test/domain.test.mjs
/usr/bin/git commit -q -F - <<'EOF'
Bug reports: /bug in the message box, and Report a bug in search

Both only while this build sends reports. /bug's words go into the report's box and never
to the model.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Docs, the full run and the PR

**Files:**
- Modify: `README.md`, `HANDOFF.md`

- [ ] **Step 1: README**

In `README.md`, after the `### Updates` section's last bullet (`- **Privacy:** GitHub sees your computer's address …`) and before `## Features`, add:

```markdown

### Bug reports

**Report a bug** in **Preferences & about** (or `/bug` in the message box, or "bug" in search) sends the developer a short message about a problem.
- **What's sent:** your message, the app's version and your system (for example macOS 15.1, arm64). No name, files, chats, settings or keys. A random ID, made at your first report, tells your reports apart without saying who you are.
- **Where it goes:** to a small Cloudflare Worker (`relay/`), which forwards it to the developer's Telegram. The Worker keeps network addresses only as salted hashes, and forgets every count after 24 hours.
- **Limits:** 3 reports per install in 24 hours, 10 per network address and 100 in total.
- A build whose `REPORT_URL` in `lib/bug-report.cjs` is empty has no Report a bug. Setting up the relay: `relay/README.md`.
```

In the `## Project structure` tree:
- after the `├── docs/screenshots/ …` line, add `├── relay/                # the bug-report relay, a Cloudflare Worker (not shipped in the app)`;
- after `│   ├── updates.cjs       # newer releases on GitHub, checked downloads, Update now`, add `│   ├── bug-report.cjs    # bug reports: the message, version and system to the relay`;
- after `│   ├── updates-ui.js     # Preferences > Updates (Update now) and the status bar notice`, add `│   ├── report-ui.js      # Report a bug: the card, its dialog, /bug and the search entry`.

- [ ] **Step 2: HANDOFF**

In `HANDOFF.md`, immediately before `### Suggested next session`, add:

```markdown
### 2026-11-01 — bug reports to Telegram (`feat/bug-reports`)

1. **Built:** Report a bug in Preferences & about, `/bug` and a search entry (`src/report-ui.js`). Main posts the message, the version and the system (`lib/bug-report.cjs`) to the relay in `relay/`, a Cloudflare Worker that forwards it to the developer's Telegram.
   - **Limits:** 3 per install, 10 per network address and 100 in total, each over a rolling 24 hours. One SQLite Durable Object counts them and reserves a report before sending it.
   - The bot token, chat ID and address salt exist only as Worker secrets.
2. **Off until the relay is deployed:** while `REPORT_URL` is empty, the card, `/bug` and the search entry don't show. The smoke run uses a stub in main (`bugReport`), which also refuses messages containing "smoke-limit".
3. **Still to do:**
   - deploy the relay (`relay/README.md`);
   - a PR sets `REPORT_URL`;
   - in the packaged app, send one real report, then a 4th from the same install within 24 hours to see the limit message;
   - release 1.0.0-beta.8.
```

- [ ] **Step 3: Commit the docs**

```bash
/usr/bin/git add README.md HANDOFF.md
/usr/bin/git commit -q -F - <<'EOF'
Docs: bug reports and the relay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: Push and open the PR (needs the user's OK)**

Write the body to `/private/tmp/claude-501/-Users-sagaraggarwal-Desktop/c0ecae47-17fe-40d6-837b-d2e8d3b5cf5d/scratchpad/pr-bug-reports.md`:

```markdown
Adds **Report a bug**: a card in Preferences & about, `/bug` and a search entry. A report goes from main to a Cloudflare Worker (`relay/`), which forwards it to the developer's Telegram.

- **Sent:** the message, the app's version and the system. Nothing else.
- **Limits:** 3 per install, 10 per network address and 100 in total, over 24 hours. They're counted in one SQLite Durable Object, which reserves a report before sending it.
- **Off in this PR:** `REPORT_URL` is empty, so users see nothing new until the relay is deployed and a follow-up PR sets the URL.
- **Tests:** 19 new unit tests (relay rules, the reporter, the dialog's text, search). The smoke check `bugReport` runs the card, a refused send, a sent one, search and `/bug` through a stub in main.

Spec: `docs/superpowers/specs/2026-11-01-bug-reports-design.md` · Plan: `docs/superpowers/plans/2026-11-01-bug-reports.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Then:

```bash
/usr/bin/git -c http.postBuffer=524288000 push -u origin feat/bug-reports
gh pr create --base main --head feat/bug-reports --title "Bug reports to Telegram (off until the relay is deployed)" \
  --body-file /private/tmp/claude-501/-Users-sagaraggarwal-Desktop/c0ecae47-17fe-40d6-837b-d2e8d3b5cf5d/scratchpad/pr-bug-reports.md
```

- [ ] **Step 5: Read CI**

Wait for CI on the PR. Expected:
- unit tests pass on macOS and Windows. That's the 890 already there plus 19 new: 6 in `bug-relay`, 7 in `bug-report`, 5 in `report-ui` and 1 in `domain`;
- the smoke check passes with one more check, `bugReport`: 104 on macOS and 102 on Windows.

If a check fails, read its log, fix it on the branch and push again.

---

### After the Worker is deployed (a later PR, not part of this branch's first merge)

- [ ] The developer follows `relay/README.md` steps 1–6. Step 5 prints the Worker's address, which they pass on.
- [ ] Set `REPORT_URL` in `lib/bug-report.cjs` to that address plus `/report`. Then run `node --test test/bug-report.test.cjs`; its URL test checks that the address is https and ends in `/report`.
- [ ] Open the PR, let CI pass, and merge.
- [ ] In a packaged build from CI, send one report and see it arrive in Telegram. Then send three more from the same install: the 4th shows "You've sent 3 reports today. You can send another after …".
- [ ] Release 1.0.0-beta.8 with the usual procedure. The notes say what a report sends.
