'use strict';
// Checkpoints: what each chat reply changed in its folder, so the user can review it as a diff
// and undo it file by file, the way coding agents keep a checkpoint per turn. Only changes made
// through the workspace tools are recorded (write_file, edit_file); what a shell command changes
// is not (it could be anything, anywhere), and the window says so.
//
// On disk, private to the user (folders 0700, files 0600):
//   <dir>/<id>/meta.json          the folder, times and one entry per file
//   <dir>/<id>/f<n>.before|after  a file before the reply's first change and after its last
// Undo puts a file back only while it is still exactly what the reply left (same SHA-256), so it
// never overwrites later work; the version it replaces goes to the project's
// .cache/editor-backups like every save.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { diffLines, countChanges } = require('./line-diff.cjs');

const VERSION = 1;
// Files kept with their contents; past that they are listed only, past MAX_ENTRIES counted only.
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_ENTRIES = 500;
// Before and after contents of one reply together.
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const BLOB = /^f\d{1,4}$/;
const MAX_CHECKPOINTS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION = /^[a-f0-9]{64}$/;

class CheckpointError extends Error {
  constructor(message, code = 'CHECKPOINT_ERROR') {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

/** A request id is a checkpoint id: bounded text without control characters. */
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\x00-\x1f\x7f]/.test(id);
}
// The folder name for an id: the id itself when it is plain, else a hash of it.
function storageName(id) {
  return SAFE_ID.test(id) ? id : `h-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}
function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
// A file the reply changed and then changed back is no change at all.
function unchanged(file) {
  return file.kind === 'modified' && file.afterRevision === file.beforeRevision;
}
function messageOf(error) {
  const message = typeof error?.message === 'string' ? error.message.replace(/\s+/g, ' ').trim() : '';
  return message ? message.slice(0, 300) : 'The file could not be put back.';
}

/**
 * @param {{ dir: string, now?: () => number, io?: typeof fs }} options dir: absolute folder for
 *   the checkpoints (main uses <userData>/checkpoints)
 */
function createCheckpoints({ dir, now = () => Date.now(), io = fs, limits = {} } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('An absolute checkpoint folder is required.');
  const MAX_FILES = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const MAX_ENTRIES = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const MAX_BYTES = limits.maxBytes ?? DEFAULT_MAX_BYTES;

  // Written to a temporary file, flushed to disk, then renamed: a crash leaves the old version
  // or the new one, never half of one.
  function writeAtomic(target, text) {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = io.openSync(temporary, 'wx', 0o600);
    try {
      io.writeFileSync(handle, text);
      io.fsyncSync(handle);
    } finally {
      io.closeSync(handle);
    }
    try {
      io.renameSync(temporary, target);
    } catch (error) {
      try { io.rmSync(temporary, { force: true }); } catch { /* nothing more to do */ }
      throw error;
    }
  }
  function locate(id) {
    if (!validId(id)) throw new CheckpointError('That list of changes is not valid.', 'INVALID_CHECKPOINT');
    return path.join(dir, storageName(id));
  }
  function readMeta(id) {
    const base = locate(id);
    let meta = null;
    try {
      meta = JSON.parse(io.readFileSync(path.join(base, 'meta.json'), 'utf8'));
    } catch {
      throw new CheckpointError('The changes of that reply are no longer kept.', 'NO_CHECKPOINT');
    }
    if (!meta || meta.version !== VERSION || meta.id !== id || !Array.isArray(meta.files)) {
      throw new CheckpointError('The changes of that reply could not be read.', 'NO_CHECKPOINT');
    }
    return { base, meta };
  }
  function saveMeta(base, meta) {
    meta.updatedAt = now();
    writeAtomic(path.join(base, 'meta.json'), JSON.stringify(meta));
  }
  function blob(base, file, side) {
    if (typeof file?.blob !== 'string' || !BLOB.test(file.blob)) return null;
    try {
      return io.readFileSync(path.join(base, `${file.blob}.${side}`), 'utf8');
    } catch {
      return null;
    }
  }
  /** What the window gets: relative paths, kinds, line counts and statuses, never file contents. */
  function summaryOf(meta) {
    const files = meta.files.filter((file) => !unchanged(file)).map((file) => ({
      path: file.path,
      kind: file.kind,
      added: file.added,
      removed: file.removed,
      status: file.status,
      ...(file.untracked ? { untracked: true } : {}),
      // Also changed by someone else while the reply ran: not undone here.
      ...(file.mixed ? { mixed: true } : {}),
      ...(file.approximate ? { approximate: true } : {}),
    }));
    if (!files.length) return null;
    return { id: meta.id, folderName: meta.folderName, files, ...(meta.omitted > 0 ? { omitted: meta.omitted } : {}) };
  }
  // Saves the bookkeeping after files were changed: a failure here must not hide what was done
  // to the files, so it is logged instead of thrown.
  function saveMetaAfter(base, meta) {
    try {
      saveMeta(base, meta);
      return true;
    } catch (error) {
      console.error('[ScaleMax] The undo state could not be saved:', error?.code || 'error');
      return false;
    }
  }

  /**
   * Records the changes of one reply as they happen. `record` takes what lib/workspace-tools.cjs
   * reports ({ path, before, beforeRevision, after, afterRevision }) and saves at once, so a
   * reply that is stopped part way keeps what it changed. Null without a folder.
   */
  function recorder({ requestId, folder } = {}) {
    if (!validId(requestId) || !folder || typeof folder.path !== 'string' || !path.isAbsolute(folder.path)) return null;
    const base = locate(requestId);
    let meta = null;
    // A checkpoint of this id exists already (a reused request id): nothing is recorded, so
    // the older reply's changes stay as they were.
    let refused = false;
    const files = new Map();
    // Bytes of the stored before and after versions.
    let stored = 0;
    function start() {
      io.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        io.mkdirSync(base, { mode: 0o700 });
      } catch (error) {
        if (error?.code === 'EEXIST') { refused = true; return false; }
        throw error;
      }
      meta = { version: VERSION, id: requestId, folder: folder.path, folderName: String(folder.name || path.basename(folder.path)), createdAt: now(), updatedAt: now(), files: [], omitted: 0 };
      return true;
    }
    function record(change) {
      if (refused || !change || typeof change.path !== 'string' || !change.path || typeof change.after !== 'string'
        || !REVISION.test(change.afterRevision || '')) return;
      const created = change.before === null || change.before === undefined;
      if (!created && (typeof change.before !== 'string' || !REVISION.test(change.beforeRevision || ''))) return;
      if (!meta && !start()) return;
      let file = files.get(change.path);
      if (!file) {
        if (meta.files.length >= MAX_ENTRIES) {
          // Past what the window can list: counted only.
          meta.omitted += 1;
          saveMeta(base, meta);
          return;
        }
        file = {
          path: change.path, blob: `f${meta.files.length}`, kind: created ? 'created' : 'modified',
          beforeRevision: created ? null : change.beforeRevision, afterRevision: null,
          added: 0, removed: 0, status: 'changed', afterBytes: 0,
        };
        // Listed first, so a failed write below never lets a later change pass for the first one.
        meta.files.push(file);
        files.set(change.path, file);
        const beforeBytes = created ? 0 : Buffer.byteLength(change.before);
        if (meta.files.length > MAX_FILES || stored + beforeBytes > MAX_BYTES) {
          // Listed, but its earlier version is not kept: it cannot be undone here.
          file.untracked = true;
        } else if (!created) {
          try {
            writeAtomic(path.join(base, `${file.blob}.before`), change.before);
            stored += beforeBytes;
          } catch {
            file.untracked = true;
          }
        }
      } else if (file.afterRevision !== (created ? null : change.beforeRevision)) {
        // Between two changes of this reply, someone else changed the file (the user, another
        // reply, a command): undoing it here would throw their work away.
        file.mixed = true;
      }
      file.afterRevision = change.afterRevision;
      // A later change by this reply replaces the stored after version.
      file.status = 'changed';
      if (!file.untracked) {
        const afterBytes = Buffer.byteLength(change.after);
        if (stored - file.afterBytes + afterBytes > MAX_BYTES) {
          // Undo still works (it needs the earlier version and the revision); the diff does not.
          file.noDiff = true;
          try { io.rmSync(path.join(base, `${file.blob}.after`), { force: true }); } catch { /* stays until pruned */ }
          stored -= file.afterBytes;
          file.afterBytes = 0;
        } else {
          try {
            writeAtomic(path.join(base, `${file.blob}.after`), change.after);
            stored += afterBytes - file.afterBytes;
            file.afterBytes = afterBytes;
            delete file.noDiff;
          } catch {
            file.noDiff = true;
          }
        }
      }
      // Lines added and removed against the version before the reply (for a file whose earlier
      // version is not kept, this change alone).
      const before = file.kind === 'created' ? '' : file.untracked ? change.before : blob(base, file, 'before');
      const counts = countChanges(typeof before === 'string' ? before : '', change.after);
      file.added = counts.added;
      file.removed = counts.removed;
      if (counts.approximate) file.approximate = true;
      else delete file.approximate;
      saveMeta(base, meta);
    }
    return {
      record,
      /** The reply's changes for the window, or null when it changed nothing. */
      summary: () => (meta ? summaryOf(meta) : null),
    };
  }

  /** The folder a checkpoint belongs to (main opens it to review or undo). */
  function folderOf(id) {
    const { meta } = readMeta(id);
    return { path: meta.folder, name: meta.folderName };
  }

  function summary(id) {
    return summaryOf(readMeta(id).meta);
  }

  /**
   * One file's change as hunks (lib/line-diff.cjs), and how the file is now: 'same' (as the reply
   * left it: it can be undone), 'original' (back as it was before the reply), 'changed',
   * 'missing', or 'unknown' when the folder could not be checked.
   */
  async function diff(id, filePath, { workspace = null } = {}) {
    const { base, meta } = readMeta(id);
    const file = meta.files.find((item) => item.path === filePath && !unchanged(item));
    if (!file) throw new CheckpointError('That file is not among the changes of this reply.', 'NOT_FOUND');
    const head = { path: file.path, kind: file.kind, status: file.status, added: file.added, removed: file.removed };
    let current = 'unknown';
    if (workspace) {
      try {
        const onDisk = await workspace.read(file.path);
        if (onDisk.revision === file.afterRevision) current = 'same';
        else if (file.kind === 'modified' && onDisk.revision === file.beforeRevision) current = 'original';
        else current = 'changed';
      } catch (error) {
        current = error?.code === 'ENOENT' ? (file.kind === 'created' ? 'original' : 'missing') : 'unknown';
      }
    }
    if (file.mixed) head.mixed = true;
    if (file.untracked) return { ...head, untracked: true, current, hunks: [], approximate: false, truncated: false };
    if (file.noDiff) return { ...head, noDiff: true, current, hunks: [], approximate: false, truncated: false };
    const before = file.kind === 'created' ? '' : blob(base, file, 'before');
    const after = blob(base, file, 'after');
    if (before === null || after === null) throw new CheckpointError('The changes of that reply could not be read.', 'NO_CHECKPOINT');
    const { hunks, approximate, truncated } = diffLines(before, after);
    return { ...head, current, hunks, approximate, truncated };
  }

  /**
   * Puts files back as they were before the reply (all of its changed files, or `paths`), each
   * only while it is exactly what the reply left. A file the reply created is deleted (with a
   * backup). Returns what happened per file and the updated summary.
   * @param {{ workspace: { read: Function, write: Function, remove: Function } }} options a
   *   workspace session on the checkpoint's folder
   */
  async function undo(id, paths, { workspace } = {}) {
    if (!workspace || typeof workspace.read !== 'function') throw new TypeError('A workspace session is required.');
    const { base, meta } = readMeta(id);
    const wanted = Array.isArray(paths) ? new Set(paths.filter((item) => typeof item === 'string')) : null;
    const results = [];
    for (const file of meta.files) {
      if (unchanged(file) || file.status !== 'changed' || (wanted && !wanted.has(file.path))) continue;
      const fail = (code, message) => results.push({ path: file.path, ok: false, code, message });
      if (file.untracked) {
        fail('NOT_KEPT', `${file.path} was not recorded (the reply changed too many or too large files), so it cannot be undone here.`);
        continue;
      }
      if (file.mixed) {
        fail('MIXED', `${file.path} was also changed by someone else while this reply ran, so undoing it here could lose that work. Change it by hand.`);
        continue;
      }
      let current = null;
      try {
        current = await workspace.read(file.path);
      } catch (error) {
        if (error?.code !== 'ENOENT') { fail(error?.code || 'READ_FAILED', messageOf(error)); continue; }
      }
      try {
        if (file.kind === 'created') {
          if (current && current.revision !== file.afterRevision) {
            fail('CHANGED_SINCE', `${file.path} has changed since this reply, so it was left as it is.`);
            continue;
          }
          if (current) await workspace.remove({ path: file.path, revision: current.revision });
        } else {
          if (!current) { fail('MISSING', `${file.path} no longer exists, so it was left as it is.`); continue; }
          if (current.revision !== file.afterRevision) {
            fail('CHANGED_SINCE', `${file.path} has changed since this reply, so it was left as it is.`);
            continue;
          }
          const before = blob(base, file, 'before');
          // Only the exact earlier version goes back (a damaged copy never does).
          if (before === null || sha256(before) !== file.beforeRevision) {
            fail('NOT_KEPT', `The earlier version of ${file.path} is no longer kept intact, so it was left as it is.`);
            continue;
          }
          await workspace.write({ path: file.path, content: before, revision: current.revision });
        }
        file.status = 'undone';
        results.push({ path: file.path, ok: true });
      } catch (error) {
        fail(error?.code || 'UNDO_FAILED', messageOf(error));
      }
    }
    saveMetaAfter(base, meta);
    return { results, changes: summaryOf(meta) };
  }

  /** Marks files (all changed ones, or `paths`) as kept: they are no longer offered for undo. */
  function keep(id, paths) {
    const { base, meta } = readMeta(id);
    const wanted = Array.isArray(paths) ? new Set(paths.filter((item) => typeof item === 'string')) : null;
    for (const file of meta.files) {
      if (file.status === 'changed' && (!wanted || wanted.has(file.path))) file.status = 'kept';
    }
    saveMeta(base, meta);
    return summaryOf(meta);
  }

  /** Forgets checkpoints (a deleted task's replies). */
  function remove(ids) {
    let removed = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!validId(id)) continue;
      try {
        io.rmSync(locate(id), { recursive: true, force: true });
        removed += 1;
      } catch { /* already gone */ }
    }
    return removed;
  }

  /** Keeps the newest `maxCount` checkpoints of the last `maxAgeMs`; returns how many went. */
  function prune({ maxAgeMs = MAX_AGE_MS, maxCount = MAX_CHECKPOINTS } = {}) {
    let names = [];
    try { names = io.readdirSync(dir); } catch { return 0; }
    const entries = [];
    for (const name of names) {
      const target = path.join(dir, name);
      let time = 0;
      try {
        time = Number(JSON.parse(io.readFileSync(path.join(target, 'meta.json'), 'utf8')).updatedAt) || 0;
      } catch {
        try { time = io.statSync(target).mtimeMs; } catch { continue; }
      }
      entries.push({ target, time });
    }
    entries.sort((left, right) => right.time - left.time);
    let removed = 0;
    entries.forEach((entry, index) => {
      if (index < maxCount && now() - entry.time <= maxAgeMs) return;
      try {
        io.rmSync(entry.target, { recursive: true, force: true });
        removed += 1;
      } catch { /* try again next start */ }
    });
    return removed;
  }

  return { recorder, summary, folderOf, diff, undo, keep, remove, prune };
}

module.exports = { createCheckpoints, CheckpointError, MAX_FILES: DEFAULT_MAX_FILES, MAX_BYTES: DEFAULT_MAX_BYTES, validId };
