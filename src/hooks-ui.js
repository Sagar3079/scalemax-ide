/**
 * Hooks in the window (lib/hooks.cjs runs them, in main):
 *   - before a message goes out in a folder whose own hooks (.scalemax/settings.json) have not been
 *     allowed in their current form, #hooks-dialog shows them and asks (reviewProjectHooks);
 *     "Not now" sends the message without them and does not ask again for those hooks this session;
 *   - Preferences > Hooks lists the hooks of the folder on screen and the user's own, per scope,
 *     with a switch for each hook, and Allow / Take back for the project's.
 * The window shows what main says and sends the user's answers: main allows a project's hooks
 * only when the hash the window was shown is still the hash of the file.
 * DOM is built with createElement and textContent only (no HTML).
 */
const $ = (selector) => document.querySelector(selector);

const SCOPE_TITLES = {
  project: 'This project (.scalemax/settings.json)',
  user: 'Yours, in every project (~/.scalemax/settings.json)',
};

const state = { app: null, dismissed: new Map(), busy: false };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function bridge() {
  return window.scalemaxAPI?.hooks || null;
}
// The folder of the task on screen, or the open folder.
function folderOf(app) {
  return app?.taskFolderShown?.()?.path || app?.workspace?.root || '';
}

/** "PreToolUse · workspace_(write|edit)" (the matcher only for tool events that have one). */
export function hookLabel(hook) {
  const matcher = typeof hook?.matcher === 'string' && hook.matcher && hook.matcher !== '*' ? ` · ${hook.matcher}` : '';
  return `${hook?.event || 'Hook'}${matcher}`;
}

function hookRow(hook) {
  const row = element('li', 'hooks-item');
  const head = element('span', 'hooks-item-head', hookLabel(hook));
  const command = element('code', 'hooks-item-command', hook.command);
  const limit = element('span', 'hooks-item-limit', `${hook.timeout}s limit`);
  row.append(head, command, limit);
  return row;
}

// Asks about a project's hooks; resolves true when the user allows them.
function askAboutHooks(scope, folder) {
  const dialog = $('#hooks-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(false);
  $('#hooks-dialog-folder').textContent = folder?.name ? `In "${folder.name}"` : '';
  $('#hooks-dialog-list').replaceChildren(...scope.hooks.map(hookRow));
  return new Promise((resolve) => {
    const allow = $('#hooks-dialog-allow');
    const deny = $('#hooks-dialog-deny');
    let answered = false;
    const finish = (yes) => {
      if (answered) return;
      answered = true;
      allow?.removeEventListener('click', onYes);
      deny?.removeEventListener('click', onNo);
      dialog.removeEventListener('close', onNo);
      if (dialog.open) dialog.close();
      resolve(yes);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    allow?.addEventListener('click', onYes);
    deny?.addEventListener('click', onNo);
    dialog.addEventListener('close', onNo);
    dialog.showModal();
    // Focus starts on "Not now": the safe choice.
    deny?.focus();
  });
}

/**
 * Before a message goes out in `folder` (src/app.js handleSend): asks about the folder's own
 * hooks when they have not been allowed in this form, unless the user said "Not now" to exactly
 * these hooks this session. Never blocks the message: hooks that are not allowed do not run.
 */
export async function reviewProjectHooks(app, folder) {
  const api = bridge();
  if (!api?.list || !api.approve || !folder || state.busy) return;
  let result;
  try {
    result = await api.list({ folder });
  } catch {
    return;
  }
  const scope = result?.ok && Array.isArray(result.data?.scopes) ? result.data.scopes.find((item) => item.scope === 'project') : null;
  if (!scope?.pending || state.dismissed.get(folder) === scope.hash) return;
  state.busy = true;
  try {
    if (await askAboutHooks(scope, result.data.folder)) {
      const answer = await api.approve({ folder, hash: scope.hash });
      app.showToast?.(answer?.ok ? 'This project\'s hooks are allowed' : answer?.error?.message || 'The hooks were not allowed');
    } else {
      state.dismissed.set(folder, scope.hash);
      app.showToast?.('This project\'s hooks will not run. You can allow them in Preferences > Hooks.');
    }
  } finally {
    state.busy = false;
  }
  void renderHooksPanel(app);
}

function switchFor(hook) {
  const button = element('button', 'switch hooks-switch');
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(hook.enabled !== false));
  button.setAttribute('aria-label', `${hookLabel(hook)}: ${hook.command}`);
  button.dataset.hookId = hook.id;
  button.append(element('span', 'switch-thumb'));
  return button;
}

function scopeSection(scope, folder) {
  const section = element('section', 'hooks-scope');
  section.append(element('h3', 'hooks-scope-title', SCOPE_TITLES[scope.scope] || scope.scope));
  const status = element('p', 'status-text hooks-scope-status');
  if (!scope.hooks.length) {
    status.textContent = scope.exists ? 'No hooks set up.' : 'No settings file.';
  } else if (scope.scope === 'user') {
    status.textContent = 'Your own hooks run without asking.';
  } else {
    status.textContent = scope.approved ? 'Allowed in this form. A change asks again.' : 'Waiting for your approval: these hooks do not run.';
  }
  section.append(status);
  if (scope.scope === 'project' && scope.hooks.length && folder) {
    const action = element('button', 'button secondary compact hooks-approve', scope.approved ? 'Take back' : 'Allow these hooks');
    action.dataset.hooksAction = scope.approved ? 'revoke' : 'approve';
    action.dataset.hash = scope.hash;
    section.append(action);
  }
  for (const error of Array.isArray(scope.errors) ? scope.errors : []) section.append(element('p', 'status-text hooks-error', error));
  if (scope.hooks.length) {
    const list = element('ul', 'hooks-rows');
    for (const hook of scope.hooks) {
      const row = element('li', 'hooks-row');
      const text = element('div', 'hooks-row-text');
      text.append(element('span', 'hooks-item-head', hookLabel(hook)), element('code', 'hooks-item-command', hook.command));
      row.append(text, switchFor(hook));
      list.append(row);
    }
    section.append(list);
  }
  return section;
}

/** Preferences > Hooks: the hooks of the folder on screen and the user's own. */
export async function renderHooksPanel(app = state.app) {
  const panel = $('#hooks-panel');
  const api = bridge();
  if (!panel) return;
  if (!api?.list) {
    panel.replaceChildren(element('p', 'status-text', 'Hooks need the desktop app.'));
    return;
  }
  const folder = folderOf(app);
  let result;
  try {
    result = await api.list({ folder: folder || undefined });
  } catch {
    result = null;
  }
  if (!result?.ok) {
    panel.replaceChildren(element('p', 'status-text', result?.error?.message || 'The hooks could not be read.'));
    return;
  }
  const scopes = Array.isArray(result.data?.scopes) ? result.data.scopes : [];
  const nodes = [];
  if (!folder) nodes.push(element('p', 'status-text', 'Open a folder to see its own hooks.'));
  for (const scope of scopes) nodes.push(scopeSection(scope, folder));
  panel.replaceChildren(...nodes);
}

async function onPanelClick(event) {
  const app = state.app;
  const api = bridge();
  if (!api) return;
  const toggle = event.target.closest('[data-hook-id]');
  if (toggle) {
    const enabled = toggle.getAttribute('aria-checked') !== 'true';
    const result = await api.setEnabled({ id: toggle.dataset.hookId, enabled });
    if (!result?.ok) app?.showToast?.(result?.error?.message || 'That hook could not be switched');
    await renderHooksPanel(app);
    return;
  }
  const action = event.target.closest('[data-hooks-action]');
  if (!action) return;
  const folder = folderOf(app);
  const result = action.dataset.hooksAction === 'revoke'
    ? await api.approve({ folder, revoke: true })
    : await api.approve({ folder, hash: action.dataset.hash });
  if (!result?.ok) app?.showToast?.(result?.error?.message || 'The hooks could not be changed');
  else {
    state.dismissed.delete(folder);
    app?.showToast?.(action.dataset.hooksAction === 'revoke' ? 'This project\'s hooks will not run' : 'This project\'s hooks are allowed');
  }
  await renderHooksPanel(app);
}

export function bindHooksUi(app) {
  state.app = app;
  $('#hooks-panel')?.addEventListener('click', (event) => void onPanelClick(event));
  $('#hooks-refresh')?.addEventListener('click', () => void renderHooksPanel(app));
  // Preferences shows the hooks as they are when it is opened.
  $('#sidebar-nav')?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-view="more"]')) void renderHooksPanel(app);
  });
  void renderHooksPanel(app);
}
