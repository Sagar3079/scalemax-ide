// Updates (lib/updates.cjs through the bridge's `updates`): the Updates card in Preferences &
// about, and a notice in the status bar while a newer version is waiting. Update now installs it
// on Windows (the app closes and opens again) and opens its .dmg on macOS.
import { askConfirm } from './confirm-dialog.js';

const $ = (selector) => document.querySelector(selector);

const state = { app: null, updates: null, bound: false };

function bridge() {
  return window.scalemaxAPI?.updates || null;
}

function megabytes(bytes) {
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB` : '';
}

/** The sentence under "Updates" for each state. */
export function updateStatusText(updates) {
  const release = updates?.release;
  const current = updates?.current || '';
  switch (updates?.status) {
    case 'checking':
      return 'Checking GitHub for a newer version…';
    case 'current':
      return `You have the newest version, ${current}.`;
    case 'available':
      return release?.downloadable
        ? `Version ${release.version} is available (${megabytes(release.size)}). You have ${current}.`
        : `Version ${release?.version} is available, but has no download for this computer yet. Its release notes list the files.`;
    case 'downloading':
      return `Downloading version ${release?.version} (${megabytes(release?.size)})…`;
    case 'installing':
      return `Installing version ${release?.version}. ScaleMax IDE closes and opens again by itself.`;
    case 'opened':
      return `Version ${release?.version} is open in a Finder window. Quit ScaleMax IDE, drag the new ScaleMax IDE onto Applications and choose Replace, then open it again.`;
    case 'error':
      return updates.error || 'The update could not be checked.';
    default:
      return current ? `You have version ${current}.` : 'Version information is supplied by the app.';
  }
}

function render() {
  const updates = state.updates;
  const status = updates?.status || 'idle';
  const release = updates?.release || null;
  const busy = ['checking', 'downloading', 'installing'].includes(status);
  const text = $('#updates-status');
  if (text) text.textContent = updateStatusText(updates);

  const install = $('#updates-install');
  if (install) {
    install.hidden = !(release?.downloadable && ['available', 'downloading', 'error'].includes(status));
    install.disabled = busy;
    install.textContent = status === 'downloading' ? 'Downloading…' : 'Update now';
  }
  const check = $('#updates-check');
  if (check) check.disabled = busy || !bridge();
  const page = $('#updates-page');
  if (page) page.hidden = !release;

  const progress = $('#updates-progress');
  if (progress) {
    const shown = status === 'downloading' && updates.progress?.total > 0;
    progress.hidden = !shown;
    if (shown) {
      progress.max = updates.progress.total;
      progress.value = updates.progress.received;
    }
  }

  const auto = $('#updates-auto-toggle');
  if (auto) auto.setAttribute('aria-checked', String(state.app?.settings?.checkUpdates !== false));

  // The status bar says so while a newer version waits or downloads.
  const notice = $('#statusbar-update');
  if (notice) {
    const waiting = Boolean(release) && ['available', 'downloading'].includes(status);
    notice.hidden = !waiting;
    if (waiting) {
      const percent = status === 'downloading' && updates.progress?.total
        ? ` ${Math.floor((updates.progress.received / updates.progress.total) * 100)}%` : '';
      notice.textContent = status === 'downloading' ? `Downloading ${release.version}…${percent}` : `Update to ${release.version}`;
    }
  }
}

function show(updates) {
  if (updates && typeof updates === 'object') state.updates = updates;
  render();
}

async function call(name) {
  const api = bridge();
  if (!api?.[name]) return;
  try {
    const result = await api[name]();
    if (result?.ok) show(result.data);
    else show({ ...(state.updates || {}), status: 'error', error: result?.error?.message || 'The update could not be checked or installed.' });
  } catch {
    show({ ...(state.updates || {}), status: 'error', error: 'The update could not be checked or installed.' });
  }
}

async function updateNow() {
  const updates = state.updates;
  const release = updates?.release;
  if (!release?.downloadable) return;
  // On Windows the app closes for the installer: say so first.
  if (updates.platform === 'win32' && !(await askConfirm({
    title: `Install version ${release.version}?`,
    message: `ScaleMax IDE downloads the update (${megabytes(release.size)}), closes, installs it and opens again.`,
    note: 'Replies that are still running stop when it closes. Your tasks and settings stay.',
    confirmLabel: 'Update now',
    returnFocus: $('#updates-install'),
  }))) return;
  await call('install');
}

export function bindUpdatesUi(app) {
  state.app = app;
  render();
  if (state.bound) return;
  state.bound = true;
  const api = bridge();
  $('#updates-check')?.addEventListener('click', () => call('check'));
  $('#updates-install')?.addEventListener('click', () => updateNow());
  $('#updates-page')?.addEventListener('click', () => api?.openPage?.());
  $('#updates-auto-toggle')?.addEventListener('click', async () => {
    app.settings.checkUpdates = app.settings.checkUpdates === false;
    render();
    await app.persist('settings');
  });
  $('#statusbar-update')?.addEventListener('click', () => {
    app.showView?.('more');
    const target = $('#updates-install');
    target?.scrollIntoView?.({ block: 'center' });
    (target && !target.hidden ? target : $('#updates-check'))?.focus();
  });
  if (!api) return;
  api.onChanged?.((updates) => show(updates));
  api.get?.().then((result) => { if (result?.ok) show(result.data); }).catch(() => {});
}
