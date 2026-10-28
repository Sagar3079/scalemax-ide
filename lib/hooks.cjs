'use strict';

// Hooks: commands the user sets up to run at fixed points of a reply, configured in
// `.scalemax/settings.json` of a project and of the home folder (~/.scalemax/settings.json):
//   PreToolUse        before a tool call: it can block the call (the reason goes to the model) or
//                     allow it without the usual prompt
//   PostToolUse       after a tool call: what it says is added to the tool result as a note
//   UserPromptSubmit  before a message goes to the model: it can add context or block the message
//   Stop              when a reply has finished
// The settings file:
//   { "hooks": { "PreToolUse": [ { "matcher": "workspace_(write|edit)",
//       "hooks": [ { "type": "command", "command": "./scripts/check.sh", "timeout": 30 } ] } ] } }
// A matcher names tools: exactly, or as a regular expression for the whole name ("*" or none is
// every tool); it is compared with the name the model calls (workspace_write) and the tool's own
// name (write_file).
// A hook is a shell command, run in the project folder with the event as JSON on stdin. Exit 0 is
// fine (stdout may be JSON: { decision: "block" | "allow", reason, additionalContext }), exit 2
// blocks with stderr as the reason, anything else is an error that blocks nothing and shows as a
// failed step.
//
// Hooks are the user's own commands: they run outside the model's sandbox, with the login shell's
// PATH. That is also why a project's hooks (a repository the user cloned, or a file the model
// wrote) never run until the user approved exactly that set of hooks: approvals are kept by the
// hash of the hooks (createHookApprovals), and a changed set is asked about again.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { shellArgv, platformEnvironment } = require('./commands.cjs');
const { DEFAULT_LANG } = require('./shell-path.cjs');

const SERVER_ID = 'Hooks';
const SETTINGS_PATH = '.scalemax/settings.json';
const EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const SCOPES = Object.freeze(['project', 'user']);
const LIMITS = {
  hooks: 64,
  commandChars: 4000,
  matcherChars: 200,
  timeoutSeconds: { default: 30, max: 600 },
  // What a hook prints is kept up to this much per stream.
  outputBytes: 64 * 1024,
  reasonChars: 2000,
  contextBytes: 16 * 1024,
  // A tool's result as the PostToolUse hook gets it on stdin.
  resultBytes: 64 * 1024,
  stepOutputBytes: 4 * 1024,
  // A process group that ignores SIGTERM gets SIGKILL this much later.
  killGraceMs: 1000,
  // After the hook ended, how long its output may still take to arrive.
  exitGraceMs: 200,
  approvedFolders: 200,
  disabledHooks: 500,
};
// Environment a hook gets: the user's own (it is their command), but only what a shell command
// needs; never the API keys of a developer's shell that started ScaleMax.
const ENVIRONMENT_KEYS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK'];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncateChars(value, max) {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

// The start of a text, at most `maxBytes` of UTF-8, cut at a character boundary.
function headBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

// The end of a text, at most `maxBytes` of UTF-8.
function tailBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function oneLine(text, chars) {
  return truncateChars(String(text ?? '').replace(/\s+/g, ' ').trim(), chars);
}

// ---- The settings file ---------------------------------------------------------------------

/**
 * The hooks of one settings file: { hooks: [{ event, matcher, command, timeout }], errors }.
 * Anything malformed is left out and named in `errors`; the rest still counts.
 */
function parseHooks(text) {
  const hooks = [];
  const errors = [];
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { hooks, errors: [`${SETTINGS_PATH} is not valid JSON (${oneLine(error.message, 120)}).`] };
  }
  if (!isRecord(data)) return { hooks, errors: [`${SETTINGS_PATH} must hold a JSON object.`] };
  if (data.hooks === undefined) return { hooks, errors };
  if (!isRecord(data.hooks)) return { hooks, errors: ['"hooks" must be an object with one list per event.'] };
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!EVENTS.includes(event)) {
      errors.push(`Unknown hook event "${oneLine(event, 40)}" (use ${EVENTS.join(', ')}).`);
      continue;
    }
    if (!Array.isArray(groups)) {
      errors.push(`"${event}" must be a list.`);
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        errors.push(`Every "${event}" entry needs a "hooks" list.`);
        continue;
      }
      const matcher = group.matcher === undefined || group.matcher === null ? '' : group.matcher;
      if (typeof matcher !== 'string' || matcher.length > LIMITS.matcherChars) {
        errors.push(`A "${event}" matcher must be text of at most ${LIMITS.matcherChars} characters.`);
        continue;
      }
      for (const hook of group.hooks) {
        if (hooks.length >= LIMITS.hooks) {
          errors.push(`Only the first ${LIMITS.hooks} hooks are used.`);
          return { hooks, errors };
        }
        if (!isRecord(hook) || (hook.type !== undefined && hook.type !== 'command')) {
          errors.push(`A "${event}" hook must be { "type": "command", "command": "…" }.`);
          continue;
        }
        if (typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > LIMITS.commandChars || hook.command.includes('\0')) {
          errors.push(`A "${event}" hook needs a command of at most ${LIMITS.commandChars} characters.`);
          continue;
        }
        let timeout = LIMITS.timeoutSeconds.default;
        if (hook.timeout !== undefined) {
          if (!Number.isFinite(hook.timeout) || hook.timeout < 1 || hook.timeout > LIMITS.timeoutSeconds.max) {
            errors.push(`A "${event}" hook timeout must be 1 to ${LIMITS.timeoutSeconds.max} seconds; ${LIMITS.timeoutSeconds.default} is used.`);
          } else {
            timeout = Math.round(hook.timeout);
          }
        }
        hooks.push({ event, matcher: TOOL_EVENTS.has(event) ? matcher.trim() : '', command: hook.command, timeout });
      }
    }
  }
  return { hooks, errors };
}

/** What the user approves: exactly these hooks, in this order (lowercase hex SHA-256). */
function hooksHash(hooks) {
  const canonical = (Array.isArray(hooks) ? hooks : []).map((hook) => [hook.event, hook.matcher, hook.command, hook.timeout]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** A stable id for one hook, for its enable switch: its scope, folder, event, matcher and command. */
function hookId(scope, folder, hook) {
  const key = [scope, scope === 'project' ? folder || '' : '', hook.event, hook.matcher, hook.command].join('\0');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * True when `matcher` names one of `names`: "" and "*" name every tool, otherwise the matcher is
 * the exact name or a regular expression for the whole name. A matcher that is not a valid
 * regular expression only matches exactly.
 */
function toolMatches(matcher, names) {
  const list = (Array.isArray(names) ? names : [names]).filter((name) => typeof name === 'string' && name);
  if (typeof matcher !== 'string' || !matcher.trim() || matcher.trim() === '*') return true;
  const wanted = matcher.trim();
  if (list.includes(wanted)) return true;
  let pattern;
  try {
    pattern = new RegExp(`^(?:${wanted})$`);
  } catch {
    return false;
  }
  return list.some((name) => pattern.test(name));
}

/**
 * Reads the hooks of one settings file through a workspace session (lib/workspace.cjs) whose
 * folder holds `.scalemax/settings.json`, so the usual guards apply: no links, text only, 1 MiB.
 * @returns {Promise<{ exists: boolean, hooks: object[], errors: string[] }>}
 */
async function readHooks(workspace) {
  if (!workspace || typeof workspace.read !== 'function' || !workspace.current?.()) return { exists: false, hooks: [], errors: [] };
  let file;
  try {
    file = await workspace.read(SETTINGS_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'NOT_DIRECTORY' || error?.code === 'ENOTDIR') return { exists: false, hooks: [], errors: [] };
    return { exists: true, hooks: [], errors: [`${SETTINGS_PATH} could not be read: ${oneLine(error?.message || 'unknown error', 160)}`] };
  }
  return { exists: true, ...parseHooks(file.content) };
}

/**
 * The hooks of a project folder and of the user, as scopes: { scope, file, exists, hooks (each
 * with its id and scope), hash, errors }. `project` and `user` are workspace sessions on the
 * project folder and on the home folder; the project scope is left out when the project is the
 * home folder itself (those are the user's own hooks).
 */
async function loadScopes({ project = null, user = null } = {}) {
  const folder = project?.current?.()?.path || '';
  const home = user?.current?.()?.path || '';
  const scopes = [];
  for (const [scope, workspace, root] of [['project', folder && folder !== home ? project : null, folder], ['user', user, home]]) {
    if (scope === 'project' && !workspace) continue;
    const read = await readHooks(workspace);
    const hooks = read.hooks.map((hook) => ({ ...hook, scope, id: hookId(scope, folder, hook) }));
    scopes.push({
      scope,
      file: scope === 'user' ? `~/${SETTINGS_PATH}` : SETTINGS_PATH,
      ...(root ? { root } : {}),
      exists: read.exists,
      hooks,
      hash: hooksHash(read.hooks),
      errors: read.errors,
    });
  }
  return scopes;
}

// ---- Approvals and switches --------------------------------------------------------------

/**
 * What the user decided about hooks, kept by main in its own state (never the renderer's):
 * { approved: { [project folder]: hash of the approved hooks }, disabled: [hook ids] }.
 * A project's hooks run only while their hash is the approved one; the user's own hooks need no
 * approval. Any hook can be switched off.
 * @param {{ read: () => object|undefined, write: (value: object) => void }} store
 */
function createHookApprovals({ read, write } = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') throw new TypeError('Hook approvals need read and write.');
  function state() {
    let value;
    try { value = read(); } catch { value = null; }
    const approved = {};
    if (isRecord(value?.approved)) {
      for (const [folder, hash] of Object.entries(value.approved)) {
        if (path.isAbsolute(folder) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) approved[folder] = hash;
      }
    }
    const disabled = Array.isArray(value?.disabled) ? [...new Set(value.disabled.filter((id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)))] : [];
    return { approved, disabled };
  }
  function save(next) {
    const folders = Object.entries(next.approved);
    write({
      approved: Object.fromEntries(folders.slice(Math.max(0, folders.length - LIMITS.approvedFolders))),
      disabled: next.disabled.slice(-LIMITS.disabledHooks),
    });
  }
  /** Approves exactly the hooks with `hash` in `folder` (the newest approval last). */
  function approve(folder, hash) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw fail('INVALID_FOLDER', 'Choose the project folder whose hooks to allow.');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw fail('INVALID_HOOKS', 'Those hooks are not valid.');
    const next = state();
    delete next.approved[folder];
    next.approved[folder] = hash;
    save(next);
  }
  function revoke(folder) {
    const next = state();
    if (!Object.hasOwn(next.approved, folder)) return false;
    delete next.approved[folder];
    save(next);
    return true;
  }
  function setEnabled(id, enabled) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw fail('INVALID_HOOK', 'Choose a hook.');
    const next = state();
    next.disabled = next.disabled.filter((item) => item !== id);
    if (!enabled) next.disabled.push(id);
    save(next);
    return { id, enabled: Boolean(enabled) };
  }
  /** The scopes as the window shows them: approved / pending per scope, enabled per hook. */
  function view(scopes) {
    const { approved, disabled } = state();
    return (Array.isArray(scopes) ? scopes : []).map((scope) => {
      const ok = scope.scope === 'user' || (Boolean(scope.root) && approved[scope.root] === scope.hash);
      return {
        scope: scope.scope,
        file: scope.file,
        exists: scope.exists,
        hash: scope.hash,
        approved: ok,
        // Hooks are there and have not been allowed in this exact form.
        pending: !ok && scope.hooks.length > 0,
        errors: scope.errors.slice(0, 20),
        hooks: scope.hooks.map((hook) => ({
          id: hook.id, event: hook.event, matcher: hook.matcher, command: hook.command, timeout: hook.timeout,
          enabled: !disabled.includes(hook.id),
        })),
      };
    });
  }
  /** The hooks that may run: switched on, and for a project approved in exactly this form. */
  function active(scopes) {
    const { approved, disabled } = state();
    const hooks = [];
    for (const scope of Array.isArray(scopes) ? scopes : []) {
      if (scope.scope === 'project' && !(scope.root && approved[scope.root] === scope.hash)) continue;
      for (const hook of scope.hooks) if (!disabled.includes(hook.id)) hooks.push(hook);
    }
    return hooks;
  }
  return { state, approve, revoke, setEnabled, view, active };
}

// ---- Running a hook ------------------------------------------------------------------------

/** The environment a hook runs with (see ENVIRONMENT_KEYS), plus where and why it runs. */
function hookEnvironment({ env = process.env, folder = '', home = os.homedir(), event = '' } = {}) {
  const result = {};
  for (const key of ENVIRONMENT_KEYS) if (typeof env[key] === 'string') result[key] = env[key];
  Object.assign(result, platformEnvironment({ env }));
  if (!result.HOME) result.HOME = home;
  if (!result.PATH) result.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  if (!result.LANG) result.LANG = DEFAULT_LANG;
  if (folder) result.SCALEMAX_PROJECT_DIR = folder;
  if (event) result.SCALEMAX_HOOK_EVENT = event;
  return result;
}

/**
 * Runs one hook command: `input` goes to its stdin as JSON, its output is collected (bounded), and
 * it is stopped (its whole process group) at its time limit or when `signal` aborts.
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, error: string, ms: number }>}
 */
function runHook(hook, input, { cwd, env = hookEnvironment(), signal = null, spawnImpl = childProcess.spawn, platform = process.platform, now = Date.now } = {}) {
  const started = now();
  const timeoutMs = Math.max(1, Number.isFinite(hook?.timeout) ? hook.timeout : LIMITS.timeoutSeconds.default) * 1000;
  return new Promise((resolve) => {
    const streams = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let child = null;
    let finished = false;
    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    let lastResort = null;
    let exitTimer = null;
    const finish = (code, exitSignal, error = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(lastResort);
      clearTimeout(exitTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        code: Number.isInteger(code) ? code : null,
        signal: typeof exitSignal === 'string' ? exitSignal : null,
        stdout: Buffer.concat(streams.stdout).toString('utf8'),
        stderr: Buffer.concat(streams.stderr).toString('utf8'),
        timedOut, aborted, error, ms: Math.max(0, now() - started),
      });
    };
    // The hook and everything it started (its own process group): SIGTERM, then SIGKILL.
    const kill = (sig) => {
      if (!child || !Number.isInteger(child.pid)) return;
      try {
        if (platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    const stop = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), LIMITS.killGraceMs);
      // A process that never reports closing (it should) does not hold the reply.
      lastResort = setTimeout(() => finish(null, 'SIGKILL'), LIMITS.killGraceMs + 2000);
    };
    const onAbort = () => {
      if (finished || aborted) return;
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal?.aborted) {
      aborted = true;
      finish(null, null, 'Stopped before it started.');
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const argv = shellArgv(hook.command, { tty: false, platform });
    try {
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd, env, shell: false, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        windowsVerbatimArguments: platform === 'win32',
      });
    } catch (error) {
      finish(null, null, `Unable to start the hook: ${oneLine(error?.message, 200)}`);
      return;
    }
    const collect = (name) => (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = LIMITS.outputBytes - sizes[name];
      if (room <= 0) return;
      const kept = bytes.subarray(0, room);
      streams[name].push(kept);
      sizes[name] += kept.length;
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', (error) => finish(null, null, `Unable to start the hook: ${oneLine(error?.message, 200)}`));
    child.on('close', (code, exitSignal) => finish(code, exitSignal));
    // Something the hook left running in the background may keep its output open: once the hook
    // itself has ended, what it printed is in after a moment, and the reply goes on.
    child.on('exit', (code, exitSignal) => {
      exitTimer = setTimeout(() => finish(code, exitSignal), LIMITS.exitGraceMs);
    });
    // A hook that does not read its input may close stdin first: that is not an error.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(JSON.stringify(input));
    } catch { /* the hook ended already */ }
  });
}

/** A JSON object printed on stdout, or null (plain text, or nothing). */
function jsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What a finished hook means for its event:
 *   { status: 'ok' | 'allowed' | 'blocked' | 'failed' | 'timed out' | 'stopped',
 *     block, allow, reason, context, note }
 * Only PreToolUse and UserPromptSubmit can block; PreToolUse alone can allow. For PostToolUse
 * what the hook says (a reason, additional context, or plain output) becomes `note`; for
 * UserPromptSubmit it becomes `context`.
 */
function decide(event, result) {
  const outcome = { status: 'ok', block: false, allow: false, reason: '', context: '', note: '' };
  if (result.aborted) return { ...outcome, status: 'stopped' };
  if (result.timedOut) return { ...outcome, status: 'timed out' };
  if (result.error) return { ...outcome, status: 'failed', reason: result.error };
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  if (result.code === 2) {
    const reason = truncateChars(stderr || stdout || 'A hook blocked this.', LIMITS.reasonChars);
    if (event === 'PostToolUse') return { ...outcome, status: 'blocked', note: reason };
    if (event === 'Stop') return { ...outcome, status: 'blocked', reason };
    return { ...outcome, status: 'blocked', block: true, reason };
  }
  if (result.code !== 0) {
    return { ...outcome, status: 'failed', reason: truncateChars(stderr || stdout || `It ended with ${result.code === null ? `signal ${result.signal || 'unknown'}` : `exit code ${result.code}`}.`, LIMITS.reasonChars) };
  }
  const json = jsonOutput(stdout);
  const specific = isRecord(json?.hookSpecificOutput) ? json.hookSpecificOutput : {};
  const decision = typeof json?.decision === 'string' ? json.decision.toLowerCase()
    : typeof specific.permissionDecision === 'string' ? ({ deny: 'block', allow: 'allow' })[specific.permissionDecision.toLowerCase()] || '' : '';
  const reason = typeof json?.reason === 'string' ? json.reason
    : typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : '';
  const extra = typeof json?.additionalContext === 'string' ? json.additionalContext
    : typeof specific.additionalContext === 'string' ? specific.additionalContext : '';
  const said = headBytes((json ? [reason, extra].filter(Boolean).join('\n') : stdout).trim(), LIMITS.contextBytes);
  if (decision === 'block' && (event === 'PreToolUse' || event === 'UserPromptSubmit')) {
    return { ...outcome, status: 'blocked', block: true, reason: truncateChars(reason.trim() || 'A hook blocked this.', LIMITS.reasonChars) };
  }
  if (event === 'PreToolUse' && (decision === 'allow' || decision === 'approve')) return { ...outcome, status: 'allowed', allow: true };
  if (event === 'PostToolUse') return { ...outcome, status: decision === 'block' ? 'blocked' : 'ok', note: said };
  if (event === 'UserPromptSubmit') return { ...outcome, context: headBytes((json ? extra : stdout).trim(), LIMITS.contextBytes) };
  return outcome;
}

function seconds(ms) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** The step a hook run leaves in the reply: "PreToolUse hook: ./check.sh (blocked, 0.2s)". */
function hookStep(hook, verdict, result) {
  const label = oneLine(hook.command, 60);
  const step = {
    type: 'tool',
    title: `${hook.event} hook: ${label} (${verdict.status}, ${seconds(result.ms)})`,
    server: SERVER_ID,
    tool: hook.event,
    ok: verdict.status === 'ok' || verdict.status === 'allowed',
  };
  // Blocking is what the hook is for: the window shows it apart from a hook that failed.
  if (verdict.status === 'blocked') step.outcome = 'blocked';
  const preview = oneLine(verdict.reason || verdict.note || verdict.context || result.stderr || result.stdout, 200);
  if (preview) step.preview = preview;
  const output = [String(result.stdout || '').trim(), String(result.stderr || '').trim()].filter(Boolean).join('\n');
  if (output) step.output = tailBytes(output, LIMITS.stepOutputBytes);
  return step;
}

/** The names a tool event's matchers are compared with. */
function toolNames(details) {
  return [details?.name, details?.toolName].filter((name) => typeof name === 'string' && name);
}

/** The JSON a hook reads on stdin. */
function hookInput(event, details, base) {
  const input = { hook_event_name: event, ...base };
  if (TOOL_EVENTS.has(event)) {
    input.tool_name = typeof details.name === 'string' ? details.name : '';
    input.tool_input = isRecord(details.input) ? details.input : {};
    if (typeof details.serverId === 'string') input.server = details.serverId;
    if (typeof details.toolName === 'string') input.tool = details.toolName;
  }
  if (event === 'PostToolUse') {
    input.tool_response = headBytes(typeof details.output === 'string' ? details.output : '', LIMITS.resultBytes);
    input.tool_ok = details.ok !== false;
  }
  if (event === 'UserPromptSubmit') input.prompt = typeof details.prompt === 'string' ? details.prompt : '';
  if (event === 'Stop') input.reply = headBytes(typeof details.text === 'string' ? details.text : '', LIMITS.resultBytes);
  return input;
}

/**
 * The hooks of one reply, ready to run (lib/tool-loop.cjs runs PreToolUse, PostToolUse and Stop;
 * main runs UserPromptSubmit).
 * @param {object} options
 * @param {object[]} options.hooks the hooks that may run (createHookApprovals().active())
 * @param {string} options.cwd where they run (the project folder, else the home folder)
 * @param {object} [options.base] what every hook reads on stdin besides the event: cwd, folder, task_id, request_id
 * @returns {{ count: number, has(event, details?): boolean, run(event, details, context): Promise<object> }}
 *   run() resolves to { block, allow, reason, context, note, steps }: the first hook that blocks
 *   ends the run; steps are the reply's steps for the runs (reported live through context.report).
 */
function createHookSet({ hooks = [], cwd = os.homedir(), env = null, base = {}, spawnImpl = childProcess.spawn, platform = process.platform, now = Date.now } = {}) {
  const list = (Array.isArray(hooks) ? hooks : []).filter((hook) => isRecord(hook) && EVENTS.includes(hook.event) && typeof hook.command === 'string' && hook.command.trim());
  let runs = 0;
  function matching(event, details) {
    return list.filter((hook) => hook.event === event && (!TOOL_EVENTS.has(event) || toolMatches(hook.matcher, toolNames(details))));
  }
  async function run(event, details = {}, { signal = null, report = null, nextCallId = null } = {}) {
    const result = { block: false, allow: false, reason: '', context: '', note: '', steps: [] };
    const contexts = [];
    const notes = [];
    for (const hook of matching(event, isRecord(details) ? details : {})) {
      if (signal?.aborted) break;
      const callId = typeof nextCallId === 'function' ? nextCallId() : `hook-${(runs += 1)}`;
      const tell = (progress) => {
        if (typeof report !== 'function') return;
        try { report(progress); } catch { /* observers never stop a hook */ }
      };
      tell({ phase: 'tool', callId, title: `${hook.event} hook: ${oneLine(hook.command, 60)}`, serverId: SERVER_ID, toolName: hook.event });
      const environment = { ...(env || hookEnvironment({ folder: base.folder || '' })), SCALEMAX_HOOK_EVENT: hook.event };
      const ran = await runHook(hook, hookInput(event, details, base), { cwd, env: environment, signal, spawnImpl, platform, now });
      const verdict = decide(event, ran);
      const step = hookStep(hook, verdict, ran);
      if (step.output) tell({ phase: 'tool-output', callId, text: step.output });
      tell({ phase: 'tool', callId, title: step.title, serverId: SERVER_ID, toolName: hook.event });
      tell({ phase: 'tool-done', callId, ok: step.ok, ...(step.outcome ? { outcome: step.outcome } : {}) });
      result.steps.push(step);
      if (verdict.context) contexts.push(verdict.context);
      if (verdict.note) notes.push(verdict.note);
      if (verdict.block) {
        result.block = true;
        result.reason = verdict.reason;
        // Which hook it was, for the step of the call it blocked (lib/tool-loop.cjs).
        result.hook = oneLine(hook.command, 60);
        break;
      }
      if (verdict.allow) result.allow = true;
    }
    if (result.block) result.allow = false;
    result.context = headBytes(contexts.join('\n\n'), LIMITS.contextBytes);
    result.note = headBytes(notes.join('\n\n'), LIMITS.contextBytes);
    return result;
  }
  return { count: list.length, has: (event, details) => matching(event, isRecord(details) ? details : {}).length > 0, run };
}

/** The request with what UserPromptSubmit hooks added following the user's newest message. */
function withPromptContext(input, context) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const last = messages[messages.length - 1];
  if (!context || !last || last.role !== 'user' || typeof last.content !== 'string') return input;
  const content = `${last.content}\n\n[Context from a UserPromptSubmit hook the user set up]\n${context}`;
  return { ...input, messages: [...messages.slice(0, -1), { ...last, content }] };
}

/** The task id in a chat request id ("chat-<task id>-<time>"), or ''. */
function taskIdOf(requestId) {
  const match = typeof requestId === 'string' ? /^chat-(.+)-\d+$/.exec(requestId) : null;
  return match ? match[1] : '';
}

module.exports = {
  SERVER_ID, SETTINGS_PATH, EVENTS, SCOPES, LIMITS,
  parseHooks, hooksHash, hookId, toolMatches, readHooks, loadScopes, createHookApprovals,
  hookEnvironment, runHook, decide, hookStep, hookInput, createHookSet, withPromptContext, taskIdOf,
};
