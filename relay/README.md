# Bug-report relay

A Cloudflare Worker that takes bug reports from ScaleMax IDE (`lib/bug-report.cjs`) and forwards
each one to your Telegram. It holds the bot token, so the app never does. It allows 3 reports per
install, 10 per network address and 100 in total, each over a rolling 24 hours (`src/logic.mjs`).
It keeps addresses only as salted hashes, and deletes counts older than 24 hours when the next report arrives.

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
4. **Add the secrets.** Each command asks for the value. The salt can be any long random string
   (16 characters or more). While one is missing, the Worker answers 503 `MISCONFIGURED`.
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
| 415 | `{ ok: false, code: "UNSUPPORTED_TYPE" }` | the request isn't `application/json` |
| 429 | `{ ok: false, code: "LIMIT" \| "NETWORK_LIMIT" \| "BUSY", resetAt }` | a limit was reached |
| 502 | `{ ok: false, code: "TELEGRAM" }` | Telegram didn't take it (the report isn't counted) |
| 503 | `{ ok: false, code: "MISCONFIGURED" }` | a secret is missing; see step 4 |
| 503 | `{ ok: false, code: "RELAY_ERROR" }` | the Worker failed inside (the app says to try again) |
