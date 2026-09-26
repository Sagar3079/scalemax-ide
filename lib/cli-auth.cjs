'use strict';

// Connect GitHub through the GitHub CLI (`gh`) instead of an OAuth app of our own.
//
//   - Already logged in to gh: `gh auth token` hands over that login. One click, no browser.
//   - Not logged in: `gh auth login --web` runs GitHub's device flow in a throwaway gh config
//     directory (the user's own gh setup and keychain entry are never touched). ScaleMax opens
//     https://github.com/login/device and shows the one-time code; the user approves "GitHub CLI".
//
// The token is validated, stored encrypted by lib/connectors.cjs, and also used for GitHub's
// remote MCP server so its tools are offered in chat. Main process only: the token never
// reaches the renderer, a log line or an error message. Commands run without a shell.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVICE_URL = 'https://github.com/login/device';
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const GH_LOCATIONS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/bin/gh'];
const TOKEN_PATTERN = /^(?:gho_|ghp_|ghu_|github_pat_)[A-Za-z0-9_]{20,255}$/;
const CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const TOKEN_TIMEOUT_MS = 15_000;
const CODE_TIMEOUT_MS = 30_000;
// GitHub device codes expire after 15 minutes.
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;
// Anything that would make gh use another account, host, config or browser.
const STRIPPED_ENV = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST',
  'GH_CONFIG_DIR', 'GH_BROWSER', 'BROWSER', 'GH_PROMPT_DISABLED', 'GH_DEBUG',
]);
const DARWIN_EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];

class CliAuthError extends Error {
  constructor(message, code = 'CLI_AUTH_FAILED') {
    super(message);
    this.name = 'CliAuthError';
    this.code = code;
  }
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createCliConnect({
  connectors,
  mcp,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
  tmpDir = os.tmpdir(),
  locations = GH_LOCATIONS,
  clipboard = null,
} = {}) {
  if (!connectors || typeof connectors.save !== 'function' || typeof connectors.test !== 'function') {
    throw new TypeError('A connector store is required.');
  }
  // One GitHub CLI sign-in at a time.
  let pending = null;

  function baseEnv() {
    const output = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && !STRIPPED_ENV.has(key)) output[key] = value;
    }
    // GUI-launched apps get a minimal PATH; gh may need git and friends from Homebrew.
    if (platform === 'darwin') {
      const parts = (output.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
      output.PATH = [...parts, ...DARWIN_EXTRA_PATHS.filter((entry) => !parts.includes(entry))].join(':');
    }
    output.GH_NO_UPDATE_NOTIFIER = '1';
    output.NO_COLOR = '1';
    return output;
  }

  function findGh() {
    const fromPath = String(env.PATH || '').split(':').filter(Boolean).map((entry) => path.join(entry, 'gh'));
    for (const candidate of [...fromPath, ...locations]) {
      if (path.isAbsolute(candidate) && isExecutable(candidate)) return candidate;
    }
    return null;
  }

  // Runs gh and collects bounded output. `onOutput` sees stdout+stderr text as it arrives.
  function run(gh, args, { runEnv, timeoutMs, onOutput, signal } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(gh, args, { env: runEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        reject(new CliAuthError('Could not start the GitHub CLI.'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer = null;
      const stop = () => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (error) {
          stop();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(() => finish(new CliAuthError('The GitHub CLI sign-in timed out.', 'TIMEOUT')), timeoutMs);
      timer.unref?.();
      const onAbort = () => finish(new CliAuthError('GitHub sign-in was cancelled.', 'CANCELLED'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
      const collect = (which) => (chunk) => {
        const text = chunk.toString('utf8');
        if (which === 'out' && stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        if (which === 'err' && stderr.length < MAX_OUTPUT_BYTES) stderr += text;
        try { onOutput?.(text); } catch { /* observers never break the run */ }
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      child.stdin?.on('error', () => {});
      child.on('error', () => finish(new CliAuthError('Could not start the GitHub CLI.')));
      child.on('close', (code) => {
        clearTimeout(killTimer);
        finish(null, { code, stdout, stderr });
      });
    });
  }

  async function tokenFrom(gh, runEnv) {
    let result;
    try {
      result = await run(gh, ['auth', 'token', '--hostname', 'github.com'], { runEnv, timeoutMs: TOKEN_TIMEOUT_MS });
    } catch {
      return null;
    }
    const token = result.code === 0 ? result.stdout.trim() : '';
    return TOKEN_PATTERN.test(token) ? token : null;
  }

  // Stores and validates the token, then offers GitHub's MCP tools in chat with it.
  async function adopt(token, source) {
    connectors.save({ id: 'github', token });
    const outcome = await connectors.test({ id: 'github' });
    if (!outcome?.ok) {
      connectors.remove({ id: 'github' });
      return { ok: false, message: outcome?.message || 'GitHub rejected the token.' };
    }
    const result = { ok: true, source, toolCount: 0, mcpError: null };
    if (!mcp) return result;
    let existing = null;
    try {
      existing = mcp.list().find((server) => server.transport === 'http' && server.url === GITHUB_MCP_URL) || null;
    } catch { /* settings unreadable: skip the tools */ }
    let savedId = null;
    try {
      const saved = mcp.save({
        ...(existing ? { id: existing.id } : {}),
        name: existing?.name || 'GitHub',
        transport: 'http',
        url: GITHUB_MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
        connector: 'github',
        enabled: true,
      });
      savedId = saved.id;
      const tested = await mcp.test({ id: savedId });
      result.toolCount = tested.tools.length;
    } catch (error) {
      // The token itself works; only the chat tools are missing.
      result.mcpError = error?.message || 'GitHub MCP server could not be connected.';
      if (savedId && !existing) {
        try { mcp.remove({ id: savedId }); } catch { /* best effort */ }
      }
    }
    return result;
  }

  function cleanup(dir) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  function requireGithub(input) {
    if (!input || typeof input !== 'object' || input.id !== 'github') {
      throw new CliAuthError('CLI sign-in is available for GitHub only.', 'CLI_UNSUPPORTED');
    }
  }

  /** Which connectors can sign in through an installed CLI. */
  function available() {
    return { github: { installed: Boolean(findGh()) } };
  }

  /**
   * Starts the GitHub CLI sign-in. Resolves to { status: 'connected', source: 'existing', ... } when an
   * existing gh login was used, or { status: 'code', code, verificationUri } while the browser
   * approval is pending (then call wait()). Starting again cancels a pending sign-in.
   */
  async function start(input, { openExternal } = {}) {
    requireGithub(input);
    if (typeof openExternal !== 'function') throw new CliAuthError('A browser opener is required.');
    const gh = findGh();
    if (!gh) {
      throw new CliAuthError('The GitHub CLI (gh) is not installed. Install it with "brew install gh", or use More options.',
        'CLI_NOT_FOUND');
    }
    cancel({ id: 'github' });
    const env0 = baseEnv();
    const existing = await tokenFrom(gh, env0);
    if (existing) {
      const adopted = await adopt(existing, 'existing');
      if (adopted.ok) return { status: 'connected', ...adopted };
      // A stale gh login: fall through to a fresh browser sign-in.
    }

    const dir = fs.mkdtempSync(path.join(tmpDir, 'scalemax-gh-'));
    fs.chmodSync(dir, 0o700);
    const controller = new AbortController();
    const runEnv = {
      ...env0,
      GH_CONFIG_DIR: dir,
      // ScaleMax opens the device page itself; gh must not launch a browser.
      GH_BROWSER: platform === 'darwin' ? '/usr/bin/true' : 'true',
    };
    let resolveCode;
    let rejectCode;
    const codeReady = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    codeReady.catch(() => {});
    let seen = '';
    const login = run(gh, [
      'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key', '--insecure-storage',
    ], {
      runEnv,
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal: controller.signal,
      onOutput: (text) => {
        seen = (seen + text).slice(-4096);
        const match = CODE_PATTERN.exec(seen);
        if (match) resolveCode(match[1]);
      },
    });
    const flow = { controller, dir, code: null, done: null };
    pending = flow;
    flow.done = (async () => {
      try {
        const result = await login;
        if (result.code !== 0) {
          throw new CliAuthError('The GitHub CLI sign-in did not complete. Try again, or update gh ("brew upgrade gh").');
        }
        const token = await tokenFrom(gh, runEnv);
        cleanup(dir);
        if (!token) throw new CliAuthError('The GitHub CLI did not return a token.');
        const adopted = await adopt(token, 'login');
        if (!adopted.ok) throw new CliAuthError(adopted.message, 'TOKEN_REJECTED');
        return { status: 'connected', ...adopted };
      } finally {
        cleanup(dir);
        if (pending === flow) pending = null;
      }
    })();
    flow.done.catch(() => {});
    // No code means gh failed early (or is too old for these flags).
    login.then(() => rejectCode(new CliAuthError('The GitHub CLI exited before showing a sign-in code. Update gh ("brew upgrade gh").')),
      (error) => rejectCode(error));
    const timer = setTimeout(() => rejectCode(new CliAuthError('The GitHub CLI did not show a sign-in code.', 'TIMEOUT')), CODE_TIMEOUT_MS);
    timer.unref?.();
    let code;
    try {
      code = await codeReady;
    } catch (error) {
      controller.abort();
      throw error instanceof CliAuthError ? error : new CliAuthError('GitHub sign-in failed.');
    } finally {
      clearTimeout(timer);
    }
    flow.code = code;
    try { clipboard?.writeText?.(code); } catch { /* copying is a convenience */ }
    try {
      await openExternal(DEVICE_URL);
    } catch { /* the user can open the page from the card */ }
    return { status: 'code', code, verificationUri: DEVICE_URL, copied: Boolean(clipboard?.writeText) };
  }

  /** Resolves once the pending browser approval finished and the token was stored. */
  async function wait(input) {
    requireGithub(input);
    if (!pending) throw new CliAuthError('No GitHub sign-in is in progress.', 'NOT_PENDING');
    return pending.done;
  }

  function cancel(input) {
    requireGithub(input);
    if (!pending) return { cancelled: false };
    const flow = pending;
    pending = null;
    flow.controller.abort();
    try { cleanup(flow.dir); } catch { /* removed when the process exits */ }
    return { cancelled: true };
  }

  function closeAll() {
    if (pending) cancel({ id: 'github' });
  }

  return { available, start, wait, cancel, closeAll };
}

module.exports = { createCliConnect, CliAuthError, GITHUB_MCP_URL, DEVICE_URL };
