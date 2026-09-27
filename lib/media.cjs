'use strict';

// Image and video generation through the configured provider (main process only).
//
//   Images: POST images/generations (or images/edits with a source image) answers with URLs or
//           base64; every result is downloaded into the app's media folder.
//   Videos: POST videos/generations (or videos/edits) answers 202 with a task id; the task is
//           polled (GET videos/:id?wait=…) until it finishes, then the mp4 is downloaded.
//
// Requests are checked against the options the model advertises in /models (sizes, qualities,
// aspect ratios, resolutions, duration range, edit / image-to-video support) before anything is
// sent, so an invalid choice never reserves credit. The API key never leaves lib/provider.cjs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PROMPT_CHARS = 4000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const VIDEO_TIMEOUT_MS = 20 * 60_000;
const POLL_WAIT_SECONDS = 20;
const MAX_REDIRECTS = 3;
const ID_PATTERN = /^m-[a-f0-9]{16}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DONE_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished', 'ready']);
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected']);
const IMAGE_TYPES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF' },
];

class MediaError extends Error {
  constructor(message, code = 'MEDIA_ERROR') {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cancelledError() {
  return new MediaError('Generation was cancelled. A job the provider already started may still be billed.', 'CANCELLED');
}

function imageType(buffer) {
  return IMAGE_TYPES.find((type) => type.test(buffer)) || null;
}

function isVideo(buffer) {
  // ISO base media (mp4/mov): "ftyp" at offset 4; WebM: EBML header.
  return (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp')
    || (buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createMediaStudio({ provider, dir, randomId = () => crypto.randomBytes(8).toString('hex'), now = Date.now } = {}) {
  if (!provider || typeof provider.mediaFetch !== 'function' || typeof provider.get !== 'function') {
    throw new TypeError('A provider with mediaFetch is required.');
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('An absolute media folder is required.');
  // requestId -> AbortController for generations in progress.
  const active = new Map();

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function metaPath(id) {
    return path.join(dir, `${id}.json`);
  }

  /** Stored metadata of a media item, or null. */
  function item(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
      if (!isRecord(meta) || meta.id !== id || !['image', 'video'].includes(meta.kind) || !/^[a-z0-9]{2,5}$/.test(meta.ext)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  /** Absolute path of a media file (for the scalemax-media: protocol and downloads), or null. */
  function filePath(id) {
    const meta = item(id);
    if (!meta) return null;
    const file = path.join(dir, `${id}.${meta.ext}`);
    return fs.existsSync(file) ? file : null;
  }

  function publicItem(meta) {
    const result = { id: meta.id, kind: meta.kind, mime: meta.mime, model: meta.model || null, source: meta.source };
    if (meta.name) result.name = meta.name;
    if (meta.width) result.width = meta.width;
    return result;
  }

  function writeItem(buffer, fields) {
    ensureDir();
    const id = `m-${randomId()}`;
    const meta = { id, ...fields, bytes: buffer.length, createdAt: now() };
    fs.writeFileSync(path.join(dir, `${id}.${fields.ext}`), buffer, { mode: 0o600 });
    fs.writeFileSync(metaPath(id), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  // ---- Network -------------------------------------------------------------------

  function linked(signal, timeoutMs) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new MediaError('The media request timed out.', 'TIMEOUT')), timeoutMs);
    timer.unref?.();
    return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
  }

  // Cancellation wins even against a fetch implementation that ignores its signal.
  function raceAbort(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof MediaError ? signal.reason : cancelledError());
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  // Follows up to three redirects by hand; mediaFetch decides whether a hop gets the key.
  async function fetchFollow(target, init, signal) {
    let url = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await raceAbort(provider.mediaFetch(url, { ...init, signal }), signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        response.body?.cancel?.().catch?.(() => {});
        if (!location) throw new MediaError('The provider redirected without a location.');
        url = new URL(location, response.url || (typeof url === 'string' && /^https?:/.test(url) ? url : undefined) || 'https://invalid.invalid/').href;
        // Only the first request may carry a body.
        init = { method: 'GET', headers: init.headers?.Accept ? { Accept: init.headers.Accept } : {} };
        continue;
      }
      return response;
    }
    throw new MediaError('The provider redirected too many times.');
  }

  async function readBytes(response, limit, signal) {
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (declared > limit) {
      response.body?.cancel?.().catch?.(() => {});
      throw new MediaError(`The file is larger than ${Math.round(limit / 1048576)} MB.`, 'TOO_LARGE');
    }
    if (!response.body?.getReader) return Buffer.from(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason;
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          reader.cancel().catch(() => {});
          throw new MediaError(`The file is larger than ${Math.round(limit / 1048576)} MB.`, 'TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* released */ }
    }
    return Buffer.concat(chunks, total);
  }

  // The provider's own error text (e.g. "insufficient credit: $0.40 needed"), key removed.
  async function failure(response, signal) {
    let message = '';
    try {
      const data = JSON.parse((await readBytes(response, 256 * 1024, signal)).toString('utf8'));
      message = typeof data?.error?.message === 'string' ? data.error.message
        : (typeof data?.message === 'string' ? data.message : '');
    } catch { /* not JSON */ }
    const shown = cleanText(provider.redact(message), 400);
    const code = response.status === 402 ? 'INSUFFICIENT_CREDIT'
      : (response.status === 401 || response.status === 403 ? 'UNAUTHORIZED'
        : (response.status === 429 ? 'RATE_LIMITED' : 'MEDIA_REQUEST_FAILED'));
    const prefix = response.status === 402 ? 'Not enough credit on this key' : `The provider refused the request (HTTP ${response.status})`;
    return new MediaError(shown ? `${prefix}: ${shown}` : `${prefix}.`, code);
  }

  async function json(route, { method = 'GET', body, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
    const scope = linked(signal, timeoutMs);
    try {
      let response;
      try {
        response = await fetchFollow(route, {
          method,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, scope.signal);
      } catch (error) {
        if (scope.signal.aborted) throw scope.signal.reason instanceof MediaError ? scope.signal.reason : cancelledError();
        if (error instanceof MediaError) throw error;
        throw new MediaError(cleanText(provider.redact(error?.message), 200) || 'Could not reach the provider.', 'NETWORK_ERROR');
      }
      if (response.status < 200 || response.status >= 300) throw await failure(response, scope.signal);
      const text = (await readBytes(response, MAX_JSON_BYTES, scope.signal)).toString('utf8');
      try {
        return { status: response.status, data: JSON.parse(text) };
      } catch {
        throw new MediaError('The provider returned invalid JSON.');
      }
    } catch (error) {
      if (scope.signal.aborted && !(error instanceof MediaError && error.code !== 'CANCELLED')) {
        throw scope.signal.reason instanceof MediaError ? scope.signal.reason : cancelledError();
      }
      throw error;
    } finally {
      scope.done();
    }
  }

  async function download(url, limit, signal) {
    const scope = linked(signal, REQUEST_TIMEOUT_MS * 3);
    try {
      const response = await fetchFollow(url, { method: 'GET', headers: {} }, scope.signal);
      if (response.status < 200 || response.status >= 300) throw await failure(response, scope.signal);
      return await readBytes(response, limit, scope.signal);
    } catch (error) {
      if (scope.signal.aborted) throw scope.signal.reason instanceof MediaError ? scope.signal.reason : cancelledError();
      throw error;
    } finally {
      scope.done();
    }
  }

  // ---- Validation ------------------------------------------------------------------

  function modelFor(kind, id) {
    const meta = provider.get();
    if (!meta.configured) throw new MediaError('Connect a provider in Assistant first.', 'NOT_CONFIGURED');
    const model = (meta.models || []).find((entry) => entry.id === id);
    if (!model || model.output !== kind || !model.media) {
      throw new MediaError(`That ${kind} model is not offered by the current provider.`, 'UNKNOWN_MODEL');
    }
    if (model.available === false) throw new MediaError('That model is currently unavailable.', 'UNAVAILABLE');
    return model;
  }

  function pick(value, allowed, label) {
    if (value === undefined || value === null || value === '') return undefined;
    if (!allowed.length || !allowed.includes(value)) throw new MediaError(`${label} must be one of: ${allowed.join(', ') || 'none'}.`, 'INVALID_OPTION');
    return value;
  }

  function sourceData(id, kind) {
    const meta = item(id);
    const file = filePath(id);
    if (!meta || !file || meta.kind !== kind) throw new MediaError(`Choose a ${kind} to use as the source.`, 'NO_SOURCE');
    return { meta, file };
  }

  function imageDataUrl(id) {
    const { meta, file } = sourceData(id, 'image');
    const buffer = fs.readFileSync(file);
    if (buffer.length > MAX_SOURCE_BYTES) throw new MediaError('The source image is larger than 20 MB.', 'TOO_LARGE');
    return `data:${meta.mime};base64,${buffer.toString('base64')}`;
  }

  /**
   * The exact request body for a generation, after checking every option against the model.
   * @returns {{route: string, body: object, model: object}}
   */
  function buildRequest(input) {
    if (!isRecord(input) || !['image', 'video'].includes(input.kind)) throw new MediaError('Choose image or video.');
    const model = modelFor(input.kind, input.model);
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new MediaError(`Describe what to generate (1-${MAX_PROMPT_CHARS} characters).`, 'INVALID_PROMPT');
    const options = isRecord(input.options) ? input.options : {};
    const mode = input.mode || 'generate';
    const media = model.media;
    if (input.kind === 'image') {
      if (!['generate', 'edit'].includes(mode)) throw new MediaError('Images can be generated or edited.');
      const body = { model: model.id, prompt };
      const size = pick(options.size, media.sizes, 'Size');
      const quality = pick(options.quality, media.qualities, 'Quality');
      if (size) body.size = size;
      if (quality) body.quality = quality;
      if (options.n !== undefined) {
        if (!Number.isSafeInteger(options.n) || options.n < 1 || options.n > media.maxImages) {
          throw new MediaError(`Number of images must be between 1 and ${media.maxImages}.`, 'INVALID_OPTION');
        }
        if (options.n > 1) body.n = options.n;
      }
      if (mode === 'edit') {
        if (!media.edit) throw new MediaError(`${model.displayName || model.id} cannot edit images.`, 'UNSUPPORTED');
        body.image = imageDataUrl(input.sourceId);
        return { route: 'images/edits', body, model };
      }
      return { route: 'images/generations', body, model };
    }
    if (!['generate', 'animate', 'edit', 'extend'].includes(mode)) throw new MediaError('Unknown video mode.');
    if (mode === 'extend' && !media.extend) throw new MediaError(`${model.displayName || model.id} cannot extend videos.`, 'UNSUPPORTED');
    if (mode === 'extend') throw new MediaError('Extending videos is not available yet.', 'UNSUPPORTED');
    const body = { model: model.id, prompt };
    if (mode === 'edit') {
      if (!media.edit) throw new MediaError(`${model.displayName || model.id} cannot edit videos.`, 'UNSUPPORTED');
      const { meta } = sourceData(input.sourceId, 'video');
      if (!meta.taskId || !TASK_ID_PATTERN.test(meta.taskId)) {
        throw new MediaError('Only videos generated with this provider can be edited.', 'NO_SOURCE');
      }
      // The API takes "video.url", "video_url" or a completed video id from this key; both the
      // provider's clip URL and its task id are sent.
      body.video_id = meta.taskId;
      if (typeof meta.remoteUrl === 'string') body.video = { url: meta.remoteUrl };
      return { route: 'videos/edits', body, model };
    }
    const aspect = pick(options.aspectRatio, media.aspectRatios, 'Aspect ratio');
    const resolution = pick(options.resolution, media.resolutions, 'Resolution');
    if (aspect) body.aspect_ratio = aspect;
    if (resolution) body.resolution = resolution;
    if (options.duration !== undefined) {
      if (!Number.isSafeInteger(options.duration) || options.duration < media.durationMin || options.duration > media.durationMax) {
        throw new MediaError(`Duration must be ${media.durationMin}-${media.durationMax} seconds.`, 'INVALID_OPTION');
      }
      body.duration = options.duration;
    }
    if (mode === 'animate') {
      if (!media.imageToVideo) throw new MediaError(`${model.displayName || model.id} cannot start from an image.`, 'UNSUPPORTED');
      body.image = imageDataUrl(input.sourceId);
    } else if (media.requiresImage) {
      throw new MediaError(`${model.displayName || model.id} needs a first-frame image.`, 'NO_SOURCE');
    }
    return { route: 'videos/generations', body, model };
  }

  // ---- Generation ------------------------------------------------------------------

  async function storeImage(entry, fields, signal) {
    let buffer;
    if (typeof entry?.b64_json === 'string' && entry.b64_json) {
      buffer = Buffer.from(entry.b64_json, 'base64');
      if (buffer.length > MAX_IMAGE_BYTES) throw new MediaError('The generated image is larger than 40 MB.', 'TOO_LARGE');
    } else if (typeof entry?.url === 'string' && entry.url) {
      const dataUrl = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(entry.url);
      buffer = dataUrl ? Buffer.from(dataUrl[1], 'base64') : await download(entry.url, MAX_IMAGE_BYTES, signal);
    } else {
      throw new MediaError('The provider returned an image without data.');
    }
    const type = imageType(buffer);
    if (!type) throw new MediaError('The provider returned a file that is not an image.');
    return writeItem(buffer, { kind: 'image', mime: type.mime, ext: type.ext, source: 'generated', ...fields });
  }

  function taskIdOf(data) {
    const id = [data?.id, data?.task_id, data?.video_id, data?.data?.id].find((value) => typeof value === 'string' && TASK_ID_PATTERN.test(value));
    if (!id) throw new MediaError('The provider did not return a video task id.');
    return id;
  }

  function statusOf(data) {
    const status = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
    const progress = Number.isFinite(data?.progress) ? Math.max(0, Math.min(100, Math.round(data.progress))) : null;
    return { status, progress };
  }

  function videoUrlOf(data, taskId) {
    const candidates = [data?.url, data?.video_url, data?.video?.url, data?.output?.url, data?.data?.[0]?.url];
    const url = candidates.find((value) => typeof value === 'string' && /^(https?:\/\/|\/)/.test(value));
    return url || `videos/${encodeURIComponent(taskId)}/content`;
  }

  async function runVideo(request, fields, signal, report) {
    const created = await json(request.route, { method: 'POST', body: request.body, signal });
    const taskId = taskIdOf(created.data);
    let state = created.data;
    const deadline = now() + VIDEO_TIMEOUT_MS;
    report({ phase: 'queued', taskId, ...statusOf(state) });
    // Finished: a terminal status, or (for providers with other status words) a result URL at 100%.
    const finished = (data) => DONE_STATUSES.has(statusOf(data).status)
      || (statusOf(data).progress === 100 && [data?.url, data?.video_url, data?.video?.url].some((value) => typeof value === 'string'));
    while (!finished(state)) {
      const { status } = statusOf(state);
      if (FAILED_STATUSES.has(status)) {
        const reason = cleanText(provider.redact(state?.error?.message || state?.error || state?.failure_reason || ''), 300);
        throw new MediaError(`The video could not be generated${reason ? `: ${reason}` : '.'}`, 'GENERATION_FAILED');
      }
      if (now() > deadline) throw new MediaError('The video took longer than 20 minutes. Check the provider dashboard.', 'TIMEOUT');
      if (signal.aborted) throw cancelledError();
      const polled = await json(`videos/${encodeURIComponent(taskId)}?wait=${POLL_WAIT_SECONDS}`, { signal, timeoutMs: (POLL_WAIT_SECONDS + 30) * 1000 });
      state = polled.data;
      report({ phase: 'generating', taskId, ...statusOf(state) });
    }
    report({ phase: 'downloading', taskId, status: 'completed', progress: 100 });
    const sourceUrl = videoUrlOf(state, taskId);
    const buffer = await download(sourceUrl, MAX_VIDEO_BYTES, signal);
    if (!isVideo(buffer)) throw new MediaError('The provider returned a file that is not a video.');
    const mp4 = buffer.toString('ascii', 4, 8) === 'ftyp';
    return writeItem(buffer, {
      kind: 'video', mime: mp4 ? 'video/mp4' : 'video/webm', ext: mp4 ? 'mp4' : 'webm', source: 'generated', taskId,
      // The provider's own address of the clip, for a later edit ("video.url").
      ...(/^https:\/\//.test(sourceUrl) ? { remoteUrl: sourceUrl.slice(0, 2048) } : {}),
      ...fields,
    });
  }

  /**
   * Generates images or a video. Resolves to { items: [{id, kind, mime, model}], request } where
   * request is the option summary shown in the chat.
   */
  async function generate(input, { onProgress } = {}) {
    const requestId = isRecord(input) && typeof input.requestId === 'string' && /^[\w:.-]{1,128}$/.test(input.requestId)
      ? input.requestId : null;
    if (!requestId) throw new MediaError('A bounded requestId is required.');
    if (active.has(requestId)) throw new MediaError('A generation with this requestId is already running.');
    const request = buildRequest(input);
    const controller = new AbortController();
    active.set(requestId, controller);
    const report = (event) => {
      try { onProgress?.({ requestId, kind: input.kind, ...event }); } catch { /* observers never break a run */ }
    };
    const fields = { model: request.model.id, prompt: request.body.prompt.slice(0, 500), mode: input.mode || 'generate' };
    try {
      report({ phase: 'starting' });
      let items;
      if (input.kind === 'image') {
        const created = await json(request.route, { method: 'POST', body: request.body, signal: controller.signal });
        const entries = Array.isArray(created.data?.data) ? created.data.data : [];
        if (!entries.length) throw new MediaError('The provider returned no images.');
        report({ phase: 'downloading' });
        items = [];
        for (const entry of entries.slice(0, 10)) items.push(await storeImage(entry, fields, controller.signal));
      } else {
        items = [await runVideo(request, fields, controller.signal, report)];
      }
      const { image: _image, ...summary } = request.body;
      return { items: items.map(publicItem), request: summary };
    } catch (error) {
      if (controller.signal.aborted) throw cancelledError();
      throw error instanceof MediaError ? error : new MediaError(cleanText(provider.redact(error?.message), 200) || 'Generation failed.');
    } finally {
      active.delete(requestId);
    }
  }

  function cancel(requestId) {
    const controller = active.get(requestId);
    if (!controller) return false;
    controller.abort(cancelledError());
    return true;
  }

  /** Copies a picked image file into the media folder so it can be previewed and used as a source. */
  function importImage(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { throw new MediaError('The image could not be read.'); }
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new MediaError('Choose an image file of at most 20 MB.', 'TOO_LARGE');
    const buffer = fs.readFileSync(file);
    const type = imageType(buffer);
    if (!type) throw new MediaError('Choose a PNG, JPEG, WebP or GIF image.', 'NOT_IMAGE');
    return publicItem(writeItem(buffer, { kind: 'image', mime: type.mime, ext: type.ext, source: 'upload', name: cleanText(path.basename(file), 120) }));
  }

  /** Copies a media file to a destination the user chose. */
  function saveAs(id, destination) {
    const file = filePath(id);
    if (!file) throw new MediaError('That file no longer exists.', 'NOT_FOUND');
    fs.copyFileSync(file, destination);
    return { saved: true };
  }

  function suggestedName(id) {
    const meta = item(id);
    if (!meta) return 'scalemax-media';
    const stamp = new Date(meta.createdAt || now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `scalemax-${meta.kind}-${stamp}.${meta.ext}`;
  }

  function closeAll() {
    for (const controller of active.values()) controller.abort(cancelledError());
    active.clear();
  }

  return { generate, cancel, item, filePath, importImage, saveAs, suggestedName, buildRequest, closeAll };
}

module.exports = { createMediaStudio, MediaError, imageType, isVideo };
