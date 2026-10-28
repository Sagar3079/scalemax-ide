'use strict';
// "Update now" (Preferences & about, and a notice in the status bar): finds a newer release of
// ScaleMax IDE on GitHub, downloads this computer's file and installs it.
//   - Windows: the installer runs silently over the installed copy and starts the new version.
//   - macOS: the .dmg opens, and the user drags the new app over the old one. Apple's own
//     updater only accepts apps signed with a Developer ID, and this one is signed ad hoc.
// A file is used only if its size and SHA-256 match what GitHub publishes for it, and only
// github.com and GitHub's download hosts are contacted. A beta offers newer betas; a stable
// version offers only stable releases.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY = 'Sagar3079/scalemax-ide';
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
const DOWNLOAD_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const PAGE_PREFIX = `https://github.com/${REPOSITORY}/releases/`;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 15_000;

class UpdateError extends Error {}

/** 1.2.3 or 1.2.3-beta.4 → { core: [1, 2, 3], pre: ['beta', 4] }; null for anything else. */
function parseVersion(text) {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/.exec(String(text || ''));
  if (!match) return null;
  const pre = match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
  if (pre.some((part) => part === '')) return null;
  return { core: match.slice(1, 4).map(Number), pre };
}

/** Semantic-version order: negative when a < b. A prerelease comes before its release. */
function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) throw new UpdateError('Not a version number.');
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The release file for this computer, as electron-builder names it (package.json build). */
function assetName(version, { platform, arch }) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `ScaleMax-IDE-${version}-${arch}.dmg`;
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `ScaleMax-IDE-Setup-${version}-${arch}.exe`;
  return null;
}

/**
 * The newest release after `current` from GitHub's release list, with this computer's file:
 * { version, page, publishedAt, asset: { name, size, url, sha256 } | null }, or null when there
 * is none. A release without a usable file still counts (its page is offered instead).
 */
function pickRelease(releases, { current, platform, arch }) {
  const mine = parseVersion(current);
  if (!mine || !Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases.slice(0, 50)) {
    if (!release || typeof release !== 'object' || release.draft === true) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const version = tag.startsWith('v') ? tag.slice(1) : '';
    const parsed = parseVersion(version);
    if (!parsed || compareVersions(parsed, mine) <= 0) continue;
    // Betas are offered only to betas.
    if ((parsed.pre.length || release.prerelease === true) && !mine.pre.length) continue;
    if (best && compareVersions(parsed, best.parsed) <= 0) continue;
    const page = typeof release.html_url === 'string' && release.html_url.startsWith(PAGE_PREFIX)
      ? release.html_url : `${PAGE_PREFIX}tag/${encodeURIComponent(tag)}`;
    best = { parsed, version, page, publishedAt: typeof release.published_at === 'string' ? release.published_at : '', asset: null };
    const wanted = assetName(version, { platform, arch });
    const file = Array.isArray(release.assets) ? release.assets.find((item) => item && item.name === wanted) : null;
    const digest = file && typeof file.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(file.digest) : null;
    if (file && digest && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_FILE_BYTES
      && file.browser_download_url === `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${encodeURIComponent(wanted)}`) {
      best.asset = { name: wanted, size: file.size, url: file.browser_download_url, sha256: digest[1] };
    }
  }
  if (!best) return null;
  const { parsed, ...release } = best;
  return release;
}

/** github.com itself and the hosts its release downloads redirect to. */
function trustedHost(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'github.com' || hostname === 'api.github.com' || hostname.endsWith('.githubusercontent.com'));
  } catch {
    return false;
  }
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new UpdateError('GitHub sent an empty answer.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new UpdateError('GitHub sent more than expected.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {{
 *   current: string, platform?: string, arch?: string, dir: string,
 *   fetchImpl?: typeof fetch, feedUrl?: string, io?: typeof fs,
 *   openPath: (file: string) => Promise<string>, spawnImpl: Function, quit: () => void,
 *   onChange?: (state: object) => void, now?: () => number,
 * }} options
 */
function createUpdater({
  current, platform = process.platform, arch = process.arch, dir, fetchImpl = fetch, feedUrl = RELEASES_URL,
  io = fs, openPath, spawnImpl, quit, onChange = () => {}, now = Date.now,
}) {
  // status: idle → checking → current | available → downloading → ready (Windows: installing)
  // | opened (macOS); error keeps the last release found, so Update now can be tried again.
  let state = { status: 'idle', current, checkedAt: 0, release: null, progress: null, error: '' };
  let busy = null;
  let installing = false;

  function set(patch) {
    state = { ...state, ...patch };
    onChange(view());
  }

  function view() {
    const release = state.release && {
      version: state.release.version,
      page: state.release.page,
      publishedAt: state.release.publishedAt,
      downloadable: Boolean(state.release.asset),
      size: state.release.asset?.size || 0,
    };
    return { status: state.status, current, checkedAt: state.checkedAt, release, progress: state.progress, error: state.error, platform };
  }

  async function fetchReleases() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(feedUrl, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `ScaleMax-IDE/${current}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UpdateError(response.status === 403 || response.status === 429
          ? 'GitHub is limiting checks from this network. Try again in an hour.'
          : `GitHub answered with status ${response.status}.`);
      }
      const body = await readLimited(response, MAX_LIST_BYTES);
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        throw new UpdateError('GitHub sent a release list that could not be read.');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function runCheck() {
    set({ status: 'checking', error: '' });
    try {
      const release = pickRelease(await fetchReleases(), { current, platform, arch });
      set({ status: release ? 'available' : 'current', release, checkedAt: now(), progress: null });
    } catch (error) {
      set({ status: 'error', checkedAt: now(), progress: null, error: error instanceof UpdateError ? error.message
        : error?.name === 'AbortError' ? 'GitHub did not answer in time. Check your connection and try again.'
          : 'Could not reach GitHub. Check your connection and try again.' });
    }
  }

  /** Asks GitHub for a newer release; a check already running is joined, not repeated. */
  async function check() {
    if (installing || state.status === 'installing') return view();
    if (!busy) busy = runCheck().finally(() => { busy = null; });
    await busy;
    return view();
  }

  /** Downloads the release file into dir and checks it; returns its path. */
  async function download(asset) {
    io.mkdirSync(dir, { recursive: true });
    for (const name of io.readdirSync(dir)) io.rmSync(path.join(dir, name), { force: true, recursive: true });
    const file = path.join(dir, asset.name);
    const partial = `${file}.part`;
    set({ status: 'downloading', progress: { received: 0, total: asset.size }, error: '' });
    const response = await fetchImpl(asset.url, { headers: { 'user-agent': `ScaleMax-IDE/${current}` }, redirect: 'follow' });
    if (!trustedHost(response.url || asset.url)) throw new UpdateError('The download was sent somewhere other than GitHub, so it was stopped.');
    if (!response.ok) throw new UpdateError(`GitHub answered the download with status ${response.status}.`);
    const reader = response.body?.getReader?.();
    if (!reader) throw new UpdateError('GitHub sent an empty download.');
    const hash = crypto.createHash('sha256');
    const fd = io.openSync(partial, 'w', 0o600);
    let received = 0;
    let shown = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > asset.size) {
          await reader.cancel().catch(() => {});
          throw new UpdateError('The download is larger than GitHub said, so it was stopped.');
        }
        hash.update(value);
        io.writeSync(fd, value);
        if (received - shown >= 1024 * 1024 || received === asset.size) {
          shown = received;
          set({ progress: { received, total: asset.size } });
        }
      }
    } finally {
      io.closeSync(fd);
    }
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      io.rmSync(partial, { force: true });
      throw new UpdateError('The download does not match the file GitHub published, so it was not used.');
    }
    io.renameSync(partial, file);
    return file;
  }

  /** Update now: download, check, then install (Windows) or open the .dmg (macOS). */
  async function install() {
    if (installing || state.status === 'installing') return view();
    installing = true;
    try {
      return await installOnce();
    } finally {
      installing = false;
    }
  }

  async function installOnce() {
    if (!busy && !state.release) busy = runCheck().finally(() => { busy = null; });
    if (busy) await busy;
    const release = state.release;
    if (!release) throw new UpdateError('ScaleMax IDE is up to date.');
    if (!release.asset) throw new UpdateError(`Version ${release.version} has no download for this computer. Open its release page instead.`);
    let file;
    try {
      file = await download(release.asset);
    } catch (error) {
      set({ status: 'error', progress: null, error: error instanceof UpdateError ? error.message : 'The download failed. Try again.' });
      return view();
    }
    if (platform === 'win32') {
      set({ status: 'installing', progress: null });
      // The installer replaces this copy once it has quit, then starts the new version.
      const child = spawnImpl(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref?.();
      quit();
      return view();
    }
    const failure = await openPath(file);
    if (failure) {
      set({ status: 'error', progress: null, error: `The download is ready but could not be opened: ${failure}` });
      return view();
    }
    set({ status: 'opened', progress: null });
    return view();
  }

  return { check, install, get: view };
}

module.exports = { createUpdater, pickRelease, compareVersions, parseVersion, assetName, trustedHost, RELEASES_URL, UpdateError };
