# ScaleMax IDE — Project Handoff

Complete context for an AI or engineer taking over this project. Everything below reflects the verified state of the repo at the time of writing (end of session 3, 2026-09-26).

---

## 1. What this is

**ScaleMax IDE** — a native macOS Electron app: a local-first AI development workspace. Chat-first task model, provider-key authentication (ScaleMax API, OpenAI-compatible), an IDE-style Workspace tab (tabbed editor, file tree, Git, terminal), MCP tool servers the model can call, an Experts · Skills · Connectors catalog (custom experts/skills, OAuth or token connectors), scheduled automations, light/dark themes.

- **Stack**: Electron 33.4.11, electron-builder 25.1.8, vanilla ES modules — **no build step, no runtime dependencies**, no TypeScript, no bundler.
- **Repository**: https://github.com/Sagar3079/scalemax-ide
- **macOS-only** build target (dmg + zip, arm64), unsigned.

---

## 2. Quick start

```bash
git clone https://github.com/Sagar3079/scalemax-ide.git && cd scalemax-ide
npm install                # devDeps only (electron, electron-builder)

npm start                  # runs prestart runtime check, then electron .
npm test                   # node --test test/*.test.cjs test/*.test.mjs → 187 unit tests
npm run build              # electron-builder --mac → dist/ScaleMax-1.0.0-arm64.dmg + .zip

# Hermetic end-to-end smoke check (boots the real app, isolated userData):
SCALEMAX_SMOKE=1 npm start                     # 42 checks
# With live provider verification (discover → save → chat → clear): 47 checks
SCALEMAX_SMOKE=1 SCALEMAX_LIVE_KEY='sm_live_…' SCALEMAX_LIVE_MODEL='deepseek-v4-flash' npm start
# Prints "SMOKE_RESULT {ok, checks, …}" and exits 0/1.

# Run the real app against a throwaway profile (UI testing, Playwright):
SCALEMAX_USER_DATA=/private/tmp/some-profile npm start

# Browser preview (no Electron): serve the project root so assets/ fonts load.
python3 -m http.server 8765    # → http://localhost:8765/src/index.html
```

Electron runtime issues (truncated installs, missing `path.txt`): `npm run repair:electron`. Never hand-create `path.txt`.

---

## 3. Architecture

Three tiers, textbook Electron:

```
main.js (Node)             → 36 ipcMain.handle channels, all wrapped in {ok,data}/{ok,error} envelopes except app:* and store:*
preload.js (contextBridge) → window.scalemaxAPI: 37 methods = 36 channels across 7 namespaces
                              (app 2, store 2, provider 7, connectors 10, mcp 5, dialog 2, workspace 8) + getPlatform()
src/ (renderer, isolated)  → contextIsolation:true, nodeIntegration:false, webSecurity:true
```

### File map (hand-written code)

| File | Lines | Role |
|---|---:|---|
| `src/sm-tokens.css` | 3,911 | Design tokens: 3,791 `--sm-*` variables (light `:root` + `[data-theme="dark"]`), Assistant @font-face. **Generated — regenerate, don't hand-edit.** |
| `src/styles.css` | ~2,470 | Component styles on the tokens (11 sections). Shell aliases `--sm-app-*` incl. `--sm-app-muted` (badges). |
| `src/app.js` | ~1,760 | Renderer singleton `app`: tasks, chat (tool-call chips), catalogs, custom experts/skills rendering, automations, search, toasts; delegates the Workspace tab to `workspace-ui.js`. |
| `lib/mcp.cjs` | ~1,700 | MCP client manager: stdio (newline JSON-RPC, process-group kill) + Streamable HTTP (JSON/SSE, session id, protocol header); encrypted env/header secrets; `chatTools()` for the tool loop. |
| `lib/connectors.cjs` | ~1,160 | Connector credentials (safeStorage), 24 validation endpoints, GitHub live fetch, **OAuth**: client configs (`connectorOAuthClients`), `startOAuth`, refresh, identity. |
| `src/workspace-ui.js` | ~1,120 | Workspace tab: per-tab editor model, ARIA file tree + bounded filter crawl, splitters (persisted), panel tabs, Cmd/Ctrl+S, Tab/Shift+Tab, tokenizer + highlight overlay. Pure helpers are unit-tested. |
| `src/workspace.css` | ~1,020 | Workspace IDE layout (toolbar, explorer, tabs, gutter/overlay, bottom panel, statusbar). |
| `lib/provider.cjs` | ~710 | OpenAI-compatible client: ScaleMax preset (tries `/v1` then `/token/v1`), discover, `send`, internal `complete` (tools/tool_calls), 4 MB caps, 120 s timeout, redirects rejected, safeStorage keys. |
| `lib/oauth.cjs` | ~690 | Loopback OAuth 2.0 engine: `authorize` (127.0.0.1 or localhost + ::1, state, PKCE S256, abort), `tokenRequest` (post/basic, form/json, 256 KB cap), `refresh`, `fetchIdentity`. |
| `src/connector-catalog.js` | 662 | 40 connector setup guides. |
| `src/catalog-ui.js` | ~660 | Catalog filters (built-in + custom), community cards, theme, exports, detail dialogs, connector dialog incl. **OAuth sign-in UI**. |
| `lib/oauth-catalog.cjs` | ~630 | Main-owned OAuth provider rules for 25 connectors (URLs, scopes, PKCE, secret mode, redirect host, identity endpoint, register/docs URLs), verified against provider docs 2026-09-26. |
| `src/index.html` | ~585 | Shell: 6 views + search/detail/connector/custom/MCP dialogs + toast. Strict CSP (`connect-src 'none'`), no inline `style=`. |
| `src/skill-catalog.js` | 521 | 30 builtin skill templates + 7 community repos. |
| `src/avatars.js` | ~520 | Animated 2D expert characters: `avatarSpec()` (pure data) + `renderAvatar()` (createElementNS only). 8 built-ins + seeded custom characters. |
| `main.js` | ~440 | Main process, IPC surface, state store, MCP manager + tool loop wiring, smoke / `SCALEMAX_USER_DATA` profile isolation, MCP shutdown on quit. |
| `build/smoke-check.cjs` | ~410 | 42-check harness (+5 live). Spawns the MCP fixture with this Electron binary (`ELECTRON_RUN_AS_NODE`). |
| `src/domain.mjs` | ~380 | Pure logic: settings/tasks/automations normalization, `nextRunAt` (once/hourly/daily/weekly/monthly/interval, DST-safe), `buildSystemPrompt` (built-in + custom), `searchItems` (incl. custom). |
| `src/mcp-ui.js` | ~350 | MCP server cards + add/edit dialog (Assistant card 03). |
| `lib/tool-loop.cjs` | ~280 | `createToolLoop({provider, mcp})`: offers MCP tools, runs tool calls (≤ 8 rounds, ≤ 8 calls/round), permission-aware, cancellable. |
| `src/scheduler.js` | ~240 | Automation engine (30 s poll, catch-up once, no double runs, history). |
| `src/custom-ui.js` | ~220 | Create/edit/delete custom experts (colour + prop picker with live avatar preview) and skills. |
| `preload.js` | ~220 | The bridge (see counts above). |
| `lib/state.cjs` | 159 | Atomic, validated JSON store (PUBLIC_KEYS allowlist incl. `customExperts`, `customSkills`). |
| `src/custom-catalog.js` | 104 | Validators for custom experts/skills. |
| `src/experts.css` | ~95 | Avatar sizing + CSS-only animation (bob, staggered blink, hover hop/wiggle), fully off under `prefers-reduced-motion`. |
| `src/oauth-catalog.js` | ~30 | Renderer-side `OAUTH_SUPPORT` (id → loopback support); a test keeps it in sync with `lib/oauth-catalog.cjs`. |
| `src/terminal.js`, `src/web-shim.js`, `src/data.js` | small | Console binding, browser bridge stand-in, catalog re-exports + 8 experts. |

### IPC surface (36 channels, all paired with preload — recount script logic: every `ipcMain.handle('x:y'` plus channel-table keys)

- `store:get` / `store:set` — PUBLIC_KEYS allowlist (`tasks, settings, automations, skillStates, connectorStates, currentTaskId, customExperts, customSkills`). `provider`, `connectors`, `connectorOAuthClients`, `mcpServers`, `user` are reserved (also refused by `lib/state.cjs`).
- `provider:get/save/test/discover/send/cancel/clear` — `send` goes through the tool loop (MCP tools) when the provider is configured; `cancel` cancels the loop and the HTTP request.
- `connector:list/save/remove/test/fetch` + `connector:oauth-config-save/-config-get/-start/-status/-disconnect` — tokens and client secrets never cross the bridge.
- `mcp:list/save/remove/test/tools` — env/header values are write-only; tool calls only run inside chat.
- `workspace:select/list/read/write/git-status/git-diff/run/cancel`, `dialog:open-folder/open-file`, `app:get-version/quit`.

### State

- `~/Library/Application Support/scalemax-ide/scalemax-state.json`, written atomically (temp+fsync+rename, 0600). Corrupt file → renamed `.corrupt-<ts>`, fresh store.
- Smoke runs use a temp userData dir; `SCALEMAX_USER_DATA` points any run at a throwaway profile.
- Workspace pane sizes and the selected panel tab live in renderer `localStorage` (`scalemax-workspace-layout`).

---

## 4. Feature behavior (what "working" means)

**Provider / auth.** No sign-in screen — the provider key is the auth. ScaleMax preset discovers the endpoint that accepts the key (currently `https://api.scalemax.pro/v1`, 17 models; `/token/v1` is the fallback candidate). Test → enable models → pick chat model → Save. Key encrypted with `safeStorage`.

**Chat.** Real requests via `provider:send`, non-streaming. The welcome hero shows only on an empty task. Attachments (the active editor tab, including unsaved edits, or a picked file) are injected once. When the model used MCP tools, the reply shows a "Tools used" chip row (`server · tool`, failed calls marked).

**System prompt + temperature.** System prompt = base contract + mode line + user system prompt + expert prompt + installed skill (`{{input}}` resolved) + permission line. Moving the temperature slider enables sending it; the composer shows "Active: custom prompt · temp 0.2". Verified live: payload carries both, and the reply obeyed an "answer in UPPERCASE" system prompt.

**Experts (8 + custom).** Animated character avatars (distinct characters, role props, staggered blink/bob, hover wiggle, reduced-motion safe). "Use" selects, seeds the composer, adds a chip, and applies the persona (verified live: Security Auditor flagged SQL injection). **+ New expert** opens a dialog (name, role, category, description, prompt, avatar colour + prop with live preview); custom cards get Edit/Delete; deleting clears the selection.

**Skills (30 + custom + 7 community).** Install applies the template; **Run** sends the active editor file through it (verified live: structured review found an `eval` RCE). **+ New skill** creates custom templates (`{{input}}` supported).

**Connectors (40).** Each card: **Connect** → dialog with two paths:
- **OAuth** (25 providers in `lib/oauth-catalog.cjs`): the user registers their own app (register link + exact redirect URI shown with copy buttons), enters client ID (+ secret when required; hidden for public clients such as Microsoft/Slack/Zoom; Shopify asks for the store domain) → **Sign in** opens the system browser → loopback callback on port 53682 (`127.0.0.1`, or `localhost` + `::1` where the provider only accepts localhost) → tokens encrypted, identity shown ("Signed in as …"), refresh tokens used automatically before expiry. Intercom (HTTPS-only redirects) honestly shows OAuth as unavailable. No shared client IDs ship with the app.
- **Access token**: stored encrypted and validated against the provider where an endpoint exists (24 connectors: github, sentry, notion, slack, linear, airtable, asana, cloudflare, vercel, netlify, figma, intercom, hubspot, sendgrid, stripe, discord (bot), dropbox, zoom, google-drive/-calendar, gmail, onedrive, microsoft-teams, supabase); the rest report "no validation endpoint yet". Verified against the real services: all 24 endpoints reject an invalid token with 401/403 (Slack answers 200 `ok:false`, also reported as a rejected token); a valid GitHub token verifies and feeds live repo data into chat.
- **Live data**: a chat message containing `github.com/owner/repo` pulls repo metadata + 10 open issues through the stored token.

**MCP (Assistant → 03 Tools from MCP servers).** Add a server: local command (stdio: command, args, cwd, env) or remote URL (Streamable HTTP + headers). Save tests it and lists tools (read-only tools badged). "In chat" toggle controls whether its tools are offered to the model. Permission gating: Plan only → no tools; Read-only → only tools annotated `readOnlyHint`. Verified live: deepseek-v4-flash called a stdio `echo` tool and returned its output; the public DeepWiki HTTP server initialized (protocol 2025-06-18, 3 tools).

**Workspace (IDE).** Toolbar (folder name + dimmed parent path, entries, Refresh, Open folder) · explorer (chevrons, per-type file icons, indent guides, Git letters, filter that crawls up to 200 folders skipping node_modules/.git/dist…, collapse all, full keyboard tree navigation) · tabbed editor (≤ 12 tabs, per-tab content/revision/dirty, ● marker, close with discard confirm, middle-click close, keeps edits across switches) · gutter + syntax-highlight overlay (JS/TS/JSON/CSS/HTML/Markdown/Python/shell/YAML/TOML; off for > 150 KB) · Cmd/Ctrl+S, Tab/Shift+Tab (undo preserved) · bottom panel tabs Terminal / Git changes (count badge) / Diff · resizable explorer and panel (drag or arrow keys) · statusbar (status, Ln/Col, language, branch). SHA-256-guarded saves; opening another folder closes all tabs.

**Automations.** once / hourly / daily / weekly / monthly / every N minutes; missed runs catch up once; no double runs; last 10 runs kept; Run now / pause / edit / delete. Automations use the same system prompt, temperature and tool loop as chat. Verified live: Run now produced an `Automation · <name>` task with the reply.

**Search, theme, exports.** Search covers tasks + all catalogs incl. custom items. Light/Dark/System. Task JSON and full local-data JSON exports (now incl. custom experts/skills).

**Permissions.** `readonly`/`plan` block workspace writes and commands in main; they also restrict MCP tools in chat (above).

---

## 5. Design system provenance

The palette, tokens and shell metrics come from a shipped production renderer bundle: 38px titlebar, 220px sidebar, 22px statusbar, 8px control radius; brand `--sm-palette-brand-8: #00C29A` (light) / `#4cf0ce` (dark); Assistant typeface; near-black primary buttons. App logo = ScaleMax hexagon mark (`assets/icons/scalemax-mark.svg`, icons regenerated in session 2).

**Gotcha:** `--sm-bg-*` tokens are component-scoped. Use the shell aliases `--sm-app-page/surface/surface-hover/chrome/sidebar/border/muted` for shell surfaces.

The product is branded **ScaleMax everywhere** — no other brand names in source, docs or the packaged asar.

---

## 6. Security model

- Renderer isolated; the preload bridge is its only OS access. CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. Zero `innerHTML` (avatars are built with `createElementNS`); CSSOM styling only.
- Secrets at rest (provider key, connector tokens, OAuth access/refresh tokens, OAuth client secrets, MCP env/header values) are `safeStorage`-encrypted, never returned to the renderer, never in errors or logs; session-only when encryption is unavailable.
- **OAuth**: main owns every provider URL; the renderer only passes a connector id. Only `https:` authorize pages are opened; the callback server binds loopback only, checks the Host header and a 32-byte state (timing-safe), ignores stray requests, and closes before the flow settles; one flow at a time (new flow aborts the old); PKCE where supported; token responses capped at 256 KB; provider error codes are sanitized to `[a-z0-9_]`.
- **MCP**: a stdio server runs its command with the user's permissions — the add dialog warns and the renderer asks for confirmation when the command changes (UX consent; the main process does not prompt, consistent with the documented auto-approve trade-off below). Tool descriptions and results come from third-party servers and go to the model — treat them as untrusted (prompt-injection surface). Stdio servers run in their own process group and are killed on quit.
- Workspace guard: canonical paths only (`/tmp` is a symlink on macOS — use `/private/tmp`), secret-path denylist, protected roots, 1 MiB caps.
- Known accepted trade-off: main-process approvals are auto-granted (`approve: async () => true`); workspace commands and MCP tool calls do not prompt per call. Permission modes (`readonly`/`plan`) are the gate.

---

## 7. Verification (how to prove things work)

**Unit** — `npm test` → **187 tests**: connectors 45, domain 28, provider 26, oauth 26, mcp 22, avatars 12, tool-loop 12, scheduler 6, workspace-ui 6, oauth-catalog 4. The script lists files explicitly because `node --test` alone would also execute `test/fixtures/fake-mcp-server.cjs` (a stdio server) and hang.

**Smoke** — `SCALEMAX_SMOKE=1 npm start` → **42 checks** (+5 with `SCALEMAX_LIVE_KEY`): bridge counts (7 provider, 8 workspace, 2 dialog, 10 connector, 5 mcp), reserved keys incl. `connectorOAuthClients`/`mcpServers`, provider round-trip against a loopback stub, **MCP stdio server + full tool loop** (stub model emits a tool call → echo → final reply), OAuth config write-only secret / HTTPS-only refusal / forget, connectors, automation, workspace read/write/terminal + editor tab, 6 views, 0 console errors; live: discover (either official base) → save → chat → clear.

**UI** — Playwright 1.60 is installed outside the repo at `~/Desktop/node_modules/playwright` (not a project dep). Launch pattern: `_electron.launch({ args: ['.'], cwd: repo, executablePath: '<repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', env: { ...process.env, SCALEMAX_USER_DATA: '/private/tmp/…' } })`, then wait for `document.body.dataset.appReady === 'true'`. Payload capture: `const { default: app } = await import('./app.js')` in `win.evaluate`, wrap `app.getProviderBridge()`.

**Verified in session 3 (all green):** 187/187 unit · 42/42 smoke · 47/47 live smoke · Playwright click-through of every tab in the real app (light + dark) with the live key: provider test/save via UI, system prompt + temperature reach the payload and shape the live reply, expert persona and skill Run on a real file (live replies), automation Run now (live), custom expert/skill create/edit/delete/persist/search, reduced-motion, OAuth dialog states for GitHub/OneDrive/Intercom, live GitHub token rejection, MCP stdio tool call through the live model, remote DeepWiki MCP over HTTP, Workspace tabs/save/filter/Git/diff/terminal/splitters, highlight overlay alignment probe · browser preview (web shim) 0 errors · 0 console errors in the app.

**Real-service checks (after session 3, through the app's own `lib/connectors.cjs` / `lib/oauth.cjs`):**
- All 24 token validation endpoints reject an invalid token (401/403; Slack 200 `ok:false`).
- All 25 OAuth identity endpoints reject an invalid token (Slack 200 `ok:false`; Shopify needs a real store, a made-up store 404s).
- All 25 OAuth token endpoints answer a bogus client/code with an OAuth error (`invalid_client`, `invalid_grant`, …; GitHub 404s an unknown client id; Intercom and the made-up Shopify store 404) and all 25 authorize pages exist.
- GitHub success path with a valid token: Connect → "Connection verified." → live repo data injected into a live chat reply.
- Fixed from these probes: Slack-style `200 ok:false` now reads "Provider rejected the stored token."; OAuth error codes keep only the leading code (Dropbox `invalid_client`, GitHub `not_found`).

**Packaged app (dmg rebuilt after session 3):** the dmg's `app.asar` ships only `assets/ lib/ src/ main.js preload.js package.json`, every file identical to the repo (package.json is rewritten by electron-builder), no other brand names, username or key anywhere in the bundle. The packaged `ScaleMax.app` boots with 37 bridge methods, 0 console errors, a live chat reply and an MCP tool call through the live model.

**Real OAuth sign-in (GitHub, completed):** the account owner registered a GitHub OAuth app (callback `http://127.0.0.1:53682/callback`) and entered its client ID/secret in a throwaway-profile app. Sign in with GitHub → browser consent → loopback callback → PKCE token exchange → "Signed in as <login>". Verified afterwards: `Test` 200 through the identity endpoint, repo fetch through the OAuth token, client secret and tokens encrypted at rest, no token visible to the renderer, 0 console errors. GitHub issued an 8-hour token with a refresh token; the refresh itself was not exercised live (unit-tested only). Other providers still need their own app registrations to be signed in for real.

---

## 8. Live API key (for testing)

The running app stores the user's ScaleMax key encrypted in its own profile. For smoke/live tests pass a key only as an environment variable:

```
SCALEMAX_LIVE_KEY=<ask the project owner — never stored in this repo>
SCALEMAX_LIVE_MODEL=deepseek-v4-flash
```

Never commit it or write it into packaged files. Provider endpoint: discover tries `https://api.scalemax.pro/v1` then `/token/v1`; in session 3 the key authenticated on `/v1` (17 models, `deepseek-v4-flash` replying and supporting tool calls).

---

## 9. Timeline (condensed)

1. **Origin** — cloned from screenshots of a production workspace app; initially a demo shell.
2. **Made real** — provider engine, workspace access, tests + smoke harness.
3. **Frontend port** — production design tokens, Assistant font, shell metrics, dark theme aliases.
4. **Feature completion** — terminal, filters, community cards, theme, exports, scheduler, prompt injection, search.
5. **Connector backend** — encrypted credentials, validation, live GitHub fetch.
6. **Bug-fix sweep** and **specialization pass** (experts seed work, skills run on files).
7. **Session 2** — ScaleMax logo, system prompt/temperature fixes, automation v2 (types, catch-up, history), OAuth/avatars/custom-catalog groundwork.
8. **Session 3** — OAuth end to end (engine, verified 25-provider catalog, 5 methods, UI), 19 more validation endpoints (24 total), custom experts/skills UI, animated avatars, MCP (client, tool loop, IPC, UI, smoke), Workspace IDE redesign, smoke/test expansion, live click-through.

---

## 10. Known gaps / suggested next steps

- **No streaming** — chat is request/response; the tool loop runs in main. Streaming would need an event channel (no `ipcMain.on` push channels exist yet).
- **OAuth needs user app registrations** per provider; a real sign-in has been completed for GitHub only (live token refresh not yet exercised). Several providers only document `localhost` redirects (Slack requires PKCE to be enabled first; Atlassian/Asana/Shopify loopback support is uncertain — see `redirectNote` in `lib/oauth-catalog.cjs`). OAuth `test()` uses the identity endpoint; for Slack/Linear/Shopify an identity field is required because they answer 200 on bad tokens.
- **MCP**: tools only (no resources, prompts, sampling or elicitation); no per-call approval prompt; a hanging server can delay a chat turn up to ~90 s (initialize + tools/list timeouts).
- **Automations only run while the window is open** (renderer scheduler).
- **Connector fetch is GitHub-only.**
- **Editor** is a textarea + highlight overlay (no multi-cursor, folding, find/replace). Monaco/CodeMirror could replace `.ws-code`.
- **No code signing / notarization; no CI.**
- The README screenshots in `assets/` predate sessions 2–3.

---

## 11. Gotchas

1. `/tmp` is a symlink on macOS — use `/private/tmp` for workspace fixtures.
2. `[hidden]` loses to `display` rules — keep the global `[hidden]{display:none!important}`.
3. Native `<dialog>` paints in the top layer — `showToast()` re-parents the toast into any open dialog.
4. `--sm-bg-*` are component-scoped; use `--sm-app-*` for shell surfaces.
5. CSP blocks inline `style=` in HTML; CSSOM in JS is fine.
6. The smoke check asserts exact bridge counts (7 provider, 8 workspace, 2 dialog, 10 connector, 5 mcp) — update `build/smoke-check.cjs` when adding bridge methods.
7. `store:set` returns `true`/`false`; `persist()` falls back to localStorage on `false`.
8. Renderer = ES modules, main = CommonJS; `package.json` has no `"type"` (Node prints a harmless module-type warning when tests import `src/*.js`).
9. `sm-tokens.css` is generated.
10. `npm test` must keep explicit globs (fixture server under `test/fixtures/`).
11. The OAuth callback port is fixed at 53682 (registered redirect URIs depend on it).
12. `lib/oauth-catalog.cjs` (main) and `src/oauth-catalog.js` (renderer) must stay in sync — `test/oauth-catalog.test.mjs` enforces it.
13. Workspace element ids used by app.js/terminal.js/smoke-check must stay: `workspace-open/refresh/path/status`, `file-tree`, `editor-tab/title/path/save/status/input/gutter`, `git-refresh/status/files/diff`, `terminal-form/command/run/cancel/output`.
14. The old `REPO_ANALYSIS.md` one level up is outdated; `PROJECT_SUMMARY.md` is an older log. This file is the source of truth.

---

## 12. Session log

### Session 3 (this session) — done

All §12.3 steps from session 2 were completed:

1. OAuth: `lib/oauth.cjs` hardened (redirect host, JSON token bodies, Basic-when-secret, refresh, identity, abort, stray-request tolerance), `lib/oauth-catalog.cjs` (25 providers, researched against official docs), the 5 connector methods + `pendingOnly` cancel, preload exposure, OAuth UI in the connector dialog, 19 extra token validation endpoints (24 total), tests.
2. Custom expert/skill creation UI (`src/custom-ui.js`), avatars rewritten without `innerHTML` (`src/avatars.js`, `src/experts.css`), custom items in filters/details/search/exports.
3. MCP: `lib/mcp.cjs`, `lib/tool-loop.cjs`, `provider.complete`, `mcp:*` IPC + preload, Assistant card 03 (`src/mcp-ui.js`), tool chips in chat, smoke coverage.
4. Workspace IDE redesign (`src/workspace.css`, `src/workspace-ui.js`, new `#view-workspace` markup).
5. Integration: 36 channels / 37 bridge methods recounted, smoke check extended (42 / 47 live), 187 unit tests, live Playwright click-through of every tab.
6. Branding/PII/key grep, commit and push (see git log).

Also fixed: `npm test` hang (fixture picked up by `node --test`), CSP-blocked inline style in the composer, missing `.sr-only`, dark-theme badge contrast (`--sm-app-muted`), automation button styles, a Git diff race (file diff overwritten by a slower full diff), README cleanup (removed an outdated demo-account line).

### After session 3

Rebuilt and scanned the dmg, booted the packaged app live, probed every connector/OAuth endpoint against the real services (fixing two messages), verified GitHub with a real token and completed a real GitHub OAuth sign-in (see §7).

### Suggested next session

Streaming responses; real OAuth sign-ins for Google and Microsoft (plus a live token refresh); MCP resources/prompts; main-process automation scheduler; code signing + CI.
