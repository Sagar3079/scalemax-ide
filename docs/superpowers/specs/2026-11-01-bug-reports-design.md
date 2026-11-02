# Bug reports to Telegram — design

**Date:** 2026-11-01 · **Status:** approved in chat, waiting for review of this spec · **Ships in:** 1.0.0-beta.8

## Goal

Anyone using ScaleMax IDE can send a short bug report from the app. Each report arrives in the
developer's Telegram as a message. One install can send at most 3 reports in 24 hours, so the
form can't be used to flood that chat.

A report holds the person's message, the app's version and the system it runs on. Nothing else:
no name, no contact, no files, chats, settings or keys. Reports are anonymous.

**Not in scope:** screenshots or other attachments, a contact field, replying to the reporter,
a Bug/Idea choice, crash logs, an in-app list of sent reports.

## How it fits together

```
Report a bug dialog (src/report-ui.js)
  │ scalemaxAPI.report.send(message)            the page has connect-src 'none'
  ▼
main: report:send (main.js) → lib/bug-report.cjs
  │ POST https://<worker>.workers.dev/report    { installId, message, version, os }
  ▼
Cloudflare Worker (relay/) → Durable Object "limiter": check, reserve, send, release on failure
  │ POST api.telegram.org/bot<TOKEN>/sendMessage  (plain text)
  ▼
the developer's Telegram chat
```

The Telegram bot token exists only as a Worker secret. It is never in this repository or in the
app, so nobody can pull it out of an installed copy.

## Part 1 — the Worker (`relay/`)

A new folder in this repository. It is not in package.json's `build.files`, so it is never
packaged into the app.

```
relay/
  wrangler.toml      name, main = "src/worker.mjs", the LIMITER Durable Object (SQLite) and its migration
  src/worker.mjs     the fetch handler and the Limiter Durable Object class
  src/logic.mjs      pure functions: validateReport, decide, formatMessage (no Cloudflare APIs)
  README.md          one-time setup and deploy steps
```

### Endpoint

`POST /report` with `Content-Type: application/json`. Every other path answers `404`, every other
method on `/report` answers `405`. A body over 16 KB answers `413`.

Request body:

| Field | Rule |
|---|---|
| `installId` | a UUID (version 4, lowercase), as the app makes them |
| `message` | a string; after trimming, 10–2,000 characters (UTF-16 length, as JavaScript counts) |
| `version` | 1–40 characters of `[0-9A-Za-z.+-]` |
| `os` | 1–80 printable characters |

Control characters other than newline and tab are removed from `message` before the length check.
Anything that fails a rule answers `400 { ok: false, code: 'INVALID' }`.

### Limits

All three are counted over a rolling 24 hours:

| Scope | Limit | Code when hit | Why |
|---|---|---|---|
| this install (`installId`) | 3 | `LIMIT` | the rule asked for |
| this network address | 10 | `NETWORK_LIMIT` | install IDs come from the app and can be made up |
| everything | 100 | `BUSY` | protects the chat from many machines at once |

The address is `CF-Connecting-IP`, stored only as `sha256(IP_SALT + address)`, hex, never raw.
The install is checked first, then the address, then the total; the first limit hit is the one
reported. A hit answers `429 { ok: false, code, resetAt }`, where `resetAt` (ISO 8601) is when the
oldest report counted in that scope turns 24 hours old.

### Counting (the `Limiter` Durable Object)

One SQLite-backed Durable Object, `idFromName('global')`, does all the counting, so the three
checks and the write happen together. Table `reports(scope TEXT, key TEXT, at INTEGER)` with an
index on `(scope, key, at)`; scope is `install`, `address` or `total` (key `'*'`).

For each report:
1. delete rows older than 24 hours;
2. count the rows for each scope and run `decide()`; on a hit, answer 429;
3. **reserve:** insert one row per scope (so a report arriving while Telegram is answering is
   counted against these);
4. send the Telegram message;
5. if Telegram fails or times out (10 s), delete the three reserved rows and answer
   `502 { ok: false, code: 'TELEGRAM' }`;
6. otherwise answer `200 { ok: true, remaining, resetAt }`: `remaining` is how many more this
   install may send now (0–2), `resetAt` when the next one frees up.

Free plan headroom: Durable Objects allow 100,000 requests a day on Workers Free; the total limit
keeps this far below that.

### The Telegram message

`sendMessage` with `chat_id` = `TELEGRAM_CHAT_ID`, no `parse_mode` (plain text, so nothing in the
report is read as formatting), `disable_web_page_preview: true`:

```
🐞 Bug report · 1.0.0-beta.8 · Windows 11 (build 22631, x64)
Install 3f2a9c1e · 2 of 3 today

<the message, as sent>
```

`Install` shows the first 8 characters of the install ID, so reports from one install can be told
apart without the full ID. `2 of 3 today` counts this install's reports in the last 24 hours,
this one included.

### Secrets and setup

Set with `wrangler secret put`, never committed: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`IP_SALT` (any long random string). `relay/README.md` gives the steps, which the developer runs
once with their own accounts:
1. create a bot with @BotFather and copy its token;
2. send the bot a message, then read the chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`;
3. `npx wrangler login`, then from `relay/`: `npx wrangler secret put` for each secret and
   `npx wrangler deploy`;
4. send one report with curl (given in the README) and see it arrive;
5. put the deployed URL in `REPORT_URL` (Part 2) and release.

## Part 2 — the app

### Where people find it

- **Preferences & about:** a **Report a bug** card just above Updates. Text: "Something not
  working? Tell the developer. ScaleMax sends your message, its version and your system (for
  example macOS 15.1, arm64), nothing else: no files, chats or keys. Up to 3 reports a day."
  The example is this computer's own label. Button: **Report a bug…**
- **`/bug` in the message box:** a built-in slash command, "Report a bug to the developer",
  argument hint `[what went wrong]`. It opens the dialog, with any text after `/bug` already in the
  box. It is never sent to the model. `bug` joins `BUILTIN_NAMES` in `lib/slash-commands.cjs`
  and `BUILTIN_COMMANDS` in `src/slash-ui.js` (a test keeps the two lists equal); a custom command
  named `bug` is no longer picked up, as for the other built-in names.
- **Search (the search dialog):** typing "bug", "report", "feedback" or "problem" lists **Report a
  bug** with the badge `action`. Opening it closes search and opens the dialog. `searchItems()` in
  `src/domain.mjs` gains a short list of app actions, after tasks and before resources.

### The dialog

A `<dialog>` like the app's other dialogs, built with `createElement`/`textContent` only.

- Title "Report a bug". A text box labelled "What went wrong?", placeholder "What you did, what you
  expected, what happened". A counter "0 / 2,000" under it.
- **Send report** is disabled until the trimmed text has 10 characters; the box stops at 2,000.
  **Cancel** and Escape close it.
- While sending: the button reads "Sending…", the box and button are disabled.

| Answer | What the person sees |
|---|---|
| sent | the dialog closes; toast "Report sent. Thank you. You can send 2 more today." (1 → "1 more", 0 → "That was your last one for today.") |
| `LIMIT` | stays open, text kept: "You've sent 3 reports today. You can send another after 3:40 PM." (local time; "tomorrow after …" when not today) |
| `NETWORK_LIMIT` | stays open, text kept: "Too many reports came from your network today. You can send another after 3:40 PM." |
| `BUSY` | stays open, text kept: "Reports are paused for today. Please try again tomorrow." |
| offline, timeout, `TELEGRAM`, anything else | stays open, text kept: "The report wasn't sent. Check your connection and try again." |

The text the person typed is never lost to a failed send while the dialog stays open.

### `lib/bug-report.cjs` (main process)

```js
createReporter({ url, version, platform, arch, systemVersion, release, fetchImpl, store, timeoutMs })
  → { get() → { available, osLabel },
      send(message) → { sent: true, remaining, resetAt } | { sent: false, code, resetAt? } }
```

- `REPORT_URL` is a constant here: the deployed Worker's `…/report` URL. **While it is empty,
  `available` is false**: the card and the search entry are not shown, `/bug` is left out of the
  slash menu, and a typed `/bug` says "Bug reports aren't available in this version." instead of
  going to the model. So the app code can be merged before the Worker exists.
- `send()` checks the message the same way the Worker does (10–2,000 after trimming), then posts
  JSON with `User-Agent: ScaleMax-IDE/<version>` and a 15 s timeout. It never throws for an
  outcome: it resolves to `{ sent: false, code, resetAt }` with the Worker's code (`INVALID`,
  `LIMIT`, `NETWORK_LIMIT`, `BUSY`, `TELEGRAM`), `NETWORK` when no usable answer came, or
  `UNAVAILABLE` while `REPORT_URL` is empty.
- **Install ID:** `crypto.randomUUID()`, made the first time someone sends a report and saved in
  the state store under `reportInstallId`. It is sent only with reports.
- **OS label** from `process.getSystemVersion()` and `process.arch`:
  - macOS: `macOS 15.1 (arm64)` (a trailing `.0` dropped);
  - Windows: `Windows 11 (build 22631, x64)` for builds 22000 and up, else `Windows 10 (build …, x64)`;
  - anything else: `<platform> <os.release()> (<arch>)`.

### Wiring

- `main.js`: `report:get` → `{ available, osLabel }`, `report:send` → `send(message)`, both
  through `wrap()` with fallback `{ code: 'REPORT_ERROR', message: 'The report could not be sent.' }`
  and `trustedSender` like the other handlers.
- `preload.js`: `scalemaxAPI.report.get()` and `scalemaxAPI.report.send(message)`.
- When `SCALEMAX_SMOKE=1`, main builds the reporter with a stub `fetchImpl` that answers
  `{ ok: true, remaining: 2, resetAt }` and an `https://smoke.invalid/report` URL, so the smoke run
  never goes online.
- The page's Content-Security-Policy stays `connect-src 'none'`.

### Files

| File | Change |
|---|---|
| `relay/*` | new (Part 1) |
| `lib/bug-report.cjs` | new |
| `src/report-ui.js` | new: card, dialog, toasts, `/bug` and search hooks |
| `src/index.html` | the card above Updates, the dialog |
| `src/styles.css` | dialog and counter, from existing tokens |
| `src/app.js` | bind the UI; run `/bug`; open the `action` search result |
| `src/slash-ui.js`, `lib/slash-commands.cjs` | `bug` built-in |
| `src/domain.mjs` | app actions in `searchItems()` |
| `main.js`, `preload.js` | IPC |
| `build/smoke-check.cjs` | the new smoke check |
| `README.md`, `HANDOFF.md` | what reports send, the relay, setup |

## Testing

- `test/bug-report.test.cjs`: message checks; the install ID is made once and reused; the
  request's URL, headers and body; each Worker code becomes the right error; no answer within
  15 s becomes `NETWORK`; `available` is false with an empty URL; OS labels for macOS, Windows 10,
  Windows 11 and Linux.
- `test/bug-relay.test.mjs` (imports `relay/src/logic.mjs`): `validateReport` accepts and rejects
  each field; `decide` hits the install, address and total limits in that order and computes
  `resetAt`; `formatMessage` output, including a message with Markdown and HTML in it (sent as is).
- `test/report-ui.test.mjs`: Send report enabled at 10 characters; each answer's text; the typed
  text kept after a failure; `/bug some words` fills the box; the search entry appears for "bug".
- `test/slash-ui.test.mjs` keeps checking that the built-in lists match.
- Smoke check: open Preferences & about, click **Report a bug…**, type, send, see the toast.
- By hand, once deployed: one real report from the packaged app reaches Telegram; a 4th from the
  same install within 24 hours shows the limit message.

## Release

1. Merge the app code with `REPORT_URL` empty (nothing shows; nothing changes for users).
2. The developer deploys the Worker (Part 1, Setup) and tells me its URL.
3. A PR sets `REPORT_URL`; CI passes; release as 1.0.0-beta.8 for macOS and Windows with the
   usual procedure. The notes say what a report sends.
