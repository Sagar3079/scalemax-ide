# ScaleMax IDE — Project Handoff

Complete context for an AI or engineer taking over this project. Everything below reflects the verified state of the repo at the time of writing.

---

## 1. What this is

**ScaleMax IDE** — a native macOS Electron app: a local-first AI development workspace. Chat-first task model, provider-key authentication (ScaleMax API, OpenAI-compatible), local project workspace (file tree, editor, Git, command console), an Experts · Skills · Connectors catalog, scheduled automations, light/dark themes.

- **Stack**: Electron 33.4.11, electron-builder 25.1.8, vanilla ES modules — **no build step, no runtime dependencies**, no TypeScript, no bundler.
- **Repository**: https://github.com/Sagar3079/scalemax-ide
- **macOS-only** build target (dmg + zip, arm64), unsigned.

---

## 2. Quick start

```bash
git clone https://github.com/Sagar3079/scalemax-ide.git && cd scalemax-ide
npm install                # devDeps only (electron, electron-builder)

npm start                  # runs prestart runtime check, then electron .
npm test                   # node --test → 50 unit tests (provider, connectors, domain)
npm run build              # electron-builder --mac → dist/ScaleMax-1.0.0-arm64.dmg + .zip

# Hermetic end-to-end smoke check (boots the real app, isolated userData):
SCALEMAX_SMOKE=1 npm start
# With live provider verification (exercises discover → save → chat → clear):
SCALEMAX_SMOKE=1 \
  SCALEMAX_LIVE_KEY='sm_live_…' \
  SCALEMAX_LIVE_MODEL='deepseek-v4-flash' \
  npm start
# Prints "SMOKE_RESULT {ok, checks, …}" and exits 0/1. 37 checks.

# Browser preview (no Electron): the web-shim installs a bridge stand-in.
cd src && python3 -m http.server 8765   # → http://localhost:8765/index.html
```

Electron runtime issues (truncated installs, missing `path.txt`): `npm run repair:electron`. Never hand-create `path.txt`.

---

## 3. Architecture

Three tiers, textbook Electron:

```
main.js (Node)          → 26 ipcMain.handle channels; provider/connector/workspace/dialog ones wrapped in {ok,data}/{ok,error} envelopes
preload.js (contextBridge) → window.scalemaxAPI: app, store, provider, connectors, dialog, workspace
src/ (renderer, isolated)  → contextIsolation:true, nodeIntegration:false, webSecurity:true
```

### File map (hand-written code, ~13,900 lines)

| File | Lines | Role |
|---|---:|---|
| `src/sm-tokens.css` | 3,911 | Design tokens: 3,791 `--sm-*` variables (light `:root` + `[data-theme="dark"]`), Assistant @font-face, `--vscode-*` fallbacks. **Generated file — regenerate, don't hand-edit.** |
| `src/styles.css` | 2,360 | All component styles, built on the tokens. 12 sections. |
| `src/app.js` | 1,500 | Renderer singleton `app` (default export): tasks, chat, workspace, catalogs, automations, search, toasts. |
| `src/connector-catalog.js` | 662 | 40 connector setup guides (auth, setupSteps, docsUrl, capabilities). |
| `lib/workspace.cjs` | 530 | Hardened project-folder access: list/read/write, symlink+secret-path rejection, SHA-256 optimistic-concurrency writes, Git status/diff, command runner (30 s, 1 MiB, process-group kill). |
| `src/skill-catalog.js` | 521 | 30 builtin skill prompt templates (`{{input}}` slots) + 7 community reference repos. |
| `lib/provider.cjs` | 516 | OpenAI-compatible client: presets (ScaleMax `api.scalemax.pro/token/v1`), discover/models catalog, chat send, 4 MB caps, 120 s timeout, redirects rejected, safeStorage-encrypted keys. |
| `lib/connectors.cjs` | 487 | Connector credential store: encrypted tokens (safeStorage; session fallback), sanitized `list()`, API validation (github/sentry/notion/slack/linear), **live data fetch** (GitHub repo + issues). |
| `src/catalog-ui.js` | 451 | Catalog filters (search/category across all 4 catalogs), community cards, theme switching, JSON exports, detail dialogs, connector Connect/Test/Disconnect UI. Exports `bindCatalogUi(app)` and `openResourceDetail(app, kind, id)`. |
| `src/index.html` | 421 | Single-page shell: 6 views + search/detail/connector dialogs + toast. Strict CSP (`connect-src 'none'`). |
| `main.js` | 359 | Main process, IPC surface, atomic state store wiring, smoke-mode userData isolation. |
| `test/connectors.test.cjs` | 346 | 21 tests: encryption, hint safety, validation endpoints, fetch contract. |
| `build/smoke-check.cjs` | 333 | 37-check end-to-end harness (see §7). |
| `src/domain.mjs` | 269 | Pure logic: `normalizeSettings`, `normalizeTasks`, `normalizeAutomations`, `nextRunAt` (DST/month-end correct), `buildSystemPrompt`, `searchItems`. |
| `test/provider.test.cjs` | 250 | 15 tests: provider save/send/cancel/discover. |
| `src/scheduler.js` | 168 | Automation engine: 30 s poll, nextRun scheduling, delivers results as `Automation · <name>` tasks. |
| `lib/state.cjs` | 158 | Atomic, validated JSON store (temp+fsync+rename, 0600, 12 MB cap, PUBLIC_KEYS allowlist, legacy `user` purge). |
| `preload.js` | 149 | The bridge. 27 methods: 26 across 6 namespaces (`app`, `store`, `provider`, `connectors`, `dialog`, `workspace`) plus `getPlatform()`. |
| `test/domain.test.mjs` | 121 | 14 tests incl. all-8-experts / all-30-skills prompt injection. |
| `src/terminal.js` | 80 | Command console binding. |
| `src/web-shim.js` | ~95 | Browser-preview bridge stand-in (no-op under Electron). |
| `src/data.js` | 82 | Re-exports catalogs + 8 EXPERTS (with `initials`). |

### IPC surface (26 channels, all verified paired with preload)

- `store:get` / `store:set` — generic state, **PUBLIC_KEYS allowlist** (`tasks, settings, automations, skillStates, connectorStates, currentTaskId`); `provider`, `connectors`, `user` are RESERVED (renderer can never touch them). `store:set` returns `false` on write failure → renderer falls back to localStorage.
- `provider:get/save/test/discover/send/cancel/clear` — 7 channels. Keys never cross the bridge (only `hasKey`/`keyStorage` metadata).
- `connector:list/save/remove/test/fetch` — 5 channels. Tokens never cross the bridge (only `••••1234` hints).
- `workspace:select/list/read/write/git-status/git-diff/run/cancel` — 8 channels. `workspace:list` accepts an optional project-relative path (folder expansion).
- `dialog:open-folder/open-file` — native pickers, 1 MiB cap, binary rejected.
- `app:get-version/quit`.

### State

- Lives at `~/Library/Application Support/scalemax-ide/scalemax-state.json`, written **atomically** through `lib/state.cjs` (temp+fsync+rename). A corrupt file is renamed to `scalemax-state.json.corrupt-<ts>` (backup, never deleted) and a fresh store starts.
- Smoke runs (`SCALEMAX_SMOKE=1`) redirect userData to a temp dir and clean it up.

---

## 4. Feature behavior (what "working" means)

**Provider / auth.** No sign-in screen — provider API key IS the auth. Assistant view: ScaleMax preset (key auto-detects `api.scalemax.pro/token/v1`) or custom OpenAI-compatible endpoint. Test connection → discover 22-model catalog → enable models → pick chat model → Save. Key encrypted with `safeStorage`; session-only fallback is surfaced in the status line after restart.

**Chat.** Real requests via `provider:send`, non-streaming. Conversation = persisted tasks; first user message titles the task. The welcome hero ("What will you work on next?") shows **only on an empty task** — with messages the view becomes a transcript with the composer pinned at bottom. Attachments (open editor file or picker) are injected once, then cleared.

**System prompt composition.** Every request's system prompt = base contract + Working/Coding mode line + user system prompt + selected expert's full prompt + installed skill's template (`{{input}}` resolved) + permission line (readonly/plan/auto-write/full/ask). Unit tests prove all 8 experts and all 30 skills inject their full text.

**Experts (8).** Cards with initials avatars. "Use" → selects → seeds the composer with that expert's starter prompt ("Audit this code or configuration for vulnerabilities: " for Security Auditor), shows a removable chip, applies the persona to every request.

**Skills (30 + 7 community).** Install → applied to chat. Installed skills get a **Run** button: runs the skill on the file open in the editor (or a picked file) — attaches it and sends through the template. Clicking a card opens the full prompt template in a detail dialog. Community cards show reference repos with copy-link.

**Connectors (40).** Connect opens a token modal → token stored encrypted in main (never in the renderer) → **real API validation** (GitHub `/user`, Sentry, Notion, Slack `auth.test`, Linear GraphQL; others honestly report "no validation endpoint configured yet"). Connected cards show a status dot + `••••1234` hint + Test + Disconnect. **Live data fetch:** any chat message containing `github.com/owner/repo` triggers `connector:fetch` → repo metadata + 10 open issues pulled via the stored token and injected into the request. Not connected → toast tells you to connect.

**Workspace.** Native folder picker → expandable file tree (lazy subfolder listing) → editor with tab + line-number gutter (synced to typing/scroll) → SHA-256-guarded saves with backup. Dirty-guard confirm before discarding edits. Switching folders resets editor state (no cross-project writes). Git panel: branch, changed files with color-coded status letters, syntax-colored diff. Command console: `$` prompt, runs through the hardened `workspace.run` (native approval auto-granted, 30 s / 1 MiB limits, process-group kill), output + exit code.

**Automations.** Daily/weekly/monthly schedules with weekday/monthday, computed `nextRun`. The scheduler (renderer, 30 s poll) runs them while the window is open — prompt → provider → result lands in an `Automation · <name>` task, status/next-run shown per schedule. Legacy (pre-v2) records load paused. Resuming recomputes `nextRun` (never fires immediately for a missed time).

**Search.** Overlay searches task titles/messages AND all four catalogs; resource results open the full detail dialog.

**Theme.** Light/Dark/System (live matchMedia), persisted. Dark theme fully tokenized.

**Exports.** Current task JSON, full local-data JSON (real downloads).

**Permissions.** `settings.permission` is enforced in main: `readonly`/`plan` block writes and commands in the workspace service.

---

## 5. Design system provenance (important context)

The UI was ported from a shipped production app's renderer bundle (extracted from an Electron app's `app.asar` on this machine). The palette, tokens, and shell metrics are real production values:

- Shell: 38px titlebar, 220px sidebar, 22px statusbar, 8px control radius
- Brand: `--sm-palette-brand-8: #00C29A` (light) / `#4cf0ce` (dark)
- Typeface: **Assistant** (4 woff2 files in `assets/fonts/`), 400/500/600/700
- Primary buttons: near-black (`--sm-button-primary-bg: palette-black-90`)

**Gotcha:** the shared `--sm-bg-*` tokens are component-scoped in the source design system. The shell pins its own `--sm-app-*` surface aliases (`page`, `surface`, `surface-hover`, `chrome`, `sidebar`, `border`) in `styles.css` — use those for any new shell-level surface, not `--sm-bg-*`.

The product is branded **ScaleMax everywhere** — no other brand names appear in the source or the packaged asar (verified: 0 hits).

---

## 6. Security model

- Renderer fully isolated; the preload bridge is its only OS access.
- `store:get/set` enforce the PUBLIC_KEYS allowlist; `provider`/`connectors`/`user` reserved.
- API keys and connector tokens: encrypted at rest (`safeStorage`), never returned to the renderer, never logged, never in error messages. Hints expose at most the last 4 characters (nothing for tokens ≤ 8 chars).
- Workspace guard: canonical paths only (no symlinks — **note: `/tmp` is a symlink on macOS, use `/private/tmp` in tests**), secret-path denylist (`.ssh`, `.env`, keys, private agent-state dirs), protected roots (home/Desktop/Documents/Downloads), 1 MiB file caps.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. The renderer makes zero network calls — all fetching happens in main. Inline `style=` attributes in HTML are CSP-blocked, but CSSOM (`element.style.x = …` in JS) is fine (established pattern).
- All dynamic DOM uses `textContent` — **zero `innerHTML`** anywhere (project rule).
- Known accepted trade-off: main-process approvals are auto-granted (`approve: async () => true`) — the consent gates in provider/workspace exist but never prompt. Documented intentional for this local-first build.

---

## 7. Verification (how to prove things work)

**Unit** — `npm test` → 50 tests: provider (15), connectors (21), domain (14). Covers key encryption/hint safety, endpoint validation, fetch contract, prompt injection for **every** expert and skill, scheduling edge cases (DST, month-end, legacy records).

**Smoke** — `SCALEMAX_SMOKE=1 …` → 37 checks: bridge surface (7 provider + 8 workspace + 2 dialog + 5 connector methods), reserved-key isolation, provider save/test/send round-trip against a loopback stub, **live** ScaleMax key flow (discover 22 models → save → chat → clear), workspace select/list/read/write, terminal run (exit 0), automation creation (weekly, dayOfWeek, nextRun), 6 views, 7 community cards, catalog categories, theme, 0 console errors.

**UI** — Playwright is used from a local install outside the repo (not a project dep; `npm i -D playwright` to add it). Two patterns used throughout:
- Browser: static-serve `src/` + `chromium.launch()` (serve `.mjs` as `text/javascript` or modules fail).
- Real app: `_electron.launch({ args: ['.'], cwd: repo, executablePath: '<repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' })`, then `win.waitForFunction(() => document.body.dataset.appReady === 'true')`.
- Payload capture: `const { default: app } = await import('./app.js')` inside `win.evaluate` — swap `app.getProviderBridge()` with a wrapper to record what the renderer sends to main.

**Verified most recently (all green):** 50/50 unit · 37/37 smoke · live `deepseek-v4-flash` chat replies · skill Run produced a structured review of the open file · connector fetch hit the real GitHub API (invalid test token → "Provider rejected the stored token.") · 0 console errors · packaged asar clean of PII/branding.

---

## 8. Live API key (for testing)

The app's provider is **already configured** in `~/Library/Application Support/scalemax-ide/` with the user's ScaleMax key (encrypted via safeStorage) and model `deepseek-v4-flash`. For smoke/live tests pass it as env:

```
SCALEMAX_LIVE_KEY=<ask the project owner — not stored in this file>
SCALEMAX_LIVE_MODEL=deepseek-v4-flash
```

⚠️ The key is deliberately not written here. Get it from the project owner and pass it only as an environment variable. Never commit it or write it into packaged files. The running app already has it stored encrypted, so normal use needs nothing.

Provider endpoint: `https://api.scalemax.pro/token/v1` (the `/v1` root rejects these keys — discover tries both). 22 models; `deepseek-v4-flash` verified replying.

---

## 9. Timeline of what was done (condensed)

1. **Origin** — app cloned from screenshots of a production workspace app, then found to be a demo shell (fake chat, fake auth, dead code).
2. **Made real** — provider engine wired (real chat), workspace access wired, tests + smoke harness added, PII removed from auth path.
3. **Frontend port** — the production app's actual design system extracted from its bundle: real tokens (3,791), Assistant font, shell metrics, full UI re-skin. Dark theme fixed with `--sm-app-*` surface aliases.
4. **Feature completion** — terminal console wired, catalog filters, community cards, theme, exports, automation scheduler, expert/skill prompts actually applied to requests, resource search.
5. **Connector backend** — encrypted credential store, real API validation, then live GitHub data fetch injected into chat.
6. **Bug-fix sweep** — full audit (2 subagent sweeps + manual verification) → all P1/P2 fixed: PII scrubbed from shipped code, atomic state writes, cross-project write prevention, dirty-file guard, automation resume safety, legacy consent enforcement, attachment cleanup, toast/dialog layering, ID collisions, auto-persist, expandable folders, honest connector labels.
7. **Specialization pass** — experts seed real work + chips, skills Run on real files, connectors feed live repo data into conversations.

---

## 10. Known gaps / suggested next steps

- **No streaming** — chat is request/response (`stream: false`). Streaming would need main-process SSE + an event channel to the renderer (currently zero `ipcMain.on` push channels exist).
- **Automations only run while the window is open** (renderer scheduler, by design — the UI says so). A main-process scheduler would survive minimization/closure.
- **Connector fetch is GitHub-only** — the action map in `lib/connectors.cjs` supports `github/repo`; extending to other providers (Notion pages, Slack channels, Linear issues) follows the same pattern.
- **No tool-use loop** — connectors inject context; the model can't autonomously call them mid-generation (no function-calling).
- **No code signing / notarization** — Gatekeeper warns on other Macs.
- **No git repo / CI** — `git init` + a CI runner for `npm test` are the obvious first steps.
- **Editor is a textarea** — no syntax highlighting; Monaco/CodeMirror would slot into `#editor-body` (keep the gutter or replace it).
- **Session-key expiry** is surfaced in the status line but connectors don't explain session-token loss after restart (they just show Connect again).
- **`build/electron-runtime.cjs`** — npm's Electron postinstall can exit 0 with a truncated runtime; the check/repair tooling exists, keep it.

---

## 11. Gotchas for anyone editing this codebase

1. `/tmp` is a symlink on macOS — the workspace guard rejects it; use `/private/tmp/...` for test fixtures.
2. `[hidden]` loses to CSS `display` rules — `styles.css` has a global `[hidden]{display:none!important}` guard; keep it.
3. Native `<dialog>` paints in the top layer above all z-index — `showToast()` re-parents the toast into any open dialog; preserve that if you touch toasts.
4. `--sm-bg-*` tokens are component-scoped; use `--sm-app-*` for shell surfaces (see §5).
5. CSP blocks inline `style=` attributes in HTML but allows CSSOM in JS.
6. The smoke check asserts exact method counts (7 provider, 8 workspace, 5 connector) — update `build/smoke-check.cjs` when you add bridge methods.
7. `store:set` returns `true`/`false` — the renderer's `persist()` relies on `false` to fall back to localStorage.
8. Renderer modules are ES modules; main-process files are CommonJS. `package.json` has no `"type"` field.
9. `sm-tokens.css` is generated — regenerate rather than hand-edit.
10. The old `REPO_ANALYSIS.md` (workspace root, one level up) describes a **pre-fix** state and is outdated; `PROJECT_SUMMARY.md` in-repo is the (older) progress log. This file is the source of truth.

---

*Handoff written after the full verification pass: 50/50 unit tests, 37/37 smoke checks, live provider replies, live connector API round-trip, packaged asar clean. The app was left running with the provider configured (`deepseek-v4-flash`).*
