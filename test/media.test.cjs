'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaStudio } = require('../lib/media.cjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(128, 2)]);

const IMAGE_MODEL = {
  id: 'gpt-image-2', displayName: 'ScaleMax Image 2', output: 'image', chat: false, available: true,
  media: { kind: 'image', sizes: ['1024x1024', '1536x864'], qualities: ['low', 'medium', 'high'], maxImages: 1, edit: true, pricing: { min: 0.012, max: 0.422 } },
};
const BATCH_MODEL = {
  id: 'grok-imagine-image', displayName: 'Grok Imagine Image', output: 'image', chat: false, available: true,
  media: { kind: 'image', sizes: ['1:1', '16:9'], qualities: ['low'], maxImages: 4, edit: true, pricing: { min: 0.006, max: 0.2 } },
};
const NO_EDIT_MODEL = { ...IMAGE_MODEL, id: 'flux-2-pro', media: { ...IMAGE_MODEL.media, edit: false } };
const VIDEO_MODEL = {
  id: 'grok-imagine-video', displayName: 'Grok Imagine Video', output: 'video', chat: false, available: true,
  media: {
    kind: 'video', aspectRatios: ['1:1', '16:9'], resolutions: ['480p', '720p'], textToVideo: true, imageToVideo: true,
    requiresImage: false, edit: true, extend: false, durationMin: 1, durationMax: 15, defaultDuration: 6,
    pricing: { perSecond: { '480p': 0.05 }, discountPercent: null },
  },
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A provider stand-in: mediaFetch is answered by `routes` ("METHOD target" → response or function).
function fakeProvider(routes) {
  const calls = [];
  return {
    calls,
    get: () => ({ configured: true, models: [IMAGE_MODEL, BATCH_MODEL, NO_EDIT_MODEL, VIDEO_MODEL] }),
    redact: (text) => String(text).split('sm_live_secret').join('[redacted]'),
    async mediaFetch(target, init = {}) {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, target, body });
      const key = Object.keys(routes).find((pattern) => {
        const [m, t] = pattern.split(' ');
        return m === method && (t.endsWith('*') ? target.startsWith(t.slice(0, -1)) : target === t);
      });
      if (!key) return json(404, { error: { message: 'not found' } });
      const route = routes[key];
      return typeof route === 'function' ? route({ target, body, calls }) : route.clone();
    },
  };
}

// Polls are spaced 1 ms apart here instead of 3 s, so the video tests stay fast.
function studio(t, routes, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let counter = 0;
  const provider = fakeProvider(routes);
  const media = createMediaStudio({
    provider, dir, randomId: () => (counter++).toString(16).padStart(16, '0'), now: () => 1_700_000_000_000, pollIntervalMs: 1, ...options,
  });
  return { media, provider, dir };
}

test('requests are checked against the model before anything is sent', (t) => {
  const { media, provider } = studio(t, {});
  const ask = (input) => () => media.buildRequest({ kind: 'image', model: 'gpt-image-2', prompt: 'a cat', ...input });
  assert.deepEqual(ask({ options: { size: '1536x864', quality: 'low' } })().body, { model: 'gpt-image-2', prompt: 'a cat', size: '1536x864', quality: 'low' });
  assert.throws(ask({ options: { size: '7x7' } }), /Size must be one of: 1024x1024, 1536x864/);
  assert.throws(ask({ options: { quality: 'ultra' } }), /Quality must be one of/);
  assert.throws(ask({ options: { n: 2 } }), /between 1 and 1/);
  assert.throws(ask({ prompt: '   ' }), /Describe what to generate/);
  assert.throws(ask({ model: 'deepseek-v4-flash' }), /not offered/);
  assert.throws(ask({ model: 'flux-2-pro', mode: 'edit', sourceId: 'm-0000000000000000' }), /cannot edit images/);
  assert.equal(media.buildRequest({ kind: 'image', model: 'grok-imagine-image', prompt: 'x', options: { n: 3 } }).body.n, 3);
  const video = (options, extra = {}) => () => media.buildRequest({ kind: 'video', model: 'grok-imagine-video', prompt: 'waves', options, ...extra });
  assert.deepEqual(video({ aspectRatio: '16:9', resolution: '480p', duration: 2 })().body, {
    model: 'grok-imagine-video', prompt: 'waves', aspect_ratio: '16:9', resolution: '480p', duration: 2,
  });
  assert.equal(video({})().route, 'videos/generations');
  assert.throws(video({ resolution: '1080p' }), /Resolution must be one of: 480p, 720p/);
  assert.throws(video({ duration: 16 }), /Duration must be 1-15 seconds/);
  assert.throws(video({}, { mode: 'extend' }), /cannot extend/);
  assert.equal(provider.calls.length, 0);
});

test('images: base64 and URL results are stored, typed by content, and the source image is sent for edits', async (t) => {
  const { media, provider, dir } = studio(t, {
    'POST images/generations': () => json(200, { data: [{ b64_json: PNG.toString('base64') }] }),
    'POST images/edits': () => json(200, { data: [{ url: 'https://cdn.example.com/out.png' }] }),
    'GET https://cdn.example.com/out.png': () => new Response(PNG, { status: 200 }),
  });
  const progress = [];
  const made = await media.generate({ requestId: 'g1', kind: 'image', model: 'gpt-image-2', prompt: 'a cat', options: { quality: 'low' } },
    { onProgress: (event) => progress.push(event.phase) });
  assert.deepEqual(made.request, { model: 'gpt-image-2', prompt: 'a cat', quality: 'low' });
  assert.equal(made.items.length, 1);
  const [image] = made.items;
  assert.deepEqual(image, { id: 'm-0000000000000000', kind: 'image', mime: 'image/png', model: 'gpt-image-2', source: 'generated' });
  assert.deepEqual(progress, ['starting', 'downloading']);
  assert.deepEqual(fs.readFileSync(media.filePath(image.id)), PNG);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, `${image.id}.png`)).mode & 0o777, 0o600);

  const edited = await media.generate({ requestId: 'g2', kind: 'image', model: 'gpt-image-2', prompt: 'make it blue', mode: 'edit', sourceId: image.id });
  const edit = provider.calls.find((call) => call.target === 'images/edits');
  assert.equal(edit.body.image, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(edited.request.image, undefined, 'the source image is not echoed back');
  assert.equal(edited.items[0].mime, 'image/png');
});

test('video: the task is polled until it completes, then the mp4 is downloaded', async (t) => {
  let polls = 0;
  const { media, provider } = studio(t, {
    'POST videos/generations': () => json(202, { id: 'vid_123', status: 'queued' }),
    'GET videos/vid_123?wait=20': () => {
      polls += 1;
      return json(200, polls < 2 ? { id: 'vid_123', status: 'in_progress', progress: 40 } : { id: 'vid_123', status: 'completed', url: 'https://api.scalemax.pro/v1/videos/vid_123/content' });
    },
    'GET https://api.scalemax.pro/v1/videos/vid_123/content': () => new Response(MP4, { status: 200 }),
  });
  const phases = [];
  const made = await media.generate({ requestId: 'v1', kind: 'video', model: 'grok-imagine-video', prompt: 'waves', options: { resolution: '480p', duration: 2 } },
    { onProgress: (event) => phases.push(`${event.phase}${event.progress === null || event.progress === undefined ? '' : `:${event.progress}`}`) });
  assert.equal(made.items[0].mime, 'video/mp4');
  assert.deepEqual(phases, ['starting', 'queued', 'generating:40', 'generating', 'downloading:100']);
  assert.deepEqual(fs.readFileSync(media.filePath(made.items[0].id)), MP4);
  assert.equal(media.item(made.items[0].id).taskId, 'vid_123');
  // An edit uses the provider's own task id of that video.
  const edit = media.buildRequest({ kind: 'video', model: 'grok-imagine-video', prompt: 'slower', mode: 'edit', sourceId: made.items[0].id });
  assert.deepEqual([edit.route, edit.body.video_id, edit.body.video], ['videos/edits', 'vid_123', { url: 'https://api.scalemax.pro/v1/videos/vid_123/content' }]);
  assert.equal(provider.calls.filter((call) => call.method === 'POST').length, 1);
});

test('failures carry the provider message without the key; a failed task stops the poll', async (t) => {
  const { media } = studio(t, {
    'POST images/generations': () => json(402, { error: { message: 'Needs $0.42 but sm_live_secret has $0.10' } }),
    'POST videos/generations': () => json(202, { id: 'vid_bad', status: 'queued' }),
    'GET videos/vid_bad?wait=20': () => json(200, { id: 'vid_bad', status: 'failed', error: { message: 'content policy' } }),
  });
  await assert.rejects(
    () => media.generate({ requestId: 'f1', kind: 'image', model: 'gpt-image-2', prompt: 'x' }),
    (error) => error.code === 'INSUFFICIENT_CREDIT' && /Not enough credit on this key: Needs \$0.42 but \[redacted\]/.test(error.message),
  );
  await assert.rejects(
    () => media.generate({ requestId: 'f2', kind: 'video', model: 'grok-imagine-video', prompt: 'x' }),
    (error) => error.code === 'GENERATION_FAILED' && /content policy/.test(error.message),
  );
});

test('a non-image payload is refused and cancel stops a running video', async (t) => {
  let release;
  const { media } = studio(t, {
    'POST images/generations': () => json(200, { data: [{ b64_json: Buffer.from('<html>not an image</html>').toString('base64') }] }),
    'POST videos/generations': () => json(202, { id: 'vid_slow', status: 'queued' }),
    'GET videos/vid_slow?wait=20': () => new Promise((resolve) => { release = () => resolve(json(200, { status: 'in_progress' })); }),
  });
  await assert.rejects(() => media.generate({ requestId: 'x1', kind: 'image', model: 'gpt-image-2', prompt: 'x' }), /not an image/);
  const running = media.generate({ requestId: 'x2', kind: 'video', model: 'grok-imagine-video', prompt: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(media.cancel('x2'), true);
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  release?.();
  assert.equal(media.cancel('x2'), false);
});

test('a failed status check does not lose the video: it is retried with a growing pause', async (t) => {
  let polls = 0;
  const { media } = studio(t, {
    'POST videos/generations': () => json(202, { id: 'vid_flaky', status: 'queued' }),
    'GET videos/vid_flaky?wait=20': () => {
      polls += 1;
      if (polls === 1) return json(503, { error: { message: 'upstream unavailable' } });
      if (polls === 2) throw new TypeError('fetch failed');
      if (polls === 3) return json(429, { error: { message: 'slow down' } });
      return json(200, { id: 'vid_flaky', status: 'completed', url: 'https://api.scalemax.pro/v1/videos/vid_flaky/content' });
    },
    'GET https://api.scalemax.pro/v1/videos/vid_flaky/content': () => new Response(MP4, { status: 200 }),
  });
  const made = await media.generate({ requestId: 'r1', kind: 'video', model: 'grok-imagine-video', prompt: 'waves' });
  assert.equal(made.items[0].mime, 'video/mp4');
  assert.equal(polls, 4);
});

test('a provider that ignores ?wait is polled at most once per interval', async (t) => {
  const times = [];
  const { media } = studio(t, {
    'POST videos/generations': () => json(202, { id: 'vid_fast', status: 'queued' }),
    'GET videos/vid_fast?wait=20': () => {
      times.push(Date.now());
      return json(200, times.length < 3 ? { status: 'in_progress' } : { status: 'completed', url: 'https://api.scalemax.pro/v1/v.mp4' });
    },
    'GET https://api.scalemax.pro/v1/v.mp4': () => new Response(MP4, { status: 200 }),
  }, { pollIntervalMs: 60 });
  await media.generate({ requestId: 'p1', kind: 'video', model: 'grok-imagine-video', prompt: 'waves' });
  assert.equal(times.length, 3);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 55, `poll gap ${times[index] - times[index - 1]} ms`);
});

test('polling gives up at the deadline with the last error, and a cancel ends the pause between checks', async (t) => {
  let clock = 1_700_000_000_000;
  const { media } = studio(t, {
    'POST videos/generations': () => json(202, { id: 'vid_down', status: 'queued' }),
    'GET videos/vid_down?wait=20': () => json(502, { error: { message: 'bad gateway' } }),
  }, { now: () => (clock += 4 * 60_000) });
  await assert.rejects(
    () => media.generate({ requestId: 'd1', kind: 'video', model: 'grok-imagine-video', prompt: 'waves' }),
    (error) => error.code === 'TIMEOUT' && /20 minutes\. The last status check failed: The provider refused the request \(HTTP 502\): bad gateway\. Check/.test(error.message),
  );

  let checks = 0;
  const slow = studio(t, {
    'POST videos/generations': () => json(202, { id: 'vid_wait', status: 'queued' }),
    'GET videos/vid_wait?wait=20': () => { checks += 1; return json(503, {}); },
  }, { pollIntervalMs: 60_000 });
  const running = slow.media.generate({ requestId: 'd2', kind: 'video', model: 'grok-imagine-video', prompt: 'waves' });
  while (checks === 0) await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  assert.equal(slow.media.cancel('d2'), true);
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.ok(Date.now() - started < 1000, 'the pause between checks is cut short');
  assert.equal(checks, 1);
});

test('307 and 308 redirects repeat the method and body; 301, 302 and 303 become a GET', async (t) => {
  const moved = (status) => () => new Response(null, { status, headers: { location: `https://api.scalemax.pro/v1/moved-${status}` } });
  const generated = () => json(200, { data: [{ b64_json: PNG.toString('base64') }] });
  for (const status of [307, 308]) {
    const { media, provider } = studio(t, {
      'POST images/generations': moved(status),
      [`POST https://api.scalemax.pro/v1/moved-${status}`]: generated,
    });
    await media.generate({ requestId: `r${status}`, kind: 'image', model: 'gpt-image-2', prompt: 'a cat' });
    assert.deepEqual(provider.calls.map((call) => [call.method, call.body]), [
      ['POST', { model: 'gpt-image-2', prompt: 'a cat' }],
      ['POST', { model: 'gpt-image-2', prompt: 'a cat' }],
    ]);
  }
  for (const status of [301, 302, 303]) {
    const { media, provider } = studio(t, {
      'POST images/generations': moved(status),
      [`GET https://api.scalemax.pro/v1/moved-${status}`]: generated,
    });
    await media.generate({ requestId: `r${status}`, kind: 'image', model: 'gpt-image-2', prompt: 'a cat' });
    assert.deepEqual(provider.calls.map((call) => [call.method, call.body]), [
      ['POST', { model: 'gpt-image-2', prompt: 'a cat' }],
      ['GET', undefined],
    ]);
  }
});

test('a batch where one image fails leaves none of the others on disk', async (t) => {
  const { media, dir } = studio(t, {
    'POST images/generations': () => json(200, {
      data: [{ b64_json: PNG.toString('base64') }, { url: 'https://cdn.example.com/broken.png' }],
    }),
    'GET https://cdn.example.com/broken.png': () => json(500, { error: { message: 'storage error' } }),
  });
  await assert.rejects(
    () => media.generate({ requestId: 'b1', kind: 'image', model: 'grok-imagine-image', prompt: 'cats', options: { n: 2 } }),
    /HTTP 500/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(media.item('m-0000000000000000'), null);
});

test('imported images and saved copies', async (t) => {
  const { media } = studio(t, {});
  const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-src-')), 'photo.png');
  fs.writeFileSync(source, PNG);
  const imported = media.importImage(source);
  assert.deepEqual([imported.kind, imported.mime, imported.source, imported.name], ['image', 'image/png', 'upload', 'photo.png']);
  const target = path.join(path.dirname(source), 'copy.png');
  assert.deepEqual(media.saveAs(imported.id, target), { saved: true });
  assert.deepEqual(fs.readFileSync(target), PNG);
  assert.match(media.suggestedName(imported.id), /^scalemax-image-2023-11-14-22-13-20\.png$/);
  fs.writeFileSync(source, 'not an image');
  assert.throws(() => media.importImage(source), /PNG, JPEG, WebP or GIF/);
  assert.equal(media.item('../../etc/passwd'), null);
  assert.equal(media.filePath('m-ffffffffffffffff'), null);
});
