# ScaleMax IDE — Progress Summary

## Where we started

ScaleMax IDE is an Electron + vanilla-JS desktop prototype (no build step, no runtime deps) built as a chat-first "AI development workspace." When we began, the repo was **a screenshot-driven demo shell**, not a working app.

### Initial state (audited with parallel deep-dive agents)

- **The renderer didn't boot.** `src/app.js` imported `MODELS` from `./data.js`, which doesn't export it → hard ES-module `SyntaxError` → nothing ran.
- **Two generations of code coexisted.** An older login/dropdown demo (`app.js`, `auth.js`, `web-shim.js`) vs a newer 6-view shell (`index.html`, `styles.css`, `domain.mjs`). They didn't match: the login UI, dropdowns, and model picker the JS drove didn't exist in the HTML.
- **A whole hardened backend was written but disconnected** — `lib/state.cjs`, `lib/workspace.cjs`, `lib/provider.cjs` (~1,050 LOC) were never `require`d by `main.js` and were even **excluded from packaging** (`electron-builder files` omitted `lib/**`). `src/domain.mjs` had zero importers.
- **Everything headline was fake:** chat was a regex `simulateResponse()` on a 900 ms timer; auth was a prefix string match; automations were saved but never fired; skills/connectors were local booleans.
- **Bad UX:** ~105 of 135 HTML IDs had no JS wiring; the Workspace/Assistant/editor/git/terminal views were dead markup.
- **Security/quality gaps:** no CSP enforcement of the contract, non-atomic plaintext state, session-forgeable `store:set`, real PII hardcoded, no tests, no git repo.

---

## What we changed

### 1. Provider engine — connected and made real
- Wired `lib/provider.cjs` into `main.js` with a native approval dialog, a state adapter, and 6 IPC channels returning `{ ok, data } / { ok, error }`.
- Exposed `window.scalemaxAPI.provider.*` via `preload.js`; reserved the `provider` key from the generic store bridge so credentials never leak to the renderer.
- The Assistant provider form is live: **save / test / clear**, real chat replaces the fake replies, plus a "Stop response" cancel and a temperature toggle. Send-enablement no longer depends on a (nonexistent) login.
- API keys are encrypted on disk via `safeStorage` when available, never persist otherwise, and never cross the bridge (only a `hasKey` flag).

### 2. ScaleMax preconfigured provider + model management
- Added a **ScaleMax preset** that auto-detects the endpoint: `api.scalemax.pro/v1` is rejected by the key, `api.scalemax.pro/token/v1` authenticates — the code tries both and uses whichever works.
- **Test connection** verifies the key and loads the 29-model catalog (`display_name`, `availability`).
- Per-model **Enable/Disable** toggles (unavailable models locked), a **"Model for chat"** picker, and the active model shown as a centered pill in the composer and in the top bar.
- Verified live with a real key end-to-end (discover → save → chat returned `OK`).

### 3. Layout that survives resizing
- Fixed the chat view overflowing so the composer was pushed off-screen: the message list scrolls internally and the composer stays pinned at any window size.
- Raised the window minimum to **900×700** and added compact layouts for short windows.
- Removed an inline `maxHeight` hack in `renderChat` that fought the CSS.

### 4. UI cleanup (from your feedback)
- **Blue focus outline removed globally** (`:focus, :focus-visible { outline: none }`).
- **Composer unified into a single element** — transcript + input live in one bordered container with a hairline divider (empty state drops the divider).
- Removed the "Your message" label, the Context row, and **all helper text globally**.
- **Custom model picker** replaces the ugly native select dropdown.
- **Connection status dot** beside "Test connection": grey idle → amber pending → green success / red failure or 20 s timeout.
- **No more approval popup** when saving a provider — it just saves.
- **More permission options**: Read-only · Ask before changes · Auto-approve file writes · Full access — no prompts · Plan only — no tools.
- The auth/login dead code was removed entirely (local-first app).

### 5. Real workspace access (folder / files / attachments)
- **Open a folder from your PC** — Workspace view is wired: native folder picker → file tree → open files in the editor → **Save file** writes back, plus Git status/diff.
- **Attach current file** works: uses the file open in the editor, else a native file picker (1 MiB cap, binary rejected); the attached file's contents are sent with your message.
- Backed by `lib/workspace.cjs` with its hardening (symlink/secret-path checks, revision-based optimistic writes, 1 MiB caps).

### 6. Tooling & verification
- `npm test` — **15 provider/workspace unit tests** (`node --test`).
- A hermetic **Electron smoke test** (`build/smoke-check.cjs`, runs via `SCALEMAX_SMOKE=1`) that boots the real app, exercises the provider IPC against a local stub **and** a live ScaleMax key (from env, never committed), the composer send flow, and a real workspace round-trip (select → list → read → write → read) in a temp folder. It now isolates `userData` so it never touches real state.
- Verified the packaged `.app` launches and `lib/` ships in the asar.
- `dist/ScaleMax-1.0.0-arm64.dmg` / `-mac.zip` (unsigned; Gatekeeper will warn on other Macs).

---

## Where we are now

| Area | Status |
|---|---|
| App boots & renderer runs | ✅ Fixed (MODELS blocker gone) |
| Provider connection (custom + ScaleMax preset) | ✅ Real, auto-detects endpoint |
| Model list + enable/disable + active model | ✅ Working |
| Chat → real AI provider | ✅ Working (fallback demo when unconfigured) |
| Key security (safeStorage, no renderer access) | ✅ Working |
| Resize-safe layout + 900×700 minimum | ✅ Working |
| Blue focus ring, helper text, approval popup removed | ✅ Done |
| Unified composer (one container) | ✅ Done |
| Open folder / file tree / editor save / attach | ✅ Working |
| Git status/diff | ✅ Working |
| Permissions expanded | ✅ Done |
| Unit + smoke tests | ✅ 15 unit + end-to-end smoke |
| Distributable | ✅ dmg + zip rebuilt |

**Still not built (known gaps, out of scope so far):**
- Scheduled automations still don't actually run (they're saved only).
- Skills/connectors are still local toggles (no real install/connect).
- No code signing / notarization.
- No git repo / CI yet (the folder isn't under version control).

---

## Files touched
- `lib/provider.cjs` — presets, `discover()`, model catalog + enabled models, encrypted keys
- `main.js` — provider + workspace + dialog IPC, auto-approve, hermetic smoke userData
- `preload.js` — `provider.*`, `workspace.*`, `dialog.*` bridge
- `src/app.js` — provider UI, composer, model pill/picker, workspace wiring, permissions, removed auth
- `src/index.html` — composer, provider form, permissions, removed helper text
- `src/styles.css` — no focus rings, unified composer, picker/status-dot/model-pill, select polish
- `src/web-shim.js` — browser-preview provider stub
- `package.json` — `lib/**` packaged, `npm test`
- `test/provider.test.cjs` (new), `build/smoke-check.cjs` (new), `PROJECT_SUMMARY.md` (this)