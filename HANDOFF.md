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
npm test                   # node --test test/*.test.cjs test/*.test.mjs → 188 unit tests
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
main.js (Node)             → 46 ipcMain.handle channels, all wrapped in {ok,data}/{ok,error} envelopes except app:* and store:*
preload.js (contextBridge) → window.scalemaxAPI: 51 methods = 46 channels across 8 namespaces
                              (app 2, store 2, provider 10, approvals 3, connectors 15, mcp 7, dialog 2, workspace 8) + getPlatform()
                              (provider.onProgress and approvals.onRequest/onClosed are main→renderer events)
src/ (renderer, isolated)  → contextIsolation:true, nodeIntegration:false, webSecurity:true
```

### File map (hand-written code)

| File | Lines | Role |
|---|---:|---|
| `src/sm-tokens.css` | 3,911 | Design tokens: 3,791 `--sm-*` variables (light `:root` + `[data-theme="dark"]`), Assistant @font-face. **Generated — regenerate, don't hand-edit.** |
| `src/styles.css` | ~2,470 | Component styles on the tokens (11 sections). Shell aliases `--sm-app-*` incl. `--sm-app-muted` (badges). |
| `src/app.js` | ~1,760 | Renderer singleton `app`: tasks, chat (tool-call chips), catalogs, custom experts/skills rendering, automations, search, toasts; delegates the Workspace tab to `workspace-ui.js`. |
| `lib/mcp.cjs` | ~2,070 | MCP client manager: stdio (newline JSON-RPC, process-group kill) + Streamable HTTP (JSON/SSE, session id, protocol header); encrypted env/header secrets; `chatTools()` for the tool loop; **one-click sign-in** (`startOAuth`/`cancelOAuth`, encrypted `encryptedAuth` tokens, Bearer header, refresh before expiry and once on 401). |
| `lib/mcp-oauth.cjs` | ~430 | Zero-setup MCP authorization: 401 challenge → RFC 9728 resource metadata → RFC 8414/OpenID discovery → RFC 7591 dynamic client registration (public client when allowed) → PKCE S256 + RFC 8707 `resource` via `lib/oauth.cjs`; `refresh`. |
| `lib/cli-auth.cjs` | ~560 | GitHub through the GitHub CLI: downloads the latest official gh into `<userData>/tools/gh/<version>/` when it is missing (SHA-256 from the release's checksums file, GitHub Developer ID signature `VEKTX9H2N7` checked with `codesign`, `gh --version` smoke run, download hosts allowlisted, 100 MB cap), adopts an existing `gh` login (`gh auth token`) or logs the CLI in with `gh auth login --web` (normal persistent login in the user's gh config + keychain), opens the fixed device page, returns the one-time code; progress via `status()`; stores the token via the connector store and on GitHub's remote MCP server. No shell, stripped `GH_*` env, cancellable. |
| `lib/mcp-directory.cjs` | ~45 | Official remote MCP servers behind one-click connector sign-in (13 listings, 14 connectors; Jira + Confluence share Atlassian), each verified live. Renderer mirror `src/mcp-directory.js`, kept in sync by `test/mcp-directory.test.mjs`. |
| `lib/connectors.cjs` | ~1,160 | Connector credentials (safeStorage), 24 validation endpoints, GitHub live fetch, **OAuth**: client configs (`connectorOAuthClients`), `startOAuth`, refresh, identity. |
| `src/workspace-ui.js` | ~1,120 | Workspace tab: per-tab editor model, ARIA file tree + bounded filter crawl, splitters (persisted), panel tabs, Cmd/Ctrl+S, Tab/Shift+Tab, tokenizer + highlight overlay. Pure helpers are unit-tested. |
| `src/workspace.css` | ~1,020 | Workspace IDE layout (toolbar, explorer, tabs, gutter/overlay, bottom panel, statusbar). |
| `lib/provider.cjs` | ~710 | OpenAI-compatible client: ScaleMax preset (tries `/v1` then `/token/v1`), discover, `send`, internal `complete` (tools/tool_calls), 4 MB caps, 120 s timeout, redirects rejected, safeStorage keys. |
| `lib/oauth.cjs` | ~690 | Loopback OAuth 2.0 engine: `authorize` (127.0.0.1 or localhost + ::1, state, PKCE S256, abort), `tokenRequest` (post/basic, form/json, 256 KB cap), `refresh`, `fetchIdentity`. |
| `src/connector-catalog.js` | 662 | 40 connector setup guides. |
| `src/catalog-ui.js` | ~840 | Catalog filters (built-in + custom), community cards, theme, exports, detail dialogs, connector dialog incl. **one-click sign-in** (recommended section) and the **OAuth / token** paths under "Advanced". |
| `lib/oauth-catalog.cjs` | ~630 | Main-owned OAuth provider rules for 25 connectors (URLs, scopes, PKCE, secret mode, redirect host, identity endpoint, register/docs URLs), verified against provider docs 2026-09-26. |
| `src/index.html` | ~585 | Shell: 6 views + search/detail/connector/custom/MCP dialogs + toast. Strict CSP (`connect-src 'none'`), no inline `style=`. |
| `src/skill-catalog.js` | 521 | 30 builtin skill templates + 7 community repos. |
| `src/avatars.js` | ~520 | Animated 2D expert characters: `avatarSpec()` (pure data) + `renderAvatar()` (createElementNS only). 8 built-ins + seeded custom characters. |
| `main.js` | ~440 | Main process, IPC surface, state store, MCP manager + tool loop wiring, smoke / `SCALEMAX_USER_DATA` profile isolation, MCP shutdown on quit. |
| `build/smoke-check.cjs` | ~410 | 42-check harness (+5 live). Spawns the MCP fixture with this Electron binary (`ELECTRON_RUN_AS_NODE`). |
| `src/domain.mjs` | ~380 | Pure logic: settings/tasks/automations normalization, `nextRunAt` (once/hourly/daily/weekly/monthly/interval, DST-safe), `buildSystemPrompt` (built-in + custom), `searchItems` (incl. custom). |
| `src/mcp-ui.js` | ~400 | MCP server cards + add/edit dialog (Assistant card 03); Sign in / Sign in again / Cancel sign-in for https servers; saving a server that answers "requires sign-in" goes straight to the browser consent page. |
| `lib/tool-loop.cjs` | ~280 | `createToolLoop({provider, mcp})`: offers MCP tools, runs tool calls (≤ 8 rounds, ≤ 8 calls/round), permission-aware, cancellable. |
| `src/scheduler.js` | ~240 | Automation engine (30 s poll, catch-up once, no double runs, history). |
| `src/custom-ui.js` | ~220 | Create/edit/delete custom experts (colour + prop picker with live avatar preview) and skills. |
| `preload.js` | ~220 | The bridge (see counts above). |
| `lib/state.cjs` | 159 | Atomic, validated JSON store (PUBLIC_KEYS allowlist incl. `customExperts`, `customSkills`). |
| `src/custom-catalog.js` | 104 | Validators for custom experts/skills. |
| `src/experts.css` | ~95 | Avatar sizing + CSS-only animation (bob, staggered blink, hover hop/wiggle), fully off under `prefers-reduced-motion`. |
| `src/oauth-catalog.js` | ~30 | Renderer-side `OAUTH_SUPPORT` (id → loopback support); a test keeps it in sync with `lib/oauth-catalog.cjs`. |
| `src/terminal.js`, `src/web-shim.js`, `src/data.js` | small | Console binding, browser bridge stand-in, catalog re-exports + 8 experts. |

### IPC surface (46 channels, all paired with preload — recount script logic: every `ipcMain.handle('x:y'` plus channel-table keys)

- `store:get` / `store:set` — PUBLIC_KEYS allowlist (`tasks, settings, automations, skillStates, connectorStates, currentTaskId, customExperts, customSkills`). `provider`, `connectors`, `connectorOAuthClients`, `mcpServers`, `user` are reserved (also refused by `lib/state.cjs`).
- `provider:get/save/test/discover/send/cancel/clear/set-model/refresh-models` — `set-model` switches the chat model from the composer (must be a chat-capable, available catalog model for ScaleMax); `refresh-models` reloads the catalog with capabilities using the stored key; `send` goes through the tool loop (MCP tools) when the provider is configured; `cancel` cancels the loop and the HTTP request.
- `connector:list/save/remove/test/fetch` + `connector:oauth-config-save/-config-get/-start/-status/-disconnect` + `connector:cli-available/-start/-wait/-status/-cancel` (GitHub CLI sign-in; only the one-time code and status cross the bridge) — tokens and client secrets never cross the bridge.
- `mcp:list/save/remove/test/tools` + `mcp:oauth-start/-cancel` — env/header values and sign-in tokens are write-only; `oauth-start` takes a connector id (resolved in main by `lib/mcp-directory.cjs`) or a saved server id, never a URL; tool calls only run inside chat.
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

**Connectors (40).** Each card: **Connect** → dialog with up to three paths:
- **GitHub through the GitHub CLI**: Connect downloads the official GitHub CLI first if it is not installed (card: "Downloading GitHub CLI 41%…" → "Verifying…"; about 14 MB, installed inside ScaleMax's data folder, not on the shell PATH), then reuses an existing `gh` login instantly (no browser), or logs the CLI in: github.com/login/device opens with the one-time code on the card (copied to the clipboard) and it finishes when the user approves "GitHub CLI". The CLI stays logged in afterwards, like a terminal `gh auth login`. The token is validated, stored encrypted, and used for GitHub's remote MCP server (`https://api.githubcopilot.com/mcp/`, linked to the card through the MCP record's `connector` field), so the card shows "Connected · 45 tools in chat". Automatic install is macOS-only; elsewhere without gh, Connect reports that gh is needed and "More options" opens the dialog.
- **One-click sign-in** (recommended; 14 connectors: Notion, Linear, Sentry, Jira + Confluence (Atlassian), Stripe, Vercel, Cloudflare, Intercom, Supabase, Netlify, Airtable, Dropbox, Zapier). **Connect** on the card goes straight to the provider's consent page in the browser (no dialog; the card shows "Waiting for browser…" with Cancel) → approve → done. "More options" next to Connect opens the dialog. No app registration, client ID, secret or callback URL: ScaleMax registers itself with the service's official MCP server through dynamic client registration each time you sign in. The card then shows "Connected · N tools in chat" and the service's tools are offered to the model (same permission gating as any MCP server). Disconnect deletes the server entry and its tokens. The two paths below move under a collapsed "Advanced" block for these connectors.
- **OAuth** (25 providers in `lib/oauth-catalog.cjs`): the user registers their own app (register link + exact redirect URI shown with copy buttons), enters client ID (+ secret when required; hidden for public clients such as Microsoft/Slack/Zoom; Shopify asks for the store domain) → **Sign in** opens the system browser → loopback callback on port 53682 (`127.0.0.1`, or `localhost` + `::1` where the provider only accepts localhost) → tokens encrypted, identity shown ("Signed in as …"), refresh tokens used automatically before expiry. Intercom (HTTPS-only redirects) honestly shows OAuth as unavailable. No shared client IDs ship with the app.
- **Access token**: stored encrypted and validated against the provider where an endpoint exists (24 connectors: github, sentry, notion, slack, linear, airtable, asana, cloudflare, vercel, netlify, figma, intercom, hubspot, sendgrid, stripe, discord (bot), dropbox, zoom, google-drive/-calendar, gmail, onedrive, microsoft-teams, supabase); the rest report "no validation endpoint yet". Verified against the real services: all 24 endpoints reject an invalid token with 401/403 (Slack answers 200 `ok:false`, also reported as a rejected token); a valid GitHub token verifies and feeds live repo data into chat.
- **Live data**: a chat message containing `github.com/owner/repo` pulls repo metadata + 10 open issues through the stored token.

**MCP (Assistant → 03 Tools from MCP servers).** Add a server: local command (stdio: command, args, cwd, env) or remote URL (Streamable HTTP + headers). Save tests it and lists tools (read-only tools badged). "In chat" toggle controls whether its tools are offered to the model. Permission gating: Plan only → no tools; Read-only → only tools annotated `readOnlyHint`. Verified live: deepseek-v4-flash called a stdio `echo` tool and returned its output; the public DeepWiki HTTP server initialized (protocol 2025-06-18, 3 tools).

**Workspace (IDE).** Toolbar (folder name + dimmed parent path, entries, Refresh, Open folder) · explorer (chevrons, per-type file icons, indent guides, Git letters, filter that crawls up to 200 folders skipping node_modules/.git/dist…, collapse all, full keyboard tree navigation) · tabbed editor (≤ 12 tabs, per-tab content/revision/dirty, ● marker, close with discard confirm, middle-click close, keeps edits across switches) · gutter + syntax-highlight overlay (JS/TS/JSON/CSS/HTML/Markdown/Python/shell/YAML/TOML; off for > 150 KB) · Cmd/Ctrl+S, Tab/Shift+Tab (undo preserved) · bottom panel tabs Terminal / Git changes (count badge) / Diff · resizable explorer and panel (drag or arrow keys) · statusbar (status, Ln/Col, language, branch). SHA-256-guarded saves; opening another folder closes all tabs.

**Automations.** once / hourly / daily / weekly / monthly / every N minutes; missed runs catch up once; no double runs; last 10 runs kept; Run now / pause / edit / delete. Automations use the same system prompt, temperature and tool loop as chat. Verified live: Run now produced an `Automation · <name>` task with the reply.

**Search, theme, exports.** Search covers tasks + all catalogs incl. custom items. Light/Dark/System. Task JSON and full local-data JSON exports (now incl. custom experts/skills).

**Composer.** Paperclip icon (attach) · permissions chip · model button left of Send ("DeepSeek V4 Flash · Thinking · High"). The model menu (a top-layer popover, `src/composer-ui.js`) lists every model the provider offers: chat models are selectable, image/video models are listed underneath as "not available in chat". Only the list scrolls; the Thinking switch and Low/Medium/High reasoning effort always stay visible, and the menu opens above or below the button, whichever fits. The catalog is refreshed once per start with the stored key (`provider:refresh-models`). There is no per-model enable/disable step any more: the Assistant view keeps only its "Model for chat" picker. Picking a model calls `provider:set-model` (persists; the Assistant picker and statusbar follow). Reasoning is sent as `payload.reasoning = {thinking, effort}`; `lib/provider.cjs` turns it into `thinking: {type}` + `reasoning_effort` only for models whose `/models` capabilities say `reasoning: true`, and uses the model's fixed effort when `effort_locked` (Sonnet 4.6 is locked at low; the menu shows that). While a reply is in progress the transcript shows a live bubble: "Thinking… 4s" (reasoning model with thinking on) or "Writing…", switching to "Running calc · add…" and "Waiting for your approval · calc · add" from `provider:progress` events the tool loop emits. Afterwards the answer carries "Thought for Ns" (model time only, from the loop's `thinkingMs`; kept across reloads), which unfolds to the thinking text when the provider returns one (`reasoning_content`). Live check (2026-09-27): the API accepts both fields with and without tools on DeepSeek V4 Flash, Sonnet 4.6 and the free models, and they change the output, but it returns no thinking text or reasoning-token counts, and a streamed reply (`stream: true`) carries only `content` deltas, so how much each effort level reasons cannot be observed from ScaleMax and the "Thinking" section has no text to show for these models.

**Permissions (tool calls the model makes).** Three modes, from the composer chip or Assistant: **Manual** asks before every MCP tool call; **Basic** (default) runs tools annotated `readOnlyHint` automatically and asks for the rest; **Bypass all** runs everything, and is only honoured after the consent dialog (`settings.bypassConsent`; main re-checks it). A prompt shows server · tool and the arguments with Deny / Allow all in this reply / Allow; Escape denies; Stop, a timeout (15 min), a reload or a closed window deny what is pending; automations get the same prompt (labelled). A denial reaches the model as a tool error it must not retry. Old values migrate: ask/auto-write/full → basic, readonly/plan → manual. Workspace saves and commands are the user's own actions and are not gated by these modes.

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
- **One-click sign-in (MCP authorization)**: the directory URLs live in main; discovery refuses redirects, non-https endpoints, metadata whose `issuer` does not match, servers without PKCE S256, and resource metadata pointing at another origin. ScaleMax registers as a public client (`token_endpoint_auth_method: none`) where allowed, otherwise keeps the issued client secret encrypted with the tokens. Access/refresh tokens and client secrets live only in the safeStorage-encrypted `encryptedAuth` blob (session-only without encryption), are redacted from server error text, and never reach the renderer. One sign-in at a time (shared loopback port 53682).
- **GitHub CLI sign-in**: gh runs without a shell from a fixed executable path, with `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST`/`GH_CONFIG_DIR`/browser variables stripped; a fresh login is a normal gh login (the user's gh config, keychain storage); a downloaded gh only runs after its checksum and GitHub's code signature pass; only `https://github.com/login/device` is opened; the token only goes to the connector store and the GitHub MCP header (both encrypted). The consent page names "GitHub CLI" because that is the OAuth app the token belongs to; scopes are gh's defaults (`repo`, `read:org`, `gist`).
- **Tool approvals**: main owns the pending prompts (`tool:approval-request` → `tool:approval-respond`), only the window a prompt was sent to can answer it, and anything unanswered is denied. Bypass needs `bypassConsent: true` in the persisted settings, set only by the consent dialog; `normalizeSettings` drops it whenever the mode is not bypass.
- **MCP**: a stdio server runs its command with the user's permissions — the add dialog warns and the renderer asks for confirmation when the command changes (UX consent; the main process does not prompt, consistent with the documented auto-approve trade-off below). Tool descriptions and results come from third-party servers and go to the model — treat them as untrusted (prompt-injection surface). Stdio servers run in their own process group and are killed on quit.
- Workspace guard: canonical paths only (`/tmp` is a symlink on macOS — use `/private/tmp`), secret-path denylist, protected roots, 1 MiB caps.
- Known accepted trade-off: provider and workspace approvals are auto-granted (`approve: async () => true`); the user starts those actions themselves. MCP tool calls from the model are gated per call by the permission mode.

---

## 7. Verification (how to prove things work)

**Unit** — `npm test` → **230 tests**: connectors 45, mcp 32, provider 31, domain 31, oauth 26, tool-loop 19, cli-auth 8, avatars 12, mcp-oauth 8, scheduler 6, workspace-ui 6, oauth-catalog 4, mcp-directory 2. The script lists files explicitly because `node --test` alone would also execute `test/fixtures/fake-mcp-server.cjs` (a stdio server) and hang.

**Smoke** — `SCALEMAX_SMOKE=1 npm start` → **47 checks** (+5 with `SCALEMAX_LIVE_KEY`): bridge counts (10 provider, 3 approvals, 8 workspace, 2 dialog, 15 connector, 7 mcp), composer controls (icon attach, permission chip defaulting to Basic, model button, menus, dialogs), Manual-mode approval end to end (prompt appears in the window → Allow runs the tool; Deny blocks it), reserved keys incl. `connectorOAuthClients`/`mcpServers`, provider round-trip against a loopback stub, **MCP stdio server + full tool loop** (stub model emits a tool call → echo → final reply), OAuth config write-only secret / HTTPS-only refusal / forget, connectors, automation, workspace read/write/terminal + editor tab, 6 views, 0 console errors; live: discover (either official base) → save → chat → clear.

**UI** — Playwright 1.60 is installed outside the repo at `~/Desktop/node_modules/playwright` (not a project dep). Launch pattern: `_electron.launch({ args: ['.'], cwd: repo, executablePath: '<repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', env: { ...process.env, SCALEMAX_USER_DATA: '/private/tmp/…' } })`, then wait for `document.body.dataset.appReady === 'true'`. Payload capture: `const { default: app } = await import('./app.js')` in `win.evaluate`, wrap `app.getProviderBridge()`.

**Verified in session 3 (all green):** 187/187 unit · 42/42 smoke · 47/47 live smoke · Playwright click-through of every tab in the real app (light + dark) with the live key: provider test/save via UI, system prompt + temperature reach the payload and shape the live reply, expert persona and skill Run on a real file (live replies), automation Run now (live), custom expert/skill create/edit/delete/persist/search, reduced-motion, OAuth dialog states for GitHub/OneDrive/Intercom, live GitHub token rejection, MCP stdio tool call through the live model, remote DeepWiki MCP over HTTP, Workspace tabs/save/filter/Git/diff/terminal/splitters, highlight overlay alignment probe · browser preview (web shim) 0 errors · 0 console errors in the app.

**Real-service checks (after session 3, through the app's own `lib/connectors.cjs` / `lib/oauth.cjs`):**
- All 24 token validation endpoints reject an invalid token (401/403; Slack 200 `ok:false`).
- All 25 OAuth identity endpoints reject an invalid token (Slack 200 `ok:false`; Shopify needs a real store, a made-up store 404s).
- All 25 OAuth token endpoints answer a bogus client/code with an OAuth error (`invalid_client`, `invalid_grant`, …; GitHub 404s an unknown client id; Intercom and the made-up Shopify store 404) and all 25 authorize pages exist.
- GitHub success path with a valid token: Connect → "Connection verified." → live repo data injected into a live chat reply.
- Fixed from these probes: Slack-style `200 ok:false` now reads "Provider rejected the stored token."; OAuth error codes keep only the leading code (Dropbox `invalid_client`, GitHub `not_found`).

**Real MCP servers through the live model (11/11 pass):** each added to the real app (GUI-like minimal PATH), tested, then asked a question that needs one of its tools:
- stdio via npx: filesystem (`read_text_file`), memory (`create_entities`, `read_graph`), everything (`get-sum` → 42);
- stdio via uvx: time (`get_current_time`), fetch (`fetch` → "Example Domain"), git (`git_log` → latest commit message);
- Streamable HTTP, no auth: DeepWiki, Context7, Cloudflare docs, GitMCP (protocol 2025-03-26);
- Streamable HTTP with an encrypted `Authorization` header: GitHub's remote MCP server (45 tools, `get_file_contents`).
- Fixed from this run: DeepSeek sends `{}""` as arguments for tools without parameters; the tool loop now uses the leading JSON object when only quotes/whitespace follow (it previously failed those calls until the round limit and leaked raw tool-call markup).

**All 40 connector dialogs** open in the real app and match `lib/oauth-catalog.cjs` (sign-in section, secret field per secret mode, store field, redirect URI, register link, token path).

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
- **One-click sign-in covers 14 connectors only.** GitHub, Google (Drive/Calendar/Gmail), Microsoft (OneDrive/Teams), Slack, HubSpot, Zoom, Discord, Shopify, Salesforce, Asana and Figma have no usable dynamic client registration (checked live 2026-09-26: Figma refuses it with 403, Asana offers it only on its legacy SSE endpoint, the rest have none). Making them one-click needs ScaleMax-owned app registrations with each provider (public client IDs where the provider supports PKCE without a secret; a small token-broker backend for providers that insist on a client secret). GitHub is covered through the GitHub CLI when `gh` is installed (see Connectors); without gh it could also go through ScaleMax's own device flow once the owner enables Device Flow on the ScaleMax OAuth app and approves shipping its client ID. Other CLIs were considered: none gives a token usable for Google Workspace, Microsoft 365, Slack, HubSpot, Zoom, Discord or Shopify APIs; cloud CLIs (aws, gcloud, az, sf) mint short-lived cloud tokens, which no ScaleMax feature uses yet.
- **OAuth needs user app registrations** per provider (the Advanced path); a real sign-in has been completed for GitHub only (live token refresh not yet exercised). Several providers only document `localhost` redirects (Slack requires PKCE to be enabled first; Atlassian/Asana/Shopify loopback support is uncertain — see `redirectNote` in `lib/oauth-catalog.cjs`). OAuth `test()` uses the identity endpoint; for Slack/Linear/Shopify an identity field is required because they answer 200 on bad tokens.
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
6. The smoke check asserts exact bridge counts (10 provider, 3 approvals, 8 workspace, 2 dialog, 15 connector, 7 mcp) — update `build/smoke-check.cjs` when adding bridge methods.
7. `store:set` returns `true`/`false`; `persist()` falls back to localStorage on `false`.
8. Renderer = ES modules, main = CommonJS; `package.json` has no `"type"` (Node prints a harmless module-type warning when tests import `src/*.js`).
9. `sm-tokens.css` is generated.
10. `npm test` must keep explicit globs (fixture server under `test/fixtures/`).
11. The OAuth callback port is fixed at 53682 (registered redirect URIs depend on it; one-click sign-ins register `http://127.0.0.1:53682/callback` too, so only one browser sign-in can run at a time).
15. `lib/mcp-directory.cjs` (main) and `src/mcp-directory.js` (renderer) must stay in sync — `test/mcp-directory.test.mjs` enforces it. Re-verify a listing live before adding it: it must answer 401, publish resource + authorization-server metadata with a `registration_endpoint` and PKCE S256, accept the registration, and serve a real consent page for the resulting authorize URL.
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

Then **one-click connector sign-in** (users no longer have to register an OAuth app or copy a callback URL): `lib/mcp-oauth.cjs`, `lib/mcp-directory.cjs` + `src/mcp-directory.js`, OAuth sign-ins in `lib/mcp.cjs` (encrypted tokens, refresh, 401 retry), `tokenExtraFields` in `lib/oauth.cjs` (RFC 8707 `resource` on token and refresh requests), `mcp:oauth-start/-cancel` + preload `mcp.signIn/cancelSignIn`, the recommended section in the connector dialog (other paths under "Advanced"), Sign in buttons in the MCP view, 19 new tests. Verified live (2026-09-26):
- Probed 18 official remote MCP servers. 13 accepted a real dynamic registration of ScaleMax and served a real consent or login page for the resulting authorize URL in headless Chromium (Notion, Linear, Sentry, Atlassian, Stripe, Vercel, Cloudflare, Intercom, Supabase, Netlify, Airtable, Dropbox, Zapier). Figma refused registration (403); Asana v2, GitHub, HubSpot and Slack offer no registration.
- In the real app (throwaway profile, `shell.openExternal` captured): all 40 connector dialogs show the right layout; the one-click button for Notion, Jira, Linear and Stripe opened the provider's real consent/login page, showed the pending state, and Cancel left nothing saved; 0 console errors.
- 207/207 unit, 42/42 smoke, 47/47 live smoke.
- **Real one-click sign-in completed (Sentry):** the owner approved in the browser; the server saved with 9 tools, `tokenAuth: none` (public client, no secret), tokens only in the encrypted blob (no token fields in plaintext); deepseek-v4-flash then called `find_organizations` through it and answered with the real organization.
- Card flow (after the owner asked for "click Connect → permission page"): Connect on a one-click card opens the consent page directly for Notion, Linear and Confluence; a second Connect cancels the first; Cancel resets the card; nothing is saved; 0 console errors.
- Not yet verified: a live token refresh (Sentry tokens last 1 hour; refresh is unit-tested).
- **GitHub via the GitHub CLI (live, gh 2.74.2):** existing login → Connect in the real app → "Connected · 45 tools in chat" (GitHub MCP server, token validated, no browser opened, no plaintext token in the state file) → Disconnect removed the server and the token. Device-flow path (gh forced to see no login): the card showed the real one-time code with Copy/Cancel, only github.com/login/device was opened, Cancel killed gh and deleted the throwaway config. Completing that device approval with a second account was not exercised.
- **Automatic gh install (live, gh 2.101.0):** with the system gh hidden (dev-only `SCALEMAX_GH_SYSTEM=ignore`, `SCALEMAX_GH_HOME` for an empty login), Connect in the real app went Connecting → Downloading GitHub CLI 3% → 41% → Verifying → Checking login → Starting login → "Code XXXX-XXXX · Copy code · Cancel"; the real release zip matched its checksum and GitHub's Developer ID signature, only github.com/login/device was opened, Cancel stopped gh; 0 console errors. With the user's keychain login visible, the freshly downloaded gh picked it up and connected at once (45 tools).
- GitHub device flow: the owner's OAuth app (`ScaleMax IDE (local)`) currently answers `device_flow_disabled`.

### Suggested next session

Streaming responses; real OAuth sign-ins for Google and Microsoft (plus a live token refresh); MCP resources/prompts; main-process automation scheduler; code signing + CI.
