/**
 * The app's own confirmation sheet (#confirm-dialog in index.html) for actions that cannot be
 * taken back, in place of the browser's bare window.confirm: a title that names the thing
 * ("Delete “Fix the login form”?"), one line under it saying which project / branch it is about,
 * what happens (and what does not), an optional short list (the files that would be lost), Cancel
 * and the action, filled red when it destroys something.
 *
 * Cancel has the focus when it opens, so Return never confirms by accident; Escape, Cancel and the
 * close button all answer false. Focus goes back where it was. One question at a time: asking a
 * new one answers the open one with false. DOM by createElement / textContent only.
 */

const state = { resolve: null, opener: null, bound: false };

// Answers the open question: the dialog closes, focus goes back, the promise settles.
function finish(dialog, value) {
  const resolve = state.resolve;
  const opener = state.opener;
  state.resolve = null;
  state.opener = null;
  if (dialog.open) dialog.close();
  // A function: where focus goes is decided now (the element it came from may have been redrawn).
  const target = typeof opener === 'function' ? opener() : opener;
  if (target?.isConnected && typeof target.focus === 'function') target.focus();
  resolve?.(value);
}

function bind(dialog) {
  if (state.bound) return;
  state.bound = true;
  dialog.querySelector('#confirm-accept')?.addEventListener('click', () => finish(dialog, true));
  dialog.querySelector('#confirm-cancel')?.addEventListener('click', () => finish(dialog, false));
  // Escape (the dialog's own cancel) or any other way it closes: "no".
  dialog.addEventListener('close', () => {
    if (state.resolve) finish(dialog, false);
  });
}

/**
 * Asks before an action. Resolves true only when the user chose `confirmLabel`.
 * @param {{
 *   title: string, context?: string, message?: string, details?: string[], note?: string,
 *   confirmLabel?: string, cancelLabel?: string, danger?: boolean, returnFocus?: HTMLElement | (() => HTMLElement | null),
 * }} question  context: the line under the title (the project and branch, the task);
 *   message: what happens; details: a few named items (files); note: a quieter last line;
 *   danger: the action destroys something (a red button); returnFocus: where focus goes after
 *   (default: what had it when the question opened), a function when that may be redrawn.
 * @returns {Promise<boolean>}
 */
export function askConfirm({
  title, context = '', message = '', details = [], note = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false,
  returnFocus = null,
} = {}) {
  const dialog = typeof document !== 'undefined' ? document.getElementById?.('confirm-dialog') : null;
  if (!dialog || typeof dialog.showModal !== 'function') {
    // No sheet (a page without it): the browser's own question, so nothing happens unasked.
    const text = [title, context, message, ...(details || []), note].filter(Boolean).join('\n\n');
    return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : false);
  }
  bind(dialog);
  // A question still open is answered "no" first.
  if (state.resolve) {
    const previous = state.resolve;
    state.resolve = null;
    previous(false);
  }
  const set = (id, text) => {
    const node = dialog.querySelector(id);
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  };
  set('#confirm-title', title || 'Are you sure?');
  set('#confirm-context', context);
  set('#confirm-message', message);
  set('#confirm-note', note);
  const list = dialog.querySelector('#confirm-details');
  if (list) {
    const items = (Array.isArray(details) ? details : []).filter((item) => typeof item === 'string' && item);
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement('li');
      row.textContent = item;
      return row;
    }));
    list.hidden = !items.length;
  }
  const accept = dialog.querySelector('#confirm-accept');
  if (accept) {
    accept.textContent = confirmLabel || 'OK';
    accept.classList.toggle('danger', Boolean(danger));
    accept.classList.toggle('primary', !danger);
  }
  const cancel = dialog.querySelector('#confirm-cancel');
  if (cancel) cancel.textContent = cancelLabel || 'Cancel';
  dialog.classList.toggle('is-danger', Boolean(danger));
  return new Promise((resolve) => {
    if (returnFocus) state.opener = returnFocus;
    else if (!dialog.open) state.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.resolve = resolve;
    if (!dialog.open) dialog.showModal();
    cancel?.focus();
  });
}
