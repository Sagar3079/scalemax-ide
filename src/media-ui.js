/**
 * ScaleMax image and video generation in the composer.
 *
 * When an image or video model is picked in the model menu, the options that model advertises
 * (sizes, qualities, number of images, aspect ratios, resolutions, duration, edit / image-to-video
 * / extend) appear above the message box, with the provider's list price. Send becomes Generate.
 * Results are stored by the main process and shown in the chat through scalemax-media://<id>/,
 * with Download and Edit. DOM is built with textContent and CSSOM only (CSP).
 */
import { currentMediaModel, mediaModels, renderModelButton } from './composer-ui.js';
import { tickReply } from './reply-ui.js';

const $ = (selector) => document.querySelector(selector);
const MEDIA_ID = /^m-[a-f0-9]{16}$/;
const VIDEO_MODES = [
  ['generate', 'Text → video'],
  ['animate', 'Image → video'],
  ['edit', 'Edit video'],
  ['extend', 'Extend'],
];
const IMAGE_MODES = [
  ['generate', 'Generate'],
  ['edit', 'Edit image'],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function mediaBridge() {
  return window.scalemaxAPI?.media || null;
}

export function mediaUrl(id) {
  return MEDIA_ID.test(id) ? `scalemax-media://${id}/` : '';
}

/** 'image' | 'video' when the composer generates, otherwise null. */
export function mediaMode(app) {
  const mode = app.settings.composerMode;
  return mode === 'image' || mode === 'video' ? mode : null;
}

function state(app) {
  if (!app.mediaState) app.mediaState = { image: { mode: 'generate', source: null }, video: { mode: 'generate', source: null } };
  return app.mediaState;
}

// ---- Options -----------------------------------------------------------------------

/** The options to send: the saved choice when this model offers it, otherwise the model's default. */
export function effectiveOptions(model, saved = {}) {
  const media = model?.media;
  if (!media) return {};
  const choose = (value, list) => (list.includes(value) ? value : list[0]);
  if (media.kind === 'image') {
    const options = {};
    if (media.sizes.length) options.size = choose(saved.size, media.sizes);
    if (media.qualities.length) options.quality = choose(saved.quality, media.qualities);
    options.n = Number.isSafeInteger(saved.n) && saved.n >= 1 && saved.n <= media.maxImages ? saved.n : 1;
    return options;
  }
  const options = {};
  if (media.aspectRatios.length) options.aspectRatio = choose(saved.aspectRatio, media.aspectRatios);
  if (media.resolutions.length) {
    // The cheapest resolution by default: generating video reserves real credit.
    options.resolution = media.resolutions.includes(saved.resolution) ? saved.resolution : media.resolutions[0];
  }
  options.duration = Number.isSafeInteger(saved.duration) && saved.duration >= media.durationMin && saved.duration <= media.durationMax
    ? saved.duration : media.defaultDuration;
  return options;
}

function money(value) {
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** The list-price estimate for these options, or '' when the provider publishes none. */
export function costEstimate(model, options) {
  const media = model?.media;
  if (!media) return '';
  if (media.kind === 'image') {
    const { min, max } = media.pricing || {};
    if (min === null || max === null || min === undefined) return '';
    const n = options.n || 1;
    return min === max ? `≈ ${money(min * n)}` : `≈ ${money(min * n)}–${money(max * n)}`;
  }
  const rates = media.pricing?.perSecond || {};
  const rate = rates[options.resolution] ?? rates['720p'] ?? Object.values(rates)[0];
  if (rate === undefined) return '';
  return `≈ ${money(Math.ceil(rate * (options.duration || media.defaultDuration) * 100) / 100)}`;
}

/** A one-line summary of a generation for the chat ("Image · ScaleMax Image 2 · 1024x1024 · low"). */
export function requestSummary(kind, model, mode, options) {
  const parts = [kind === 'image' ? 'Image' : 'Video', model?.displayName || model?.id || ''];
  const labels = kind === 'image' ? IMAGE_MODES : VIDEO_MODES;
  if (mode !== 'generate') parts.push(labels.find(([value]) => value === mode)?.[1] || mode);
  if (kind === 'image') {
    if (options.size) parts.push(options.size);
    if (options.quality) parts.push(options.quality);
    if (options.n > 1) parts.push(`${options.n} images`);
  } else {
    if (options.aspectRatio) parts.push(options.aspectRatio);
    if (options.resolution) parts.push(options.resolution);
    if (options.duration) parts.push(`${options.duration}s`);
  }
  return parts.filter(Boolean).join(' · ');
}

function field(label, control) {
  const wrap = element('label', 'media-field');
  wrap.append(element('span', 'media-field-label', label), control);
  return wrap;
}

function select(values, current, onChange, label) {
  const node = document.createElement('select');
  node.className = 'media-select';
  node.setAttribute('aria-label', label);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    node.append(option);
  }
  node.value = current;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function modeSwitch(app, kind, model) {
  const media = model.media;
  const group = element('div', 'segmented media-modes');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', kind === 'image' ? 'Image mode' : 'Video mode');
  const current = state(app)[kind].mode;
  const modes = kind === 'image' ? IMAGE_MODES : VIDEO_MODES;
  for (const [value, label] of modes) {
    const option = element('button', 'segmented-option', label);
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(value === current));
    option.dataset.mediaMode = value;
    let reason = '';
    if (kind === 'image' && value === 'edit' && !media.edit) reason = `${model.displayName} cannot edit images.`;
    if (kind === 'video' && value === 'generate' && !media.textToVideo) reason = `${model.displayName} needs a starting image.`;
    if (kind === 'video' && value === 'animate' && !media.imageToVideo) reason = `${model.displayName} cannot start from an image.`;
    if (kind === 'video' && value === 'edit' && !media.edit) reason = `${model.displayName} cannot edit videos.`;
    if (kind === 'video' && value === 'extend') reason = media.extend ? 'Extending is not available in ScaleMax yet.' : `${model.displayName} cannot extend videos.`;
    // Every mode stays visible; the ones this model cannot do explain why.
    if (reason) {
      option.disabled = true;
      option.title = reason;
    }
    option.addEventListener('click', () => {
      state(app)[kind].mode = value;
      renderMediaBar(app);
    });
    group.append(option);
  }
  return group;
}

function sourceChip(app, kind) {
  const media = state(app)[kind];
  const needsImage = (kind === 'image' && media.mode === 'edit') || (kind === 'video' && media.mode === 'animate');
  const needsVideo = kind === 'video' && media.mode === 'edit';
  if (!needsImage && !needsVideo) return null;
  const wrap = element('div', 'media-source');
  const source = media.source && media.source.kind === (needsVideo ? 'video' : 'image') ? media.source : null;
  if (source) {
    if (source.kind === 'image') {
      const thumb = element('img', 'media-source-thumb');
      thumb.src = mediaUrl(source.id);
      thumb.alt = '';
      wrap.append(thumb);
    }
    wrap.append(element('span', 'media-source-label', source.label || (source.kind === 'image' ? 'Source image' : 'Source video')));
  } else {
    wrap.append(element('span', 'media-source-label muted', needsVideo
      ? 'Choose Edit on a generated video in the chat' : (kind === 'image' ? 'Choose the image to edit' : 'Choose the first frame')));
  }
  if (needsImage) {
    const pick = element('button', 'button secondary compact', source ? 'Change' : 'Choose image');
    pick.addEventListener('click', async () => {
      const result = await mediaBridge()?.pickImage();
      if (!result?.ok) { app.showToast(result?.error?.message || 'The image could not be used'); return; }
      if (!result.data) return;
      media.source = { id: result.data.id, kind: 'image', label: result.data.name || 'Chosen image' };
      renderMediaBar(app);
    });
    wrap.append(pick);
  }
  if (source) {
    const clear = element('button', 'button secondary compact', 'Clear');
    clear.addEventListener('click', () => { media.source = null; renderMediaBar(app); });
    wrap.append(clear);
  }
  return wrap;
}

async function saveOptions(app, kind, patch) {
  const key = kind === 'image' ? 'imageOptions' : 'videoOptions';
  app.settings[key] = { ...app.settings[key], ...patch };
  await app.persist('settings');
  renderMediaBar(app);
}

/** Shows the generation options of the selected model (or hides the bar in chat mode). */
export function renderMediaBar(app) {
  const bar = $('#media-bar');
  const kind = mediaMode(app);
  const input = $('#chat-input');
  const label = $('#send-label');
  if (label) label.textContent = kind ? `Generate ${kind}` : 'Send message';
  if (input) {
    input.placeholder = kind === 'image' ? 'Describe the image to create, or the change to make…'
      : kind === 'video' ? 'Describe the video: scene, motion, camera, style…'
        : 'Describe an idea, ask a question, or plan your next step…';
  }
  $('#attach-btn')?.toggleAttribute('hidden', Boolean(kind));
  if (!bar) return;
  if (!kind) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const model = currentMediaModel(app, kind);
  bar.hidden = false;
  if (!model) {
    const available = mediaModels(app.providerCatalog, kind).length;
    bar.replaceChildren(element('span', 'status-text', available
      ? `Choose a ${kind} model in the model menu.` : `This provider offers no ${kind} models.`));
    return;
  }
  const media = model.media;
  const saved = kind === 'image' ? app.settings.imageOptions : app.settings.videoOptions;
  const options = effectiveOptions(model, saved);
  const mode = state(app)[kind];
  // A mode the newly chosen model cannot do falls back to plain generation.
  const allowed = kind === 'image' ? { generate: true, edit: media.edit }
    : { generate: media.textToVideo, animate: media.imageToVideo, edit: media.edit, extend: false };
  if (!allowed[mode.mode]) mode.mode = kind === 'video' && !media.textToVideo && media.imageToVideo ? 'animate' : 'generate';
  const nodes = [modeSwitch(app, kind, model)];
  const source = sourceChip(app, kind);
  if (source) nodes.push(source);
  if (kind === 'image') {
    if (media.sizes.length) nodes.push(field('Size', select(media.sizes, options.size, (value) => saveOptions(app, 'image', { size: value }), 'Size')));
    if (media.qualities.length) nodes.push(field('Quality', select(media.qualities, options.quality, (value) => saveOptions(app, 'image', { quality: value }), 'Quality')));
    const counts = Array.from({ length: media.maxImages }, (_, index) => String(index + 1));
    const count = select(counts, String(options.n), (value) => saveOptions(app, 'image', { n: Number(value) }), 'Number of images');
    count.disabled = media.maxImages <= 1;
    if (count.disabled) count.title = 'This model makes one image per request.';
    nodes.push(field('Images', count));
  } else if (mode.mode !== 'edit') {
    if (media.aspectRatios.length) nodes.push(field('Aspect', select(media.aspectRatios, options.aspectRatio, (value) => saveOptions(app, 'video', { aspectRatio: value }), 'Aspect ratio')));
    if (media.resolutions.length) nodes.push(field('Quality', select(media.resolutions, options.resolution, (value) => saveOptions(app, 'video', { resolution: value }), 'Resolution')));
    const duration = document.createElement('input');
    duration.type = 'number';
    duration.className = 'media-number';
    duration.min = String(media.durationMin);
    duration.max = String(media.durationMax);
    duration.step = '1';
    duration.value = String(options.duration);
    duration.setAttribute('aria-label', `Duration in seconds, ${media.durationMin} to ${media.durationMax}`);
    duration.addEventListener('change', () => {
      const value = Math.round(Number(duration.value));
      if (Number.isFinite(value)) void saveOptions(app, 'video', { duration: Math.min(media.durationMax, Math.max(media.durationMin, value)) });
    });
    const wrap = field('Seconds', duration);
    nodes.push(wrap);
  }
  const cost = costEstimate(model, options);
  if (cost) {
    const note = element('span', 'media-cost', `${cost} list price`);
    note.title = kind === 'video'
      ? 'The provider reserves the full price when the job starts; discounts, if any, are applied by the provider.'
      : 'Price range of this model per the provider (depends on quality).';
    nodes.push(note);
  }
  bar.replaceChildren(...nodes);
}

// ---- Generating ----------------------------------------------------------------------

/**
 * Sends the composer text as an image or video generation. The prompt and the options appear as
 * the user's message; the result (or the error) as the reply.
 */
export async function generateFromComposer(app, text, taskId) {
  const kind = mediaMode(app);
  const bridge = mediaBridge();
  const model = currentMediaModel(app, kind);
  if (!bridge?.generate) { app.showToast('Generation needs the desktop app'); return false; }
  if (!model) { app.showToast(`Choose a ${kind} model in the model menu first`); return false; }
  const media = state(app)[kind];
  const saved = kind === 'image' ? app.settings.imageOptions : app.settings.videoOptions;
  const options = effectiveOptions(model, saved);
  const input = { requestId: `media-${taskId}-${Date.now()}`, kind, model: model.id, prompt: text, mode: media.mode, options };
  if (media.mode !== 'generate') {
    const expected = kind === 'video' && media.mode === 'edit' ? 'video' : 'image';
    if (!media.source || media.source.kind !== expected) {
      app.showToast(expected === 'video' ? 'Choose Edit on a generated video first' : 'Choose an image first');
      return false;
    }
    input.sourceId = media.source.id;
  }
  if (kind === 'video' && media.mode === 'edit') input.options = {};
  const summary = requestSummary(kind, model, media.mode, kind === 'video' && media.mode === 'edit' ? {} : options);
  app.appendMessage('user', text, taskId, { mediaRequest: summary });
  // A reply of this task like any other: the task can be left while the video renders.
  app.beginReply(taskId, input.requestId, { kind: 'media', mediaKind: kind });
  let result;
  try {
    result = await bridge.generate(input);
  } catch (error) {
    result = { ok: false, error: { message: error?.message || 'unknown error' } };
  }
  app.endReply(taskId, input.requestId, { quiet: true });
  // The task was deleted meanwhile (its generation was stopped then).
  if (!app.tasks.some((item) => item.id === taskId)) return true;
  if (!result?.ok) {
    const message = result?.error?.message || 'Generation failed';
    if (result?.error?.code === 'CANCELLED' && taskId === app.currentTaskId) app.showToast('Generation cancelled');
    app.appendMessage('assistant', result?.error?.code === 'CANCELLED' ? 'Generation cancelled.' : `Could not generate the ${kind}: ${message}`, taskId);
    return true;
  }
  const items = result.data.items || [];
  const count = items.length;
  app.appendMessage('assistant', `${kind === 'image' ? `${count} image${count === 1 ? '' : 's'}` : 'Video'} · ${model.displayName}`, taskId, { media: items });
  return true;
}

/**
 * Stops the generation of the task on screen. Resolves to main's answer ({ ok, data: stopped }),
 * or false when that task is not generating.
 */
export async function cancelGeneration(app) {
  const reply = app.currentReply?.();
  if (reply?.kind !== 'media') return false;
  return mediaBridge()?.cancel(reply.requestId) ?? false;
}

// ---- Chat display ---------------------------------------------------------------------

function useAsSource(app, item, kind) {
  const model = mediaModels(app.providerCatalog, kind).find((entry) => entry.media?.edit && entry.id === (kind === 'image' ? app.settings.imageModel : app.settings.videoModel))
    || mediaModels(app.providerCatalog, kind).find((entry) => entry.media?.edit);
  if (!model) {
    app.showToast(`No ${kind} model on this provider can edit ${kind}s`);
    return;
  }
  app.settings.composerMode = kind;
  app.settings[kind === 'image' ? 'imageModel' : 'videoModel'] = model.id;
  const media = state(app)[kind];
  media.mode = 'edit';
  media.source = { id: item.id, kind, label: kind === 'image' ? 'Image from this chat' : 'Video from this chat' };
  void app.persist('settings');
  renderModelButton(app);
  renderMediaBar(app);
  $('#chat-input')?.focus();
  app.showToast(`Describe the change to make with ${model.displayName}`);
}

/** The images / videos of a reply, each with Download and Edit. */
export function renderMediaItems(app, items) {
  const wrap = element('div', 'msg-media');
  for (const item of items) {
    if (!MEDIA_ID.test(item?.id) || !['image', 'video'].includes(item.kind)) continue;
    const figure = element('figure', `msg-media-item ${item.kind}`);
    let view;
    if (item.kind === 'image') {
      view = element('img', 'msg-media-view');
      view.alt = 'Generated image';
      view.loading = 'lazy';
    } else {
      view = element('video', 'msg-media-view');
      view.controls = true;
      view.preload = 'metadata';
      view.playsInline = true;
      view.setAttribute('aria-label', 'Generated video');
    }
    view.src = mediaUrl(item.id);
    // The transcript scrolled to the end before the file loaded; keep the end (and the Download
    // button) in view once the media has its real height, unless the user scrolled away.
    view.addEventListener(item.kind === 'image' ? 'load' : 'loadedmetadata', () => {
      const log = view.closest('#chat-messages');
      if (!log) return;
      const fromBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
      if (fromBottom <= figure.offsetHeight + 80) log.scrollTop = log.scrollHeight;
    }, { once: true });
    view.addEventListener('error', () => {
      figure.replaceChildren(element('p', 'status-text', 'This file is no longer available on this device.'));
    }, { once: true });
    const actions = element('div', 'msg-media-actions');
    const download = element('button', 'button secondary compact', 'Download');
    download.addEventListener('click', async () => {
      const result = await mediaBridge()?.save({ id: item.id });
      if (!result?.ok) app.showToast(result?.error?.message || 'Could not save the file');
      else if (result.data?.saved) app.showToast(`Saved ${result.data.name}`);
    });
    const edit = element('button', 'button secondary compact', 'Edit');
    edit.addEventListener('click', () => useAsSource(app, item, item.kind));
    const canEdit = mediaModels(app.providerCatalog, item.kind).some((entry) => entry.media?.edit);
    edit.disabled = !canEdit;
    if (!canEdit) edit.title = `No ${item.kind} model on this provider can edit ${item.kind}s.`;
    actions.append(download, edit);
    if (item.kind === 'image') {
      const animate = element('button', 'button secondary compact', 'Animate');
      const videoModel = mediaModels(app.providerCatalog, 'video').find((entry) => entry.media?.imageToVideo);
      animate.disabled = !videoModel;
      animate.title = videoModel ? `Make a video from this image with ${videoModel.displayName}` : 'No video model on this provider starts from an image.';
      animate.addEventListener('click', () => {
        app.settings.composerMode = 'video';
        if (!currentMediaModel(app, 'video')?.media?.imageToVideo) app.settings.videoModel = videoModel.id;
        const media = state(app).video;
        media.mode = 'animate';
        media.source = { id: item.id, kind: 'image', label: 'Image from this chat' };
        void app.persist('settings');
        renderModelButton(app);
        renderMediaBar(app);
        $('#chat-input')?.focus();
      });
      actions.append(animate);
    }
    figure.append(view, actions);
    wrap.append(figure);
  }
  return wrap;
}

export function bindMediaUi(app) {
  mediaBridge()?.onProgress?.((progress) => {
    const reply = app.replyFor?.(progress?.requestId);
    if (!reply || reply.kind !== 'media') return;
    reply.mediaPhase = progress.phase;
    reply.progress = Number.isFinite(progress.progress) ? progress.progress : reply.progress;
    if (reply.taskId === app.currentTaskId) tickReply(reply);
  });
  window.addEventListener('scalemax:composer-mode', () => renderMediaBar(app));
  renderMediaBar(app);
}
