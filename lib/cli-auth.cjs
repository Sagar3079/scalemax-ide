'use strict';

// Connect GitHub through the GitHub CLI (`gh`) instead of an OAuth app of our own.
//
//   1. gh missing: download the latest official release from github.com/cli/cli into ScaleMax's
//      own tools folder (no admin rights, no Homebrew). The zip must match the release's SHA-256
//      checksum and the binary must carry GitHub's Apple Developer ID signature before it runs.
//   2. Already logged in to gh: `gh auth token` hands over that login. No browser.
//   3. Not logged in: `gh auth login --web` logs the CLI in (a normal, persistent gh login).
//      ScaleMax opens https://github.com/login/device and shows the one-time code.
//
// The token is validated, stored encrypted by lib/connectors.cjs, and also used for GitHub's
// remote MCP server so its tools are offered in chat. Main process only: the token never
// reaches the renderer, a log line or an error message. Commands run without a shell.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVICE_URL = 'https://github.com/login/device';
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const RELEASE_API = 'https://api.github.com/repos/cli/cli/releases/latest';
const DOWNLOAD_BASE = 'https://github.com/cli/cli/releases/download';
// Release downloads redirect from github.com to GitHub's asset storage.
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
// GitHub, Inc.'s Apple Developer ID team; every official macOS gh binary is signed with it.
const GITHUB_TEAM_ID = 'VEKTX9H2N7';
const GH_LOCATIONS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/bin/gh'];
const TOKEN_PATTERN = /^(?:gho_|ghp_|ghu_|github_pat_)[A-Za-z0-9_]{20,255}$/;
const CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const VERSION_PATTERN = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/;
const TOKEN_TIMEOUT_MS = 15_000;
const CODE_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// GitHub device codes expire after 15 minutes.
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
// Anything that would make gh use another account, host or browser.
const STRIPPED_ENV = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST',
  'GH_BROWSER', 'BROWSER', 'GH_PROMPT_DISABLED', 'GH_DEBUG',
]);
const DARWIN_EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];
const ARCH_NAMES = { arm64: 'arm64', x64: 'amd64' };

class CliAuthError extends Error {
  constructor(message, code = 'CLI_AUTH_FAILED') {
    super(message);
    this.name = 'CliAuthError';
    this.code = code;
  }
}

function cancelledError() {
  return new CliAuthError('GitHub sign-in was cancelled.', 'CANCELLED');
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

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// Runs a command (no shell) and collects bounded output. `onOutput` sees text as it arrives.
function runProcess(spawnImpl, command, args, { runEnv, timeoutMs, onOutput, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { env: runEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    const onAbort = () => finish(cancelledError());
    const timer = setTimeout(() => finish(new CliAuthError('The GitHub CLI sign-in timed out.', 'TIMEOUT')), timeoutMs);
    timer.unref?.();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) {
        stop();
        reject(error);
      } else resolve(value);
    }
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

// Official binaries only: GitHub's Developer ID signature, checked by the system's codesign.
async function verifyGithubSignature(file, { signal } = {}) {
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${GITHUB_TEAM_ID}"`;
  const result = await runProcess(spawn, '/usr/bin/codesign',
    ['--verify', '--strict', '--test-requirement', requirement, file], { timeoutMs: TOOL_TIMEOUT_MS, signal });
  if (result.code !== 0) {
    throw new CliAuthError('The downloaded GitHub CLI is not signed by GitHub, so it was not installed.', 'CLI_UNTRUSTED');
  }
}

function createCliConnect({
  connectors,
  mcp,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  locations = GH_LOCATIONS,
  clipboard = null,
  toolsDir = path.join(os.tmpdir(), 'scalemax-tools'),
  fetchImpl = fetch,
  toolSpawn = spawn,
  verifyBinary = verifyGithubSignature,
} = {}) {
  if (!connectors || typeof connectors.save !== 'function' || typeof connectors.test !== 'function') {
    throw new TypeError('A connector store is required.');
  }
  const ghRoot = path.join(toolsDir, 'gh');
  // The GitHub CLI connect in progress (download, login or approval); one at a time.
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

  // The newest copy ScaleMax installed itself: <toolsDir>/gh/<version>/bin/gh.
  function managedGh() {
    let versions = [];
    try {
      versions = fs.readdirSync(ghRoot).filter((name) => VERSION_PATTERN.test(name) && !name.startsWith('v'));
    } catch {
      return null;
    }
    versions.sort(compareVersions).reverse();
    for (const version of versions) {
      const file = path.join(ghRoot, version, 'bin', 'gh');
      if (isExecutable(file)) return file;
    }
    return null;
  }

  function findGh() {
    const fromPath = String(env.PATH || '').split(':').filter(Boolean).map((entry) => path.join(entry, 'gh'));
    for (const candidate of [...fromPath, ...locations]) {
      if (path.isAbsolute(candidate) && isExecutable(candidate)) return candidate;
    }
    return managedGh();
  }

  function installTarget() {
    return platform === 'darwin' && Object.hasOwn(ARCH_NAMES, arch) ? ARCH_NAMES[arch] : null;
  }

  function checkActive(flow) {
    if (flow.controller.signal.aborted || pending !== flow) throw cancelledError();
  }

  async function download(url, flow, { maxBytes, toFile = null }) {
    const { signal } = flow.controller;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': 'ScaleMax', Accept: 'application/octet-stream' },
        redirect: 'follow', credentials: 'omit', signal,
      });
    } catch {
      if (signal.aborted) throw cancelledError();
      throw new CliAuthError('Could not download the GitHub CLI. Check your internet connection.', 'DOWNLOAD_FAILED');
    }
    let finalUrl;
    try { finalUrl = new URL(response.url || url); } catch { finalUrl = null; }
    if (!finalUrl || finalUrl.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
      response.body?.cancel?.().catch?.(() => {});
      throw new CliAuthError('The GitHub CLI download was redirected to an unexpected host.', 'DOWNLOAD_FAILED');
    }
    if (response.status !== 200 || !response.body?.getReader) {
      response.body?.cancel?.().catch?.(() => {});
      throw new CliAuthError(`The GitHub CLI download failed (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    }
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (declared > maxBytes) throw new CliAuthError('The GitHub CLI download is unexpectedly large.', 'DOWNLOAD_FAILED');
    if (toFile) {
      flow.total = declared;
      flow.received = 0;
    }
    const reader = response.body.getReader();
    const chunks = [];
    const hash = crypto.createHash('sha256');
    const out = toFile ? fs.openSync(toFile, 'w', 0o600) : null;
    let total = 0;
    try {
      while (true) {
        let step;
        try {
          step = await reader.read();
        } catch {
          if (signal.aborted) throw cancelledError();
          throw new CliAuthError('The GitHub CLI download was interrupted.', 'DOWNLOAD_FAILED');
        }
        if (step.done) break;
        total += step.value.byteLength;
        if (total > maxBytes) throw new CliAuthError('The GitHub CLI download is unexpectedly large.', 'DOWNLOAD_FAILED');
        hash.update(step.value);
        if (out !== null) {
          fs.writeSync(out, step.value);
          flow.received = total;
        } else chunks.push(Buffer.from(step.value));
      }
    } finally {
      if (out !== null) fs.closeSync(out);
      try { reader.releaseLock(); } catch { /* released */ }
    }
    checkActive(flow);
    return { sha256: hash.digest('hex'), text: out === null ? Buffer.concat(chunks).toString('utf8') : '' };
  }

  async function latestVersion(flow) {
    const { signal } = flow.controller;
    let response;
    try {
      response = await fetchImpl(RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ScaleMax' },
        redirect: 'error', credentials: 'omit', signal,
      });
    } catch {
      if (signal.aborted) throw cancelledError();
      throw new CliAuthError('Could not reach GitHub to download the GitHub CLI.', 'DOWNLOAD_FAILED');
    }
    const text = response.status === 200 ? await response.text() : '';
    checkActive(flow);
    let tag = null;
    if (text && Buffer.byteLength(text) <= MAX_RELEASE_JSON_BYTES) {
      try { tag = JSON.parse(text).tag_name; } catch { tag = null; }
    }
    const match = typeof tag === 'string' ? VERSION_PATTERN.exec(tag) : null;
    if (!match) throw new CliAuthError(`Could not find the latest GitHub CLI release (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    return match[1];
  }

  async function runTool(command, args, flow) {
    const result = await runProcess(toolSpawn, command, args, { timeoutMs: TOOL_TIMEOUT_MS, signal: flow.controller.signal });
    checkActive(flow);
    return result;
  }

  /** Downloads, verifies and installs the latest official gh into ScaleMax's tools folder. */
  async function install(flow) {
    const target = installTarget();
    if (!target) {
      throw new CliAuthError('Automatic GitHub CLI install is available on macOS only. Install gh, or use More options.',
        'CLI_NOT_FOUND');
    }
    flow.phase = 'downloading';
    const version = await latestVersion(flow);
    flow.version = version;
    const name = `gh_${version}_macOS_${target}.zip`;
    fs.mkdirSync(ghRoot, { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(ghRoot, '.staging-'));
    try {
      const zip = path.join(staging, name);
      const sums = await download(`${DOWNLOAD_BASE}/v${version}/gh_${version}_checksums.txt`, flow, { maxBytes: MAX_CHECKSUMS_BYTES });
      const expected = sums.text.split('\n').map((line) => line.trim().split(/\s+/))
        .find((parts) => parts.length === 2 && parts[1] === name)?.[0];
      if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new CliAuthError('The GitHub CLI release has no checksum for this Mac.', 'DOWNLOAD_FAILED');
      }
      const got = await download(`${DOWNLOAD_BASE}/v${version}/${name}`, flow, { maxBytes: MAX_ZIP_BYTES, toFile: zip });
      flow.phase = 'verifying';
      if (got.sha256 !== expected) {
        throw new CliAuthError('The GitHub CLI download did not match its published checksum, so it was not installed.',
          'CLI_UNTRUSTED');
      }
      const extracted = path.join(staging, 'out');
      const unzip = await runTool('/usr/bin/ditto', ['-x', '-k', zip, extracted], flow);
      if (unzip.code !== 0) throw new CliAuthError('The GitHub CLI download could not be unpacked.', 'DOWNLOAD_FAILED');
      const folder = path.join(extracted, `gh_${version}_macOS_${target}`);
      const binary = path.join(folder, 'bin', 'gh');
      if (!isExecutable(binary) || fs.lstatSync(binary).isSymbolicLink()) {
        throw new CliAuthError('The GitHub CLI download did not contain the gh program.', 'DOWNLOAD_FAILED');
      }
      await verifyBinary(binary, { signal: flow.controller.signal });
      checkActive(flow);
      const check = await runTool(binary, ['--version'], flow);
      if (check.code !== 0 || !check.stdout.includes(version)) {
        throw new CliAuthError('The downloaded GitHub CLI did not start.', 'DOWNLOAD_FAILED');
      }
      flow.phase = 'installing';
      const destination = path.join(ghRoot, version);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(folder, destination);
      return path.join(destination, 'bin', 'gh');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async function tokenFrom(gh, runEnv, signal) {
    let result;
    try {
      result = await runProcess(spawnImpl, gh, ['auth', 'token', '--hostname', 'github.com'],
        { runEnv, timeoutMs: TOKEN_TIMEOUT_MS, signal });
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
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

  function requireGithub(input) {
    if (!input || typeof input !== 'object' || input.id !== 'github') {
      throw new CliAuthError('CLI sign-in is available for GitHub only.', 'CLI_UNSUPPORTED');
    }
  }

  /** Which connectors can sign in through a CLI, and whether it is installed or installable. */
  function available() {
    return { github: { installed: Boolean(findGh()), installable: Boolean(installTarget()) } };
  }

  /** Progress of the connect in progress (for the card while gh downloads). */
  function status(input) {
    requireGithub(input);
    if (!pending) return { phase: 'idle' };
    const output = { phase: pending.phase };
    if (pending.phase === 'downloading' && pending.total > 0) {
      output.percent = Math.min(100, Math.floor((pending.received / pending.total) * 100));
    }
    if (pending.version) output.version = pending.version;
    return output;
  }

  /**
   * Starts the GitHub CLI connect. Resolves to { status: 'connected', ... } when an existing gh
   * login was used, or { status: 'code', code, verificationUri } while the browser approval is
   * pending (then call wait()). `installed` tells whether gh was downloaded first. Starting again
   * cancels a connect in progress.
   */
  async function start(input, { openExternal } = {}) {
    requireGithub(input);
    if (typeof openExternal !== 'function') throw new CliAuthError('A browser opener is required.');
    cancel({ id: 'github' });
    const flow = { controller: new AbortController(), phase: 'starting', received: 0, total: 0, version: null, done: null };
    pending = flow;
    const { signal } = flow.controller;
    const release = () => { if (pending === flow) pending = null; };
    let installed = false;
    try {
      let gh = findGh();
      if (!gh) {
        gh = await install(flow);
        installed = true;
      }
      checkActive(flow);
      flow.phase = 'checking';
      const runEnv = baseEnv();
      const existing = await tokenFrom(gh, runEnv, signal);
      if (existing) {
        const adopted = await adopt(existing, 'existing');
        checkActive(flow);
        if (adopted.ok) {
          release();
          return { status: 'connected', installed, ...adopted };
        }
        // A stale gh login: log the CLI in again below.
      }

      // A normal gh login (default config, system keychain), so the CLI stays signed in.
      flow.phase = 'login';
      let resolveCode;
      let rejectCode;
      const codeReady = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
      codeReady.catch(() => {});
      let seen = '';
      const login = runProcess(spawnImpl, gh, [
        'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key',
      ], {
        // ScaleMax opens the device page itself; gh must not launch a browser.
        runEnv: { ...runEnv, GH_BROWSER: platform === 'darwin' ? '/usr/bin/true' : 'true' },
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal,
        onOutput: (text) => {
          seen = (seen + text).slice(-4096);
          const match = CODE_PATTERN.exec(seen);
          if (match) resolveCode(match[1]);
        },
      });
      flow.done = (async () => {
        try {
          const result = await login;
          if (result.code !== 0) {
            throw new CliAuthError('The GitHub CLI login did not complete. Try again.');
          }
          const token = await tokenFrom(gh, runEnv, signal);
          if (!token) throw new CliAuthError('The GitHub CLI did not return a token.');
          const adopted = await adopt(token, 'login');
          if (!adopted.ok) throw new CliAuthError(adopted.message, 'TOKEN_REJECTED');
          return { status: 'connected', installed, ...adopted };
        } finally {
          release();
        }
      })();
      flow.done.catch(() => {});
      // No code means gh failed early.
      login.then(() => rejectCode(new CliAuthError('The GitHub CLI exited before showing a sign-in code. Update gh and try again.')),
        (error) => rejectCode(error));
      const timer = setTimeout(() => rejectCode(new CliAuthError('The GitHub CLI did not show a sign-in code.', 'TIMEOUT')),
        CODE_TIMEOUT_MS);
      timer.unref?.();
      let code;
      try {
        code = await codeReady;
      } finally {
        clearTimeout(timer);
      }
      flow.phase = 'approve';
      try { clipboard?.writeText?.(code); } catch { /* copying is a convenience */ }
      try {
        await openExternal(DEVICE_URL);
      } catch { /* the user can open the page from the card */ }
      return { status: 'code', code, verificationUri: DEVICE_URL, copied: Boolean(clipboard?.writeText), installed };
    } catch (error) {
      const cancelled = signal.aborted;
      flow.controller.abort();
      release();
      if (cancelled) throw cancelledError();
      throw error instanceof CliAuthError ? error : new CliAuthError('GitHub sign-in failed.');
    }
  }

  /** Resolves once the pending browser approval finished and the token was stored. */
  async function wait(input) {
    requireGithub(input);
    if (!pending?.done) throw new CliAuthError('No GitHub sign-in is in progress.', 'NOT_PENDING');
    return pending.done;
  }

  function cancel(input) {
    requireGithub(input);
    if (!pending) return { cancelled: false };
    const flow = pending;
    pending = null;
    flow.controller.abort();
    return { cancelled: true };
  }

  function closeAll() {
    if (pending) cancel({ id: 'github' });
  }

  return { available, status, start, wait, cancel, closeAll };
}

module.exports = { createCliConnect, verifyGithubSignature, CliAuthError, GITHUB_MCP_URL, DEVICE_URL, GITHUB_TEAM_ID };
