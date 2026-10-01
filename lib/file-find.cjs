'use strict';
// Finding files by name for @-mentions in the message box ("@src/pars" → src/parser.js), like the
// file pickers of other coding apps. It walks the open folder through the workspace service, so
// the same guards apply (no links, secret files never listed), skips dependency and build
// folders, and is bounded in folders, files and time. Ranking is plain and predictable: a match
// in the file name beats one in the path, earlier and tighter matches beat later ones.

const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', '.npm-cache', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', 'vendor', 'Pods',
  'DerivedData', '.gradle', '.idea', '.DS_Store',
]);
const LIMITS = { folders: 400, files: 20000, ms: 2500, results: 20, queryChars: 200 };

/** Every file of the folder (relative paths), breadth first, within the limits. */
async function listFiles(workspace, { limits = LIMITS, now = Date.now } = {}) {
  const started = now();
  const files = [];
  const queue = [''];
  let folders = 0;
  let complete = true;
  while (queue.length) {
    if (folders >= limits.folders || files.length >= limits.files || now() - started > limits.ms) {
      complete = false;
      break;
    }
    const folder = queue.shift();
    folders += 1;
    let entries;
    try {
      entries = (await workspace.list(folder)).entries;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.type === 'directory') {
        if (!SKIP.has(entry.name)) queue.push(relative);
      } else if (entry.type === 'file') {
        files.push(relative);
        if (files.length >= limits.files) break;
      }
    }
  }
  return { files, complete };
}

/**
 * A score for `path` against `query` (lower is better), or null when it does not match. The
 * query's characters must appear in order (fuzzy, like editors' quick-open); a run of them in
 * the file name scores best.
 */
function score(path, query) {
  const target = path.toLowerCase();
  const wanted = query.toLowerCase();
  if (!wanted) return path.split('/').length * 10 + path.length / 100;
  const name = target.slice(target.lastIndexOf('/') + 1);
  const inName = name.indexOf(wanted);
  if (inName >= 0) return inName + name.length / 100;
  const inPath = target.indexOf(wanted);
  if (inPath >= 0) return 100 + inPath + target.length / 100;
  // In order, with gaps: the fewer and shorter the gaps, the better.
  let position = -1;
  let gaps = 0;
  for (const char of wanted) {
    const next = target.indexOf(char, position + 1);
    if (next < 0) return null;
    if (position >= 0 && next > position + 1) gaps += next - position - 1;
    position = next;
  }
  return 1000 + gaps + target.length / 100;
}

/** The best matches for `query` among `files`, at most `limit`. */
function rankFiles(files, query, limit = LIMITS.results) {
  const text = String(query || '').trim().replace(/^@/, '').slice(0, LIMITS.queryChars);
  const scored = [];
  for (const file of files) {
    const value = score(file, text);
    if (value !== null) scored.push([value, file]);
  }
  scored.sort((left, right) => left[0] - right[0] || left[1].localeCompare(right[1]));
  return scored.slice(0, limit).map(([, file]) => file);
}

/**
 * A file finder on one workspace service. The listing is kept for a few seconds, so typing
 * "@s", "@sr", "@src" walks the folder once.
 */
function createFileFinder({ getWorkspace, now = Date.now, ttlMs = 5000 }) {
  let cache = null;
  // The walk in progress, by folder: keys typed meanwhile wait for it instead of starting more.
  let walking = null;
  return {
    async find(query) {
      const workspace = getWorkspace();
      const folder = workspace?.current?.();
      if (!folder) return { folder: null, files: [], complete: true };
      if (!cache || cache.root !== folder.path || now() - cache.at > ttlMs) {
        if (!walking || walking.root !== folder.path) {
          const walk = { root: folder.path };
          walk.promise = listFiles(workspace, { now }).then((listed) => {
            if (walking === walk) cache = { root: walk.root, at: now(), ...listed };
            return listed;
          }).finally(() => { if (walking === walk) walking = null; });
          walking = walk;
        }
        const listed = await walking.promise;
        return { folder, files: rankFiles(listed.files, query), complete: listed.complete };
      }
      return { folder, files: rankFiles(cache.files, query), complete: cache.complete };
    },
    forget() { cache = null; walking = null; },
  };
}

module.exports = { createFileFinder, listFiles, rankFiles, score, SKIP, LIMITS };
