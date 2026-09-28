'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { TextDecoder } = require('node:util');

const LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const EXCLUDED = new Set(['node_modules', '.cache', '.npm-cache', 'dist', 'out']);
// Private service and agent-state directories (dot-directories ending in -ai)
// are never exposed to the workspace, alongside credentials and key material.
const SECRET_COMPONENT = /^(?:\.git|\.[a-z0-9-]+-ai|\.ssh|\.aws|\.azure|\.gcloud|\.gnupg|\.docker|\.kube|\.config|\.local|\.secrets?|\.credentials?|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|\.gitconfig|\.git-credentials|\.dockercfg|\.(?:bash|zsh|python|node_repl)_history|\.(?:bashrc|zshrc|zshenv)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'core.pager=cat'];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a, b) {
  return sameFile(a, b) && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function text(bytes) {
  if (bytes.length > LIMIT) throw fail('FILE_TOO_LARGE', 'Files must be at most 1 MiB.');
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail('INVALID_UTF8', 'Only valid UTF-8 text files can be opened.');
  }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(value)) throw fail('BINARY_FILE', 'Binary files are not supported.');
  return value;
}

function sensitive(parts) {
  return parts.some(part => SECRET_COMPONENT.test(part)) || parts.some((part, i) => part.toLowerCase() === '.cache' && parts[i + 1]?.toLowerCase() === 'editor-backups');
}

function relativePath(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw fail('INVALID_PATH', 'Use a project-relative path with forward slashes.');
  }
  if (value === '' && allowEmpty) return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw fail('INVALID_PATH', 'Empty, dot, parent, and alternate-stream path components are not allowed.');
  if (sensitive(parts)) throw fail('SENSITIVE_PATH', 'Access to secret files and private service directories is denied.');
  return parts.join('/');
}

function createWorkspace({ approve = async () => false, getPermission = () => 'ask', io = fs, homeDir = os.homedir(), execFileImpl = childProcess.execFile, spawnImpl = childProcess.spawn } = {}) {
  const fsp = io.promises || io;
  const constants = io.constants || fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  let selected = null;
  let generation = 0;
  let selections = 0;
  let disposed = false;
  let writeBusy = false;
  let active = null;
  const gitChildren = new Set();

  function current() {
    return selected ? { name: path.basename(selected.path), path: selected.path } : null;
  }

  function session() {
    if (disposed) throw fail('DISPOSED', 'This workspace service has been disposed.');
    if (!selected) throw fail('NO_WORKSPACE', 'Choose a project folder first.');
    return selected;
  }

  function assertSession(captured) {
    if (disposed || selected !== captured || captured.generation !== generation) throw fail('SESSION_CHANGED', 'The selected project changed; retry in the current workspace.');
  }

  async function permission() {
    const value = await getPermission();
    if (value === 'readonly' || value === 'read-only') throw fail('READ_ONLY', 'Writes and commands are disabled in read-only mode.');
  }

  // Inspect ancestors as well as the leaf: O_NOFOLLOW alone protects only the leaf.
  async function walkAbsolute(absolute) {
    const base = path.parse(absolute).root;
    let cursor = base;
    let stat = await fsp.lstat(base);
    const parts = absolute.slice(base.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (!stat.isDirectory()) throw fail('NOT_DIRECTORY', 'A path component is not a directory.');
      cursor = path.join(cursor, parts[i]);
      stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) throw fail('SYMLINK', 'Symbolic links are not allowed in workspace paths.');
    }
    return stat;
  }

  // The folder on disk is still the one that was selected (not replaced or redirected).
  async function rootUnchanged(captured) {
    const stat = await walkAbsolute(captured.path);
    if (!stat.isDirectory() || !sameFile(stat, captured.stat) || await fsp.realpath(captured.path) !== captured.path) throw fail('SESSION_CHANGED', 'The selected project directory was replaced or redirected.');
  }

  async function verifyRoot(captured) {
    assertSession(captured);
    await rootUnchanged(captured);
    assertSession(captured);
  }

  async function resolve(captured, relative, { empty = false, missing = false } = {}) {
    relative = relativePath(relative, empty);
    await verifyRoot(captured);
    let absolute = captured.path;
    let stat = captured.stat;
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      if (!stat.isDirectory()) throw fail('NOT_DIRECTORY', 'A path component is not a directory.');
      absolute = path.join(absolute, parts[i]);
      try {
        stat = await fsp.lstat(absolute);
      } catch (error) {
        if (missing && error.code === 'ENOENT') {
          assertSession(captured);
          return { absolute: path.join(captured.path, ...parts), stat: null, relative };
        }
        throw error;
      }
      if (stat.isSymbolicLink()) throw fail('SYMLINK', 'Symbolic links are not allowed in workspace paths.');
    }
    if (await fsp.realpath(absolute) !== absolute) throw fail('SYMLINK', 'The path resolves outside its canonical location.');
    assertSession(captured);
    return { absolute, stat, relative };
  }

  function regular(stat) {
    if (!stat.isFile()) throw fail('NOT_FILE', 'Only existing regular files are supported.');
    if (stat.nlink !== 1) throw fail('HARDLINK', 'Hard-linked files are not supported.');
    if (stat.size > LIMIT) throw fail('FILE_TOO_LARGE', 'Files must be at most 1 MiB.');
  }

  async function snapshot(captured, relative) {
    const entry = await resolve(captured, relative);
    regular(entry.stat);
    const handle = await fsp.open(entry.absolute, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK || 0));
    try {
      const before = await handle.stat();
      regular(before);
      if (!sameVersion(before, entry.stat)) throw fail('CONFLICT', 'The file changed while it was being opened.');
      const buffer = Buffer.alloc(LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const content = text(bytes);
      const after = await handle.stat();
      const checked = await resolve(captured, relative);
      if (!sameVersion(before, after) || !sameVersion(after, checked.stat) || after.size !== length) throw fail('CONFLICT', 'The file changed while it was being read.');
      return { ...entry, stat: after, bytes, content, revision: hash(bytes) };
    } finally {
      await handle.close();
    }
  }

  function killTree(child) {
    if (!child) return;
    try {
      if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        try { child.kill('SIGKILL'); } catch { /* The process may already have exited. */ }
      }
    }
  }

  function cancel() {
    const job = active;
    if (!job || job.cancelled) return false;
    job.cancelled = true;
    job.notifyCancel();
    if (job.stop) job.stop(fail('COMMAND_CANCELLED', 'Command cancelled.'));
    else if (active === job) active = null;
    return true;
  }

  function invalidate() {
    generation++;
    selected = null;
    cancel();
    for (const child of gitChildren) {
      try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }
  }

  // The open folder stays open until the new one passes every check, so a refused or vanished
  // folder never leaves the app without one. The newest call wins. Any folder can be opened
  // (home, Desktop, Documents and Downloads included); only private service folders such as
  // ~/.ssh are refused, and secret files stay hidden inside every folder.
  async function select(root) {
    if (disposed) throw fail('DISPOSED', 'This workspace service has been disposed.');
    const token = ++selections;
    if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root) || root.startsWith('//') || root.startsWith('\\\\')) throw fail('INVALID_ROOT', 'Choose an absolute local project directory.');
    const parts = root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean);
    if (parts.some(part => part === '.' || part === '..') || sensitive(parts)) throw fail('INVALID_ROOT', 'Choose a project directory outside private or redirected paths.');
    const absolute = path.resolve(root);
    const stat = await walkAbsolute(absolute);
    if (!stat.isDirectory()) throw fail('NOT_DIRECTORY', 'The selected project must be a directory.');
    const canonical = await fsp.realpath(absolute);
    if (canonical !== absolute) throw fail('SYMLINK', 'Choose the canonical project folder, not a symbolic link or alias.');
    const finalStat = await walkAbsolute(canonical);
    if (!sameFile(stat, finalStat)) throw fail('SESSION_CHANGED', 'The project directory changed during selection.');
    if (disposed || selections !== token) throw fail('SESSION_CHANGED', 'A newer project selection superseded this request.');
    invalidate();
    selected = { path: canonical, stat: finalStat, generation };
    return current();
  }

  async function list(relative = '') {
    const captured = session();
    const entry = await resolve(captured, relative, { empty: true });
    if (!entry.stat.isDirectory()) throw fail('NOT_DIRECTORY', 'Choose a directory to list.');
    const entries = [];
    const directory = await fsp.opendir(entry.absolute);
    try {
      while (entries.length < 1000) {
        const item = await directory.read();
        if (!item) break;
        if (EXCLUDED.has(item.name.toLowerCase())) continue;
        const itemPath = relative ? `${relative}/${item.name}` : item.name;
        try { relativePath(itemPath); } catch { continue; }
        if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
        const checked = await resolve(captured, itemPath);
        if (checked.stat.isFile() && checked.stat.nlink !== 1) continue;
        entries.push({ name: item.name, path: itemPath, type: checked.stat.isDirectory() ? 'directory' : 'file' });
      }
    } finally {
      await directory.close();
    }
    await resolve(captured, relative, { empty: true });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    return { path: relative, entries };
  }

  async function read(relative) {
    const item = await snapshot(session(), relative);
    return { path: item.relative, content: item.content, revision: item.revision };
  }

  async function backupDirectory(captured, create) {
    await verifyRoot(captured);
    let absolute = captured.path;
    for (const part of ['.cache', 'editor-backups']) {
      absolute = path.join(absolute, part);
      let stat;
      try { stat = await fsp.lstat(absolute); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        await verifyRoot(captured);
        const parent = await walkAbsolute(path.dirname(absolute));
        if (!parent.isDirectory()) throw fail('NOT_DIRECTORY', 'The backup parent is not a directory.');
        try { await fsp.mkdir(absolute, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        stat = await fsp.lstat(absolute);
      }
      if (stat.isSymbolicLink()) throw fail('SYMLINK', 'The backup directory cannot contain symbolic links.');
      if (!stat.isDirectory()) throw fail('NOT_DIRECTORY', 'The backup path is not a directory.');
      await walkAbsolute(absolute);
    }
    assertSession(captured);
    return absolute;
  }

  async function createExclusive(absolute, bytes, mode) {
    const handle = await fsp.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    let stat;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
      stat = await handle.stat();
    } finally {
      await handle.close();
    }
    return stat;
  }

  async function write(request) {
    const captured = session();
    if (writeBusy) throw fail('WRITE_BUSY', 'Another save is awaiting approval or completing.');
    writeBusy = true;
    let temporary = null;
    try {
      await permission();
      const relative = relativePath(request?.path);
      if (typeof request.content !== 'string') throw fail('INVALID_CONTENT', 'File content must be a string.');
      const bytes = Buffer.from(request.content, 'utf8');
      if (text(bytes) !== request.content) throw fail('INVALID_UTF8', 'Content contains invalid Unicode.');
      if (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.revision)) throw fail('CONFLICT', 'Supply the SHA-256 revision returned by read().');
      const before = await snapshot(captured, relative);
      if (before.revision !== request.revision) throw fail('CONFLICT', 'The file changed; reload it before saving.');
      await backupDirectory(captured, false);
      assertSession(captured);
      const approved = await approve('Save project file', `Overwrite existing file: ${relative}\nProject: ${captured.path}\nFull path: ${before.absolute}\nNew size: ${bytes.length} bytes\nAn exact backup will be saved in .cache/editor-backups.`);
      assertSession(captured);
      if (approved !== true) throw fail('APPROVAL_DENIED', 'File save was not approved.');
      await permission();
      const after = await snapshot(captured, relative);
      if (after.revision !== request.revision || !sameVersion(before.stat, after.stat)) throw fail('CONFLICT', 'The file changed while approval was pending; reload it before saving.');
      const backupRoot = await backupDirectory(captured, true);
      const backup = path.join(backupRoot, `${hash(Buffer.from(relative)).slice(0, 16)}-${crypto.randomUUID()}.bak`);
      await createExclusive(backup, after.bytes, 0o600);
      const checked = await snapshot(captured, relative);
      if (checked.revision !== request.revision || !sameVersion(after.stat, checked.stat)) throw fail('CONFLICT', 'The file changed before saving; no overwrite was performed.');
      const temporaryPath = path.join(path.dirname(after.absolute), `.scalemax-${crypto.randomUUID()}.tmp`);
      await resolve(captured, relative);
      const temporaryStat = await createExclusive(temporaryPath, bytes, after.stat.mode & 0o7777);
      temporary = { path: temporaryPath, stat: temporaryStat };
      await permission();
      const final = await snapshot(captured, relative);
      if (final.revision !== request.revision || !sameVersion(after.stat, final.stat)) throw fail('CONFLICT', 'The file changed immediately before saving; no overwrite was performed.');
      const tempStat = await walkAbsolute(temporary.path);
      if (!sameVersion(tempStat, temporary.stat) || !tempStat.isFile() || tempStat.nlink !== 1) throw fail('CONFLICT', 'The staged save was replaced or modified.');
      await verifyRoot(captured);
      assertSession(captured);
      await fsp.rename(temporary.path, final.absolute);
      temporary = null;
      assertSession(captured);
      return { path: relative, content: request.content, revision: hash(bytes) };
    } finally {
      if (temporary) {
        try {
          // Checked on disk, not against the session: a session disposed mid-save (a stopped
          // reply) must still remove its own staging file.
          await rootUnchanged(captured);
          const stat = await walkAbsolute(temporary.path);
          if (sameFile(stat, temporary.stat) && stat.isFile() && stat.nlink === 1) await fsp.unlink(temporary.path);
        } catch { /* Never remove an unverified path; a failed save may leave its own staging file. */ }
      }
      writeBusy = false;
    }
  }

  // Creates a new text file (never overwrites; use write() with a revision for that). Missing
  // parent folders are created one level at a time, and no path component may be a link.
  async function create(request) {
    const captured = session();
    if (writeBusy) throw fail('WRITE_BUSY', 'Another save is awaiting approval or completing.');
    writeBusy = true;
    try {
      await permission();
      const relative = relativePath(request?.path);
      if (typeof request.content !== 'string') throw fail('INVALID_CONTENT', 'File content must be a string.');
      const bytes = Buffer.from(request.content, 'utf8');
      if (text(bytes) !== request.content) throw fail('INVALID_UTF8', 'Content contains invalid Unicode.');
      const existing = await resolve(captured, relative, { missing: true });
      if (existing.stat) throw fail('EXISTS', 'That file already exists; read it and save it with its revision instead.');
      const approved = await approve('Create project file', `Create new file: ${relative}\nProject: ${captured.path}\nSize: ${bytes.length} bytes`);
      assertSession(captured);
      if (approved !== true) throw fail('APPROVAL_DENIED', 'File creation was not approved.');
      await permission();
      await verifyRoot(captured);
      let absolute = captured.path;
      for (const part of relative.split('/').slice(0, -1)) {
        absolute = path.join(absolute, part);
        let stat;
        try {
          stat = await fsp.lstat(absolute);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          try { await fsp.mkdir(absolute, { mode: 0o755 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
          stat = await fsp.lstat(absolute);
        }
        if (stat.isSymbolicLink()) throw fail('SYMLINK', 'Symbolic links are not allowed in workspace paths.');
        if (!stat.isDirectory()) throw fail('NOT_DIRECTORY', 'A path component is not a directory.');
      }
      const target = await resolve(captured, relative, { missing: true });
      if (target.stat) throw fail('EXISTS', 'That file already exists; read it and save it with its revision instead.');
      try {
        await createExclusive(target.absolute, bytes, 0o644);
      } catch (error) {
        if (error.code === 'EEXIST') throw fail('EXISTS', 'That file already exists; read it and save it with its revision instead.');
        throw error;
      }
      assertSession(captured);
      return { path: relative, content: request.content, revision: hash(bytes) };
    } finally {
      writeBusy = false;
    }
  }

  function environment() {
    const env = { HOME: homeDir, PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' };
    for (const key of ['LANG', 'TMPDIR', 'TERM']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    return env;
  }

  async function git(captured, args) {
    await verifyRoot(captured);
    const env = { ...environment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat', PAGER: 'cat' };
    return new Promise((resolvePromise, reject) => {
      let child;
      let finished = false;
      let total = 0;
      let overflow = false;
      const done = (error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
        finished = true;
        if (child) gitChildren.delete(child);
        try { assertSession(captured); } catch (sessionError) { reject(sessionError); return; }
        stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '');
        if (overflow || stdout.length + stderr.length > LIMIT || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(fail('OUTPUT_LIMIT', 'Git output exceeded 1 MiB; narrow the requested path.')); return; }
        if (error?.code === 'ENOENT') { reject(fail('GIT_UNAVAILABLE', 'Git was not found. Install Git and make it available on PATH.')); return; }
        if (error?.killed || error?.code === 'ETIMEDOUT') { reject(fail('GIT_TIMEOUT', 'Git exceeded its 5-second limit.')); return; }
        if (error && !Number.isInteger(error.code)) { reject(fail('GIT_ERROR', `Unable to run Git: ${error.message}`)); return; }
        resolvePromise({ code: error ? error.code : 0, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      };
      try {
        child = execFileImpl('git', [...GIT_PREFIX, ...args], { cwd: captured.path, env, shell: false, encoding: 'buffer', maxBuffer: LIMIT, timeout: 5000, killSignal: 'SIGKILL', windowsHide: true }, done);
        if (child && !finished) {
          gitChildren.add(child);
          const count = chunk => {
            total += Buffer.byteLength(chunk);
            if (total > LIMIT && !overflow) { overflow = true; child.kill('SIGKILL'); }
          };
          child.stdout?.on('data', count);
          child.stderr?.on('data', count);
        }
      } catch (error) { done(error); }
    });
  }

  function gitSuccess(result) {
    if (result.code !== 0) throw fail('GIT_ERROR', `Git failed (${result.code}): ${result.stderr.trim() || 'No diagnostic was returned.'}`);
    return result.stdout;
  }

  async function repository(captured) {
    await verifyRoot(captured);
    try {
      const metadata = await fsp.lstat(path.join(captured.path, '.git'));
      if (metadata.isSymbolicLink()) throw fail('SYMLINK', 'Git metadata cannot be a symbolic link.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await git(captured, ['rev-parse', '--show-toplevel']);
    if (result.code !== 0 && /fatal: not a git repository(?:\s|\()/i.test(result.stderr)) return false;
    const top = gitSuccess(result).replace(/\r?\n$/, '');
    return top === captured.path;
  }

  function visibleGitPath(value) {
    try { relativePath(value); } catch { return false; }
    return !value.split('/').some(part => EXCLUDED.has(part.toLowerCase()));
  }

  async function gitStatus() {
    const captured = session();
    if (!await repository(captured)) return { isRepo: false, branch: null, files: [] };
    const status = gitSuccess(await git(captured, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']));
    const branchResult = await git(captured, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = branchResult.code === 1 ? '(detached HEAD)' : gitSuccess(branchResult).replace(/\r?\n$/, '');
    const records = status.split('\0');
    const files = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      if (record.length < 4 || record[2] !== ' ') throw fail('GIT_ERROR', 'Git returned malformed status output.');
      const state = record.slice(0, 2);
      const filePath = record.slice(3);
      if (/[RC]/.test(state)) {
        const source = records[++i];
        if (!source) throw fail('GIT_ERROR', 'Git returned an incomplete rename record.');
        if (!visibleGitPath(source)) continue;
      }
      const candidate = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
      if (visibleGitPath(candidate)) files.push({ status: state, path: candidate });
    }
    assertSession(captured);
    return { isRepo: true, branch, files };
  }

  async function gitDiff(relative = '') {
    const captured = session();
    relative = relativePath(relative, true);
    await resolve(captured, relative, { empty: true, missing: true });
    if (!await repository(captured)) throw fail('NOT_REPOSITORY', 'The selected project is not the root of a Git repository.');
    const flags = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames', '--submodule=short'];
    // Enumerate first so an all-project diff cannot disclose tracked secret files.
    const names = gitSuccess(await git(captured, ['diff', ...flags, '--name-only', '-z', '--', ...(relative ? [relative] : [])]));
    const paths = [];
    for (const name of names.split('\0').filter(Boolean)) {
      if (!visibleGitPath(name)) continue;
      await resolve(captured, name, { missing: true });
      paths.push(name);
    }
    if (!paths.length) return '';
    return gitSuccess(await git(captured, ['diff', ...flags, '--', ...paths]));
  }

  function checkJob(job) {
    if (job.cancelled) throw fail('COMMAND_CANCELLED', 'Command cancelled.');
    assertSession(job.session);
  }

  /**
   * Runs one shell command in the project folder.
   * @param {{command: string, timeoutMs?: number, onOutput?: (text: string) => void, signal?: AbortSignal}} request
   *   timeoutMs: 1 s to 10 min (default 30 s); onOutput hears stdout and stderr as they arrive;
   *   an aborted signal stops the command like cancel().
   */
  async function run(request) {
    const captured = session();
    const command = request?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 4000 || command.includes('\0')) throw fail('INVALID_COMMAND', 'Provide a nonempty command of at most 4000 characters without NUL bytes.');
    const timeoutMs = request?.timeoutMs === undefined ? COMMAND_TIMEOUT_MS : request.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) throw fail('INVALID_COMMAND', 'The command time limit must be between 1 second and 10 minutes.');
    const onOutput = typeof request?.onOutput === 'function' ? request.onOutput : null;
    const signal = request?.signal && typeof request.signal.addEventListener === 'function' ? request.signal : null;
    if (active) throw fail('COMMAND_BUSY', 'Another command is running or awaiting approval.');
    const job = { session: captured, cancelled: false, stop: null, notifyCancel: null };
    const cancelled = new Promise(resolvePromise => { job.notifyCancel = () => resolvePromise(false); });
    active = job;
    const onAbort = () => {
      if (job.cancelled) return;
      job.cancelled = true;
      job.notifyCancel();
      job.stop?.(fail('COMMAND_CANCELLED', 'Command cancelled.'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const seconds = Math.round(timeoutMs / 1000);
    try {
      await permission();
      await verifyRoot(captured);
      checkJob(job);
      const approved = await Promise.race([Promise.resolve().then(() => approve('Run project command', `Command (executed exactly as shown):\n${command}\n\nWorking directory:\n${captured.path}\n\nThis is an explicit shell capability, not a PTY. Limits: ${seconds} seconds and 1 MiB combined output.`)), cancelled]);
      checkJob(job);
      if (approved !== true) throw fail('APPROVAL_DENIED', 'Command execution was not approved.');
      await permission();
      await verifyRoot(captured);
      checkJob(job);
      return await new Promise((resolvePromise, reject) => {
        const stdout = [];
        const stderr = [];
        let size = 0;
        let child;
        let timer;
        let finished = false;
        let failure = null;
        function finish(code, error) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          job.stop = null;
          const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: Number.isInteger(code) ? code : null };
          const finalError = failure || error;
          if (finalError) reject(Object.assign(finalError, result));
          else resolvePromise(result);
        }
        job.stop = error => {
          if (finished || failure) return;
          failure = error;
          killTree(child);
        };
        // One decoder per stream, so a character split between two reads is not garbled.
        const decoders = new Map();
        function collect(destination, chunk) {
          if (finished || failure) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const available = LIMIT - size;
          const kept = bytes.subarray(0, Math.max(0, available));
          destination.push(kept);
          size += Math.min(bytes.length, available);
          if (onOutput && kept.length) {
            if (!decoders.has(destination)) decoders.set(destination, new TextDecoder('utf-8'));
            const text = decoders.get(destination).decode(kept, { stream: true });
            if (text) {
              try { onOutput(text); } catch { /* a listener never stops the command */ }
            }
          }
          if (bytes.length > available) job.stop(fail('OUTPUT_LIMIT', 'Command output exceeded 1 MiB; the process group was terminated.'));
        }
        const windows = process.platform === 'win32';
        const shell = windows ? 'C:\\Windows\\System32\\cmd.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
        const args = windows ? ['/d', '/s', '/c', command] : process.platform === 'darwin' ? ['-f', '-c', command] : ['-c', command];
        try {
          child = spawnImpl(shell, args, { cwd: captured.path, env: environment(), shell: false, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          child.on('error', error => finish(null, fail('COMMAND_FAILED', `Unable to start the command: ${error.message}`)));
          child.on('close', code => finish(code));
          child.stdout.on('data', chunk => collect(stdout, chunk));
          child.stderr.on('data', chunk => collect(stderr, chunk));
          timer = setTimeout(() => job.stop?.(fail('COMMAND_TIMEOUT', `Command exceeded ${seconds} seconds; the process group was terminated.`)), timeoutMs);
        } catch (error) { finish(null, fail('COMMAND_FAILED', `Unable to start the command: ${error.message}`)); }
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (active === job) active = null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
  }

  // The full path of a project file or folder, after the same checks as reading it (no links, no
  // secret paths, inside the project). For handing a file to the operating system, never for
  // reading it here.
  async function absolutePath(relative) {
    const captured = session();
    const entry = await resolve(captured, relative, { empty: true });
    if (entry.stat.isSymbolicLink()) throw fail('SYMLINK', 'Symbolic links are not allowed in workspace paths.');
    return { path: entry.absolute, relative: entry.relative, type: entry.stat.isDirectory() ? 'directory' : 'file' };
  }

  return { select, current, list, read, write, create, absolutePath, gitStatus, gitDiff, run, cancel, dispose };
}

module.exports = { createWorkspace };
