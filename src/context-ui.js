/**
 * What goes with a message besides its text:
 *   - pictures: pasted, dropped or picked, kept in the app's media folder by id (main reads them
 *     and gives the model image parts, main.js withImages);
 *   - files named with @: typing "@" opens a menu of the open folder's files (workspace:find);
 *     on send, each file still named in the text goes along as its contents (read through the
 *     workspace service, so secret files and links are refused there);
 *   - "@folder/" goes along as what is in that folder (two levels), "@https://…" as the page's
 *     text (fetched by main with web_open's guards) and "@job:j2" as a background command's
 *     recent output (only one of this folder): main resolves them (mention:resolve).
 * DOM is built with createElement and textContent only (no HTML).
 */
import { normalizeMessageImages } from './domain.mjs';

const $ = (selector) => document.querySelector(selector);
const MEDIA_ID = /^m-[a-f0-9]{16}$/;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const MAX_PENDING_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// A file named with @ is sent up to this size, and all of a message's files together up to
// MAX_MENTIONS_BYTES (the rest is left out, and the model is told), so a message stays well under
// the 1 MB a message may have.
const MAX_MENTION_BYTES = 128 * 1024;
const MAX_MENTIONS_BYTES = 512 * 1024;
const MAX_MENTIONS = 8;
// "@path" right before the caret: start of the text or after a space, no spaces inside.
const MENTION_AT_CARET = /(^|\s)@([^\s@]*)$/;
// Every "@…" in a message: a web address, a background command ("job:j2"), or a path with
// letters, digits and . _ - / only (a folder when it ends in "/").
const MENTION_IN_TEXT = /(^|\s)@(?:(https?:\/\/[^\s<>"'`]+)|job:(j\d{1,9})(?![\w\-/])|([\w.\-/]+[\w\-/]))/g;
// Folders offered in the menu besides the files.
const MAX_FOLDER_SUGGESTIONS = 5;

const state = { app: null, images: [], busy: 0, menu: null, results: [], details: new Map(), active: 0, token: 0, timer: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
const mediaUrl = (id) => (MEDIA_ID.test(id) ? `scalemax-media://${id}/` : '');

// ---- Pictures ---------------------------------------------------------------------------

/**
 * The selected chat model cannot read pictures: its entry says so, or it refused one this
 * session (unknown counts as "may").
 */
function modelRefusesPictures(app) {
  if (app.noPictureModels?.has(app.provider?.model)) return true;
  const model = (app.providerCatalog || []).find((item) => item.id === app.provider?.model);
  return model?.vision === false;
}
/** Whether the task's pictures go to the selected model (src/app.js handleSend). */
export function picturesAllowed(app) {
  return !modelRefusesPictures(app);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function renderPending() {
  const row = $('#image-row');
  if (!row) return;
  row.hidden = !state.images.length && !state.busy;
  row.replaceChildren(...state.images.map((picture) => {
    const item = element('div', 'composer-image');
    const img = element('img', 'composer-image-thumb');
    img.src = mediaUrl(picture.id);
    img.alt = picture.name || 'Attached picture';
    const remove = element('button', 'composer-image-remove', '×');
    remove.setAttribute('aria-label', `Remove ${picture.name || 'the picture'}`);
    remove.addEventListener('click', () => {
      state.images = state.images.filter((item) => item.id !== picture.id);
      renderPending();
      $('#chat-input')?.focus();
    });
    item.append(img, remove);
    return item;
  }), ...(state.busy ? [element('span', 'composer-image-busy', 'Adding the picture…')] : []));
  state.app?.updateSendEnabled?.();
}

function accept(item) {
  if (!item || !MEDIA_ID.test(item.id)) return false;
  if (state.images.length >= MAX_PENDING_IMAGES) {
    state.app?.showToast?.(`At most ${MAX_PENDING_IMAGES} pictures go with one message`);
    return false;
  }
  if (!state.images.some((picture) => picture.id === item.id)) state.images.push({ id: item.id, ...(item.name ? { name: item.name } : {}) });
  return true;
}

async function addFiles(files) {
  const app = state.app;
  const api = window.scalemaxAPI?.media;
  if (!api?.importImage) { app?.showToast?.('Pictures need the desktop app'); return; }
  if (modelRefusesPictures(app)) { app.showToast('This model cannot read pictures. Pick another model to send one.'); return; }
  // A picture belongs to the task it was added in: one that finishes after a switch is dropped.
  const taskId = app.currentTaskId;
  for (const file of files) {
    if (!IMAGE_TYPES.test(file.type)) { app.showToast('Use a PNG, JPEG, WebP or GIF picture'); continue; }
    if (file.size > MAX_IMAGE_BYTES) { app.showToast('That picture is larger than 20 MB'); continue; }
    state.busy += 1;
    renderPending();
    try {
      const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const result = await api.importImage({ data, name: file.name || 'pasted picture' });
      if (!result?.ok) app.showToast(result?.error?.message || 'That picture could not be added');
      else if (app.currentTaskId !== taskId) app.showToast('The picture was not added: another task is open now.');
      else accept(result.data);
    } catch {
      app.showToast('That picture could not be read');
    } finally {
      state.busy -= 1;
      renderPending();
    }
  }
}

async function pickImage() {
  const app = state.app;
  const api = window.scalemaxAPI?.media;
  if (!api?.pickImage) { app?.showToast?.('Pictures need the desktop app'); return; }
  if (modelRefusesPictures(app)) { app.showToast('This model cannot read pictures. Pick another model to send one.'); return; }
  const result = await api.pickImage();
  if (!result?.ok) { app.showToast(result?.error?.message || 'That picture could not be added'); return; }
  if (result.data && accept(result.data)) renderPending();
  $('#chat-input')?.focus();
}

/** Takes what waits in the message box for the message being sent (and empties the box). */
export function takeComposerContext() {
  const images = normalizeMessageImages(state.images);
  state.images = [];
  renderPending();
  return { images };
}

/** Pictures under a sent message. */
export function renderMessageImages(images) {
  const box = element('div', 'msg-images');
  for (const picture of normalizeMessageImages(images)) {
    const img = element('img', 'msg-image');
    img.src = mediaUrl(picture.id);
    img.alt = picture.name || 'Attached picture';
    img.loading = 'lazy';
    box.append(img);
  }
  return box;
}

/** True while a picture is still being added (Send waits for it). */
export function composerBusy() {
  return state.busy > 0;
}

// ---- @-mentions -------------------------------------------------------------------------

function closeMenu() {
  state.menu = null;
  state.results = [];
  const menu = $('#mention-menu');
  if (menu) menu.hidden = true;
  $('#chat-input')?.removeAttribute('aria-activedescendant');
}

function renderMenu() {
  const menu = $('#mention-menu');
  const input = $('#chat-input');
  if (!menu || !input) return;
  if (!state.menu) { closeMenu(); return; }
  menu.hidden = false;
  if (!state.results.length) {
    const jobs = /^job:/i.test(state.menu.query);
    menu.replaceChildren(element('div', 'mention-empty', state.menu.loading ? 'Looking for files…'
      : jobs ? 'No background command in this folder' : 'No file with that name in this folder'));
    input.removeAttribute('aria-activedescendant');
    return;
  }
  menu.replaceChildren(...state.results.map((path, index) => {
    const option = element('div', `mention-option${index === state.active ? ' is-active' : ''}`);
    option.id = `mention-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === state.active));
    option.dataset.path = path;
    const label = mentionLabel(path);
    option.append(element('span', 'mention-name', label.name), element('span', 'mention-dir', label.dir));
    return option;
  }));
  input.setAttribute('aria-activedescendant', `mention-option-${state.active}`);
  menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

// How a suggestion shows in the menu: a file or folder by its name and where it is, a background
// command by its id and command line.
function mentionLabel(path) {
  if (path.startsWith('job:')) return { name: path, dir: state.details.get(path) || '' };
  const folder = path.endsWith('/');
  const trimmed = folder ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return { name: `${trimmed.slice(slash + 1)}${folder ? '/' : ''}`, dir: slash > 0 ? trimmed.slice(0, slash) : '' };
}

/**
 * Folders to offer besides the files found for `query` ("@src" → src/): the folders of those files
 * whose name has the query in it or whose path starts with it, or with nothing typed the top-level
 * ones; at most MAX_FOLDER_SUGGESTIONS, in the order of the files.
 */
export function folderSuggestions(files, query) {
  const wanted = String(query ?? '').toLowerCase().replace(/\/+$/, '');
  const folders = [];
  for (const file of Array.isArray(files) ? files : []) {
    const parts = String(file).split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = `${parts.slice(0, depth).join('/')}/`;
      if (folders.includes(folder)) continue;
      const fits = wanted ? parts[depth - 1].toLowerCase().includes(wanted) || folder.toLowerCase().startsWith(wanted) : depth === 1;
      if (fits) folders.push(folder);
      if (folders.length >= MAX_FOLDER_SUGGESTIONS) return folders;
    }
  }
  return folders;
}

// What the menu offers for `query`: background commands of this folder after "job:", otherwise
// folders and files of the open folder.
async function mentionSuggestions(query, root) {
  const details = new Map();
  let found = [];
  if (/^job:/i.test(query)) {
    const listed = await window.scalemaxAPI?.jobs?.list?.();
    const wanted = query.slice(4).toLowerCase();
    const jobs = listed?.ok && Array.isArray(listed.data) ? listed.data : [];
    found = jobs.filter((job) => job && job.root === root && typeof job.id === 'string'
      && (!wanted || job.id.startsWith(wanted) || String(job.command || '').toLowerCase().includes(wanted)))
      .slice(0, 20).map((job) => {
        details.set(`job:${job.id}`, String(job.command || ''));
        return `job:${job.id}`;
      });
  } else {
    const result = await window.scalemaxAPI?.workspace?.find?.(query);
    const files = result?.ok && Array.isArray(result.data?.files) ? result.data.files : [];
    found = [...folderSuggestions(files, query), ...files];
  }
  return { found, details };
}

function updateMention() {
  const input = $('#chat-input');
  const app = state.app;
  if (!input || !app?.workspace?.root || input.selectionStart !== input.selectionEnd) { closeMenu(); return; }
  const before = input.value.slice(0, input.selectionStart);
  const match = MENTION_AT_CARET.exec(before);
  // A web address has nothing to choose from.
  if (!match || /^https?:/i.test(match[2])) { closeMenu(); return; }
  const query = match[2];
  state.menu = { start: before.length - query.length - 1, query, loading: true };
  const token = (state.token += 1);
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    let suggestions = { found: [], details: new Map() };
    try {
      suggestions = await mentionSuggestions(query, app.workspace.root);
    } catch { /* shown as no results */ }
    if (token !== state.token || !state.menu) return;
    state.results = suggestions.found;
    state.details = suggestions.details;
    state.active = 0;
    state.menu.loading = false;
    renderMenu();
  }, 90);
  renderMenu();
}

function choose(path) {
  const input = $('#chat-input');
  if (!input || !state.menu || typeof path !== 'string') return;
  const { start } = state.menu;
  const end = input.selectionStart;
  const insert = `@${path} `;
  input.value = `${input.value.slice(0, start)}${insert}${input.value.slice(end)}`;
  const caret = start + insert.length;
  input.setSelectionRange(caret, caret);
  closeMenu();
  input.focus();
  state.app?.updateSendEnabled?.();
}

// Runs before the message box's own keys (capture on its parent), so Enter picks a file
// instead of sending while the menu is open.
function onKeydown(event) {
  if (event.target !== $('#chat-input') || !state.menu) return;
  const count = state.results.length;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
    event.preventDefault();
    event.stopPropagation();
    state.active = (state.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    renderMenu();
  } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.isComposing && count) {
    event.preventDefault();
    event.stopPropagation();
    choose(state.results[state.active]);
  }
}

const encoder = new TextEncoder();
const utf8Bytes = (text) => encoder.encode(text).length;
/** The longest start of `text` of at most `limit` UTF-8 bytes, never splitting a character. */
function utf8Head(text, limit) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  // Back up over continuation bytes (10xxxxxx) to the start of a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * What is named with @ in `text`, in order and once each (at most MAX_MENTIONS):
 * { kind: 'file' | 'folder' | 'url' | 'job', value }. A trailing . , ; : ! ? ) or ] after a web
 * address is the sentence's, not the address's.
 */
export function mentionTargets(text) {
  const targets = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(MENTION_IN_TEXT)) {
    const target = match[2] ? { kind: 'url', value: match[2].replace(/[.,;:!?)\]]+$/, '') }
      : match[3] ? { kind: 'job', value: match[3] }
        : { kind: match[4].endsWith('/') ? 'folder' : 'file', value: match[4] };
    const key = `${target.kind}:${target.value}`;
    if (!target.value || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
    if (targets.length >= MAX_MENTIONS) break;
  }
  return targets;
}

const MENTION_HEADINGS = {
  folder: (label) => `Folder ${label} (named by the user with @; what is in it, two levels deep, secret files left out):`,
  url: (label) => `Web page ${label} (named by the user with @; read by ScaleMax just now, as text):`,
  job: (label) => `Background command ${label} (named by the user with @; its most recent output):`,
};
// A folder, a web page or a background command named with @, as main resolves it; a block for the
// model and its size, or null (the user is told why it did not go along).
async function otherMention(app, target, folder, room) {
  const api = window.scalemaxAPI?.mentions;
  if (!api?.resolve) return null;
  let result;
  try {
    result = await api.resolve({ folder, kind: target.kind, value: target.value });
  } catch {
    result = null;
  }
  if (!result?.ok || typeof result.data?.text !== 'string') {
    const name = target.kind === 'job' ? `job:${target.value}` : target.value;
    app.showToast?.(`@${name} did not go along: ${result?.error?.message || 'it could not be read'}`);
    return null;
  }
  let content = result.data.text;
  let note = '';
  const limit = Math.min(MAX_MENTION_BYTES, room);
  if (utf8Bytes(content) > limit) {
    content = utf8Head(content, limit);
    note = '\n[… the rest was left out]';
  }
  const fence = content.includes('```') ? '~~~~' : '```';
  const label = typeof result.data.label === 'string' && result.data.label ? result.data.label : target.value;
  return { text: `${MENTION_HEADINGS[target.kind](label)}\n${fence}\n${content}\n${fence}${note}`, bytes: utf8Bytes(content) };
}

/**
 * What is named with @ in `text`, as blocks for the model: a file as "File src/app.js:" and its
 * text, a folder as its listing, a web page as its text, a background command as its output.
 * Paths that are not files of the folder are left alone (an e-mail address, a handle).
 */
export async function mentionBlocks(app, text, folder) {
  const api = window.scalemaxAPI?.workspace;
  if (!api?.read || !folder || folder !== app.workspace?.root) return '';
  const blocks = [];
  let room = MAX_MENTIONS_BYTES;
  for (const target of mentionTargets(text)) {
    if (room <= 0) break;
    if (target.kind !== 'file') {
      const block = await otherMention(app, target, folder, room);
      if (block) {
        blocks.push(block.text);
        room -= block.bytes;
      }
      continue;
    }
    const path = target.value;
    let result;
    try {
      result = await api.read(path);
    } catch {
      continue;
    }
    if (!result?.ok || typeof result.data?.content !== 'string') continue;
    let content = result.data.content;
    let note = '';
    const limit = Math.min(MAX_MENTION_BYTES, room);
    if (utf8Bytes(content) > limit) {
      content = utf8Head(content, limit);
      note = '\n[… the rest of this file was left out; read it with workspace_read if you need it]';
    }
    room -= utf8Bytes(content);
    const fence = content.includes('```') ? '~~~~' : '```';
    blocks.push(`File ${result.data.path || path} (named by the user with @):\n${fence}\n${content}\n${fence}${note}`);
  }
  return blocks.join('\n\n');
}

export function bindComposerContext(app) {
  state.app = app;
  const input = $('#chat-input');
  if (!input) return;
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'mention-menu');
  // Pictures: pasted, dropped on the message box, or picked with the picture button.
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => IMAGE_TYPES.test(file.type));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });
  const card = $('#chat-card') || input.parentElement;
  card?.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file' && IMAGE_TYPES.test(item.type))) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  card?.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter((file) => IMAGE_TYPES.test(file.type));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });
  $('#image-btn')?.addEventListener('click', () => void pickImage());
  // @-mentions.
  input.addEventListener('input', updateMention);
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', () => window.setTimeout(closeMenu, 150));
  input.parentElement?.addEventListener('keydown', onKeydown, true);
  const menu = $('#mention-menu');
  // A click on the menu must not take the focus (and close it) before it picks the file.
  menu?.addEventListener('mousedown', (event) => event.preventDefault());
  menu?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-path]');
    if (option) choose(option.dataset.path);
  });
  renderPending();
}
