'use strict';
// Background commands ("jobs") the model starts in a project folder: a dev server, a watcher, a
// long build. A job keeps running after the reply that started it, until it ends, the model or
// the user stops it, or ScaleMax quits. It keeps the last MAX_OUTPUT characters of its output;
// readers (the model, the window) read from offsets into it, so each sees what is new to it.
// Jobs run in their own process group, in the sandbox when the policy says so (lib/commands.cjs).
const childProcess = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { commandLine, cleanOutput } = require('./commands.cjs');

const MAX_RUNNING = 8;
// Finished jobs kept (with their output) for the model and the window to look at.
const MAX_FINISHED = 20;
const MAX_OUTPUT = 1024 * 1024;
const MAX_COMMAND = 4000;
const MAX_INPUT = 64 * 1024;
// A stop asks politely first (dev servers clean up on SIGTERM), then ends the group.
const STOP_GRACE_MS = 2000;
// The start of a terminal code at the very end of the output, not complete yet.
const INCOMPLETE_CODE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[()])?$/;

class JobError extends Error {
  constructor(message, code = 'JOB_ERROR') {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

/**
 * @param {object} [options]
 * @param {(job: object) => void} [options.onUpdate] a job started, printed output, or ended
 * @param {() => object} [options.environment] environment variables for jobs
 */
function createJobManager({ spawnImpl = childProcess.spawn, now = () => Date.now(), onUpdate = null,
  environment = () => ({ PATH: process.env.PATH || '/usr/bin:/bin' }), platform = process.platform } = {}) {
  const jobs = new Map();
  let sequence = 0;
  const tell = (job) => {
    if (typeof onUpdate !== 'function') return;
    try { onUpdate(view(job)); } catch { /* listeners never stop a job */ }
  };
  // What callers see of a job (never the process itself).
  function view(job) {
    return {
      id: job.id, root: job.root, folderName: job.folderName, command: job.command, tty: job.tty,
      sandboxed: job.sandboxed, network: job.network, status: job.status, exitCode: job.exitCode,
      signal: job.signal, startedAt: job.startedAt, endedAt: job.endedAt, outputChars: job.end,
    };
  }
  function running() {
    return [...jobs.values()].filter((job) => job.status === 'running');
  }
  // Finished jobs past the limit go, oldest first.
  function forgetOld() {
    const finished = [...jobs.values()].filter((job) => job.status !== 'running').sort((a, b) => a.endedAt - b.endedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) jobs.delete(job.id);
  }
  function append(job, text) {
    if (!text) return;
    job.output += text;
    job.end += text.length;
    if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(job.output.length - MAX_OUTPUT);
    job.start = job.end - job.output.length;
    for (const resolve of job.waiters.splice(0)) resolve();
    tell(job);
  }
  function kill(job, signal) {
    try {
      if (platform !== 'win32' && Number.isInteger(job.child?.pid)) process.kill(-job.child.pid, signal);
      else job.child?.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        try { job.child?.kill(signal); } catch { /* already gone */ }
      }
    }
  }
  function finish(job, code, signal) {
    if (job.status !== 'running') return;
    job.status = job.stopRequested ? 'stopped' : code === 0 ? 'exited' : 'failed';
    job.exitCode = Number.isInteger(code) ? code : null;
    job.signal = typeof signal === 'string' ? signal : null;
    job.endedAt = now();
    clearTimeout(job.killTimer);
    // Anything the command left behind in its group (a server it forked, the terminal's input
    // side) ends with it.
    kill(job, 'SIGKILL');
    try { job.child.stdin?.end(); } catch { /* closed */ }
    for (const resolve of job.waiters.splice(0)) resolve();
    tell(job);
    forgetOld();
  }

  /**
   * Starts a job.
   * @param {{ root: string, folderName?: string, command: string, tty?: boolean,
   *   box?: {project: string, network: boolean, appData: string}|null }} request
   */
  function start({ root, folderName = '', command, tty = false, box = null } = {}) {
    if (typeof root !== 'string' || !root) throw new JobError('A job needs its project folder.', 'INVALID_JOB');
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND || command.includes('\0')) {
      throw new JobError(`Give a command line of at most ${MAX_COMMAND} characters.`, 'INVALID_COMMAND');
    }
    if (running().length >= MAX_RUNNING) {
      throw new JobError(`At most ${MAX_RUNNING} background commands can run at once. Stop one first.`, 'TOO_MANY_JOBS');
    }
    sequence += 1;
    const job = {
      id: `j${sequence}`, root, folderName, command, tty: Boolean(tty), sandboxed: Boolean(box), network: box ? box.network !== false : true,
      status: 'running', exitCode: null, signal: null, startedAt: now(), endedAt: null,
      output: '', start: 0, end: 0, waiters: [], child: null, killTimer: null, stopRequested: false,
    };
    const { file, args } = commandLine(command, { tty, box, platform });
    const env = { ...environment(), TERM: tty ? 'xterm-256color' : 'dumb' };
    let child;
    try {
      child = spawnImpl(file, args, { cwd: root, env, shell: false, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      throw new JobError(`The command could not be started: ${error.message}`, 'COMMAND_FAILED');
    }
    job.child = child;
    jobs.set(job.id, job);
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout?.on('data', (chunk) => append(job, decoders[0].write(chunk)));
    child.stderr?.on('data', (chunk) => append(job, decoders[1].write(chunk)));
    child.stdin?.on('error', () => { /* the command closed its input */ });
    child.on('error', (error) => {
      append(job, `\n[ScaleMax: the command could not run: ${error.message}]\n`);
      finish(job, null, null);
    });
    // 'exit' rather than 'close': a program the command started in the background may keep the
    // output open after the command itself ended.
    child.on('exit', (code, signal) => {
      append(job, decoders[0].end() + decoders[1].end());
      finish(job, code, signal);
    });
    tell(job);
    return view(job);
  }

  function find(id, root) {
    const job = typeof id === 'string' ? jobs.get(id.trim()) : undefined;
    if (!job || (root !== undefined && job.root !== root)) {
      throw new JobError(`There is no background command "${String(id).slice(0, 40)}" in this folder. List them with workspace_jobs.`, 'NO_JOB');
    }
    return job;
  }

  /** Jobs, running first then newest first; only those of `root` when given. */
  function list(root) {
    return [...jobs.values()].filter((job) => root === undefined || job.root === root)
      .sort((a, b) => (a.status === 'running') - (b.status === 'running') || a.startedAt - b.startedAt).reverse().map(view);
  }

  /**
   * Output from character offset `from` (default: all that is kept), as plain text (terminal
   * codes removed). `dropped` counts characters that were no longer kept; `to` is where the next
   * read starts. `complete` is the part up to the last line break and `partial` the line still
   * being written, which starts at `lineStart`: a reader that reads again from there sees that
   * line as it ends up (a progress bar, a prompt) instead of each redraw of it.
   */
  function read(id, { from = 0, root, maxChars = MAX_OUTPUT } = {}) {
    const job = find(id, root);
    const asked = Number.isSafeInteger(from) && from >= 0 ? from : 0;
    const begin = Math.max(Math.min(asked, job.end), job.start);
    let raw = job.output.slice(begin - job.start);
    let skipped = 0;
    if (raw.length > maxChars) {
      skipped = raw.length - maxChars;
      raw = raw.slice(skipped);
    }
    // A terminal code still being written waits for the next read.
    if (job.status === 'running') {
      const open = INCOMPLETE_CODE.exec(raw);
      if (open) raw = raw.slice(0, open.index);
    }
    const start = begin + skipped;
    const cut = raw.lastIndexOf('\n') + 1;
    const complete = cleanOutput(raw.slice(0, cut));
    const partial = cleanOutput(raw.slice(cut));
    return {
      ...view(job), text: complete + partial, complete, partial,
      from: start, to: start + raw.length, lineStart: start + cut, dropped: Math.max(0, begin - asked) + skipped,
    };
  }

  /**
   * Resolves when the job prints something after `from` (unless `untilEnd`), ends, `ms` pass, or
   * `signal` aborts.
   */
  function wait(id, { from = 0, ms = 0, root, signal, untilEnd = false } = {}) {
    const job = find(id, root);
    const ready = () => job.status !== 'running' || (!untilEnd && job.end > from);
    if (ready() || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', finish);
        const index = job.waiters.indexOf(check);
        if (index >= 0) job.waiters.splice(index, 1);
        resolve();
      };
      // Waiters are called on every output and at the end; this one waits for its condition.
      function check() {
        if (ready()) finish();
        else job.waiters.push(check);
      }
      timer = setTimeout(finish, ms);
      signal?.addEventListener?.('abort', finish, { once: true });
      job.waiters.push(check);
    });
  }

  /** Types `text` into the job (its standard input, or its terminal). */
  function write(id, text, { root } = {}) {
    const job = find(id, root);
    if (typeof text !== 'string' || text.length > MAX_INPUT) throw new JobError(`Input must be text of at most ${MAX_INPUT} characters.`, 'INVALID_INPUT');
    if (job.status !== 'running' || !job.child?.stdin || job.child.stdin.destroyed) {
      throw new JobError(`Background command ${job.id} is not running any more.`, 'JOB_ENDED');
    }
    job.child.stdin.write(text);
    return view(job);
  }

  /** Stops a job: SIGTERM to its group, SIGKILL after a moment. Resolves when it ended. */
  function stop(id, { root, graceMs = STOP_GRACE_MS } = {}) {
    const job = find(id, root);
    if (job.status !== 'running') return Promise.resolve(view(job));
    job.stopRequested = true;
    kill(job, 'SIGTERM');
    clearTimeout(job.killTimer);
    job.killTimer = setTimeout(() => kill(job, 'SIGKILL'), graceMs);
    job.killTimer.unref?.();
    return new Promise((resolve) => {
      const check = () => (job.status !== 'running' ? resolve(view(job)) : job.waiters.push(check));
      check();
    });
  }

  /** Ends every job at once (ScaleMax quits). */
  function stopAll() {
    for (const job of running()) {
      job.stopRequested = true;
      kill(job, 'SIGKILL');
    }
  }

  return {
    start, list, read, wait, write, stop, stopAll,
    get: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    // Where the model is in each job's output (lib/workspace-tools.cjs), across replies.
    cursors: new Map(),
  };
}

module.exports = { createJobManager, JobError, MAX_RUNNING, MAX_OUTPUT };
