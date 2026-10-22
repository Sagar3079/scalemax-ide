import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MASCOT_STATES, MASCOT_VARIANTS, MASCOT_LABELS, mascotSpec, renderMascot, setMascotState, mascotStateOf,
  companionStateFor, taskMascotState, taskStateTag, mascotCaption,
} from '../src/mascot.js';
import { createReply, applyProgress } from '../src/reply-ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function flatten(shapes, out = []) {
  for (const shape of shapes) {
    out.push(shape);
    if (shape.children) flatten(shape.children, out);
  }
  return out;
}
const byClass = (shapes, className) => flatten(shapes).filter((shape) => shape.className.split(' ').includes(className));
const layer = (spec, ink) => spec.shapes.find((shape) => shape.className === 'mascot-figure').children
  .find((child) => child.className.split(' ').includes(`mascot-ink-${ink}`));
// The face's shapes without their positions: what kind of eyes, mouth and brows it draws.
const faceOf = (spec, ink = 'a') => byClass([layer(spec, ink)], 'mascot-face')[0];

/* ---------------------------------------------------------------- */
/* A fake DOM: just enough for renderMascot and setMascotState       */
/* ---------------------------------------------------------------- */

class FakeElement {
  constructor(namespace, tag, created) {
    this.namespace = namespace;
    this.tag = tag;
    this.attributes = new Map();
    this.children = [];
    created?.push(this);
  }

  setAttribute(name, value) {
    assert.equal(typeof value, 'string', `${name} is set as a string`);
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.replaced = (this.replaced || 0) + 1;
    this.children = nodes;
  }

  get classes() {
    return (this.getAttribute('class') || '').split(' ').filter(Boolean);
  }

  // Class selectors only (".a" or ".a .b" descendants).
  querySelectorAll(selector) {
    const wanted = selector.trim().split(/\s+/).map((part) => part.replace(/^\./, ''));
    const found = [];
    const walk = (node, depth) => {
      for (const child of node.children) {
        const level = child.classes.includes(wanted[depth]) ? depth + 1 : depth;
        if (level === wanted.length) found.push(child);
        else walk(child, level);
      }
    };
    walk(this, 0);
    return found;
  }

  set innerHTML(value) { throw new Error('markup assignment'); }

  set outerHTML(value) { throw new Error('markup assignment'); }

  insertAdjacentHTML() { throw new Error('markup insertion'); }
}

function withFakeDocument(run) {
  const created = [];
  const fakeDocument = {
    createElementNS: (namespace, tag) => new FakeElement(namespace, tag, created),
    createElement() { throw new Error('use createElementNS'); },
  };
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    return run(created);
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
}

const allFakes = (node, out = []) => {
  out.push(node);
  for (const child of node.children) allFakes(child, out);
  return out;
};

/* ---------------------------------------------------------------- */
/* Specs                                                             */
/* ---------------------------------------------------------------- */

test('exports the states, variants and their words', () => {
  assert.deepEqual([...MASCOT_STATES], ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'queued', 'stopped']);
  assert.deepEqual([...MASCOT_VARIANTS], ['companion', 'teammate', 'mini']);
  for (const state of MASCOT_STATES) assert.equal(typeof MASCOT_LABELS[state], 'string', state);
  assert.equal(MASCOT_LABELS.waiting, 'waiting for you');
  assert.equal(MASCOT_LABELS.error, 'failed');
  assert.ok(Object.isFrozen(MASCOT_STATES) && Object.isFrozen(MASCOT_LABELS));
});

test('every state and variant is the same character printed twice, in ink A and ink B', () => {
  for (const variant of MASCOT_VARIANTS) {
    for (const state of MASCOT_STATES) {
      const spec = mascotSpec({ state, variant });
      assert.equal(spec.state, state);
      assert.equal(spec.variant, variant);
      assert.deepEqual(spec.classes, ['mascot', `mascot--${state}`, `mascot--${variant}`]);
      assert.equal(spec.className, `mascot mascot--${state} mascot--${variant}`);
      assert.equal(spec.label, MASCOT_LABELS[state]);
      assert.match(spec.viewBox, variant === 'companion' ? /^0 0 64 64$/ : /^0 0 32 32$/);
      // Highlighter at the back, the two inks in one figure, the red dot on top.
      assert.deepEqual(spec.shapes.map((shape) => shape.className), ['mascot-highlight', 'mascot-figure', 'mascot-alert']);
      assert.deepEqual(spec.layers.map((item) => item.ink), ['a', 'b']);
      assert.deepEqual(spec.layers.map((item) => item.className), ['mascot-ink mascot-ink-a', 'mascot-ink mascot-ink-b']);
      const a = layer(spec, 'a');
      const b = layer(spec, 'b');
      assert.deepEqual(spec.layers[0].shapes, a.children, 'layers are the drawn ink groups');
      // Same body, antenna and face in both inks: registered, they read as one print.
      for (const className of ['mascot-body', 'mascot-antenna', 'mascot-antenna-ball', 'mascot-face']) {
        assert.deepEqual(byClass([a], className), byClass([b], className), `${variant} ${state} ${className}`);
        assert.equal(byClass([a], className).length, 1, `${variant} ${state} has one ${className}`);
      }
      assert.equal(byClass([a], 'mascot-eyes').length, 1);
      assert.equal(byClass([a], 'mascot-blink').length, 1, 'eyes blink inside a group of their own');
      // Inks are currentColor: mascot.css gives each layer its ink.
      for (const shape of flatten([a, b])) {
        if (shape.tag === 'g') continue;
        assert.ok(shape.attrs.fill === 'currentColor' || shape.attrs.stroke === 'currentColor', `${shape.className} uses currentColor`);
      }
    }
  }
});

test('the companion has arms, cheeks in pink only and a chest light in blue only; the small ones are heads', () => {
  const companion = mascotSpec({ variant: 'companion' });
  assert.equal(byClass([layer(companion, 'a')], 'mascot-arm').length, 2);
  assert.equal(byClass([layer(companion, 'a')], 'mascot-arm-l').length, 1);
  assert.equal(byClass([layer(companion, 'a')], 'mascot-arm-r').length, 1);
  assert.equal(byClass([layer(companion, 'a')], 'mascot-cheek').length, 2);
  assert.equal(byClass([layer(companion, 'b')], 'mascot-cheek').length, 0);
  assert.equal(byClass([layer(companion, 'b')], 'mascot-chest').length, 1);
  assert.equal(byClass([layer(companion, 'a')], 'mascot-chest').length, 0);
  for (const variant of ['teammate', 'mini']) {
    const spec = mascotSpec({ variant });
    assert.equal(byClass(spec.shapes, 'mascot-arm').length, 0, `${variant} is head only`);
    assert.equal(byClass(spec.shapes, 'mascot-brows').length, 0);
  }
  assert.equal(byClass(mascotSpec({ variant: 'mini' }).shapes, 'mascot-mouth').length, 0, 'mini shows the eyes only');
  assert.equal(byClass([layer(mascotSpec({ variant: 'teammate' }), 'a')], 'mascot-mouth').length, 1);
});

test('the face follows the state: happy arcs when done, X eyes and worried brows on an error', () => {
  const eyes = (state, variant = 'companion') => mascotSpec({ state, variant }).eyes;
  assert.equal(eyes('idle'), 'dot');
  assert.equal(eyes('working'), 'focus');
  assert.equal(eyes('done'), 'happy');
  assert.equal(eyes('error'), 'x');
  assert.equal(eyes('queued'), 'closed');
  assert.equal(eyes('stopped'), 'flat');
  assert.deepEqual(mascotSpec({ state: 'error' }).face, { eyes: 'x', mouth: 'frown', brows: 'worried' });
  assert.deepEqual(mascotSpec({ state: 'waiting' }).face, { eyes: 'dot', mouth: 'open', brows: 'raised' });
  assert.deepEqual(mascotSpec({ state: 'error', variant: 'mini' }).face, { eyes: 'x', mouth: '', brows: '' });
  // Dot eyes are filled; happy, X, closed and flat eyes are lines.
  const blink = (state) => byClass([faceOf(mascotSpec({ state }))], 'mascot-blink')[0].children;
  assert.deepEqual(blink('idle').map((shape) => shape.tag), ['ellipse', 'ellipse']);
  assert.deepEqual(blink('working').map((shape) => shape.tag), ['ellipse', 'ellipse'], 'focused: narrower dots');
  for (const state of ['done', 'error', 'queued', 'stopped']) {
    assert.ok(blink(state).every((shape) => shape.tag === 'path' && shape.attrs.fill === 'none'), state);
  }
  assert.equal(byClass([faceOf(mascotSpec({ state: 'error' }))], 'mascot-brows').length, 1);
  assert.equal(byClass([faceOf(mascotSpec({ state: 'idle' }))], 'mascot-brows').length, 0);
  // Every state draws a different face on the companion.
  const faces = MASCOT_STATES.map((state) => JSON.stringify(faceOf(mascotSpec({ state }))));
  assert.equal(new Set(faces).size, MASCOT_STATES.length);
});

test('sizes default per variant, settle on request, and bad input falls back to an idle companion', () => {
  assert.equal(mascotSpec({ variant: 'companion' }).size, 56);
  assert.equal(mascotSpec({ variant: 'teammate' }).size, 20);
  assert.equal(mascotSpec({ variant: 'mini' }).size, 16);
  assert.equal(mascotSpec({ size: 40 }).size, 40);
  assert.equal(mascotSpec({ size: '24' }).size, 24);
  assert.equal(mascotSpec({ size: 2 }).size, 8);
  assert.equal(mascotSpec({ size: 9000 }).size, 512);
  assert.equal(mascotSpec({ variant: 'mini', size: -3 }).size, 16);
  assert.equal(mascotSpec({ variant: 'mini', size: 'big' }).size, 16);
  const settled = mascotSpec({ state: 'done', settled: true });
  assert.equal(settled.settled, true);
  assert.match(settled.className, /\bmascot--settled\b/);
  assert.doesNotMatch(mascotSpec({ state: 'done' }).className, /settled/);
  const bad = [undefined, null, 0, 'working', [], {}, { state: 'exploded', variant: 'giant' }, { state: 42 },
    { get state() { throw new Error('boom'); } }, new Proxy({}, { get() { throw new Error('trap'); } })];
  for (const input of bad) {
    const spec = mascotSpec(input);
    assert.equal(spec.state, 'idle');
    assert.equal(spec.variant, 'companion');
    assert.equal(spec.size, 56);
  }
  assert.deepEqual(mascotSpec({ state: 'working', variant: 'teammate' }), mascotSpec({ state: 'working', variant: 'teammate' }));
});

test('shapes are plain, safe SVG data', () => {
  const tags = new Set(['g', 'circle', 'ellipse', 'path']);
  for (const variant of MASCOT_VARIANTS) {
    for (const state of MASCOT_STATES) {
      for (const shape of flatten(mascotSpec({ state, variant }).shapes)) {
        assert.ok(tags.has(shape.tag), shape.tag);
        assert.match(shape.className, /^[a-z -]*$/);
        for (const [name, value] of Object.entries(shape.attrs)) {
          assert.match(name, /^[a-z][a-zA-Z-]*$/);
          assert.notEqual(name, 'id', 'no element ids (many mascots share a page)');
          assert.ok(!name.startsWith('on'), 'no event handlers');
          assert.ok(['string', 'number'].includes(typeof value));
          const text = String(value);
          assert.ok(!text.includes('<') && !text.includes('>') && !text.includes('url('), `${name}=${text}`);
          assert.ok(!/NaN|undefined|Infinity/.test(text), `${name}=${text}`);
        }
      }
    }
  }
});

/* ---------------------------------------------------------------- */
/* Rendering and changing state                                      */
/* ---------------------------------------------------------------- */

test('mascot.js builds nodes without markup strings', () => {
  const source = readFileSync(new URL('../src/mascot.js', import.meta.url), 'utf8');
  for (const banned of ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'DOM' + 'Parser', 'createContextual' + 'Fragment', 'document.' + 'write', '.style']) {
    assert.ok(!source.includes(banned), `mascot.js must not use ${banned}`);
  }
  assert.match(source, /createElementNS\(/);
});

test('renderMascot creates namespaced, decorative SVG with setAttribute only', () => {
  withFakeDocument((created) => {
    const spec = mascotSpec({ state: 'working', variant: 'teammate', size: 22 });
    const svg = renderMascot(spec);
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 32 32');
    assert.equal(svg.getAttribute('width'), '22');
    assert.equal(svg.getAttribute('height'), '22');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('focusable'), 'false');
    assert.equal(svg.getAttribute('class'), 'mascot mascot--working mascot--teammate');
    assert.ok(created.every((node) => node.namespace === SVG_NS));
    assert.ok(created.every((node) => !node.attributes.has('id') && !node.attributes.has('style')));
    assert.equal(created.length, flatten(spec.shapes).length + 1, 'one node per shape');
    assert.equal(svg.querySelectorAll('.mascot-ink').length, 2);
    // Options work in place of a spec.
    const companion = renderMascot({ state: 'waiting' });
    assert.equal(companion.getAttribute('class'), 'mascot mascot--waiting mascot--companion');
    assert.equal(companion.getAttribute('width'), '56');
    assert.equal(renderMascot(null).getAttribute('class'), 'mascot mascot--idle mascot--companion');
  });
});

test('setMascotState swaps the state class and redraws each ink\'s face in place', () => {
  withFakeDocument(() => {
    const svg = renderMascot(mascotSpec({ state: 'working', variant: 'companion', settled: true }));
    const inks = svg.querySelectorAll('.mascot-ink');
    const faces = svg.querySelectorAll('.mascot-face');
    assert.equal(faces.length, 2);
    assert.equal(mascotStateOf(svg), 'working');

    assert.equal(setMascotState(svg, 'done'), true);
    assert.equal(svg.getAttribute('class'), 'mascot mascot--companion mascot--done', 'settled is dropped so the snap plays');
    assert.equal(mascotStateOf(svg), 'done');
    // The ink layers are the same nodes (CSS animates them); only the faces were redrawn.
    assert.deepEqual(svg.querySelectorAll('.mascot-ink'), inks);
    assert.ok(faces.every((face) => face.replaced === 1));
    const drawn = mascotSpec({ state: 'done' });
    for (const face of faces) {
      const blink = face.querySelectorAll('.mascot-blink')[0];
      assert.deepEqual(blink.children.map((node) => node.getAttribute('d')),
        byClass([faceOf(drawn)], 'mascot-blink')[0].children.map((shape) => shape.attrs.d), 'happy eyes');
      assert.ok(allFakes(face).every((node) => node.namespace === SVG_NS));
    }

    // Already there: nothing changes (no restarted animation).
    assert.equal(setMascotState(svg, 'done'), true);
    assert.ok(faces.every((face) => face.replaced === 1));
    // An unknown state rests.
    setMascotState(svg, 'exploded');
    assert.equal(mascotStateOf(svg), 'idle');
    // The variant decides the face: a mini has no mouth.
    const mini = renderMascot(mascotSpec({ state: 'working', variant: 'mini' }));
    setMascotState(mini, 'error');
    assert.equal(mini.getAttribute('class'), 'mascot mascot--mini mascot--error');
    assert.equal(mini.querySelectorAll('.mascot-mouth').length, 0);
    assert.equal(mini.querySelectorAll('.mascot-face')[0].querySelectorAll('.mascot-blink')[0].children.length, 2);
  });
  // Not a mascot: refused, untouched.
  const other = new FakeElement(SVG_NS, 'svg');
  other.setAttribute('class', 'expert-avatar-svg');
  assert.equal(setMascotState(other, 'done'), false);
  assert.equal(other.getAttribute('class'), 'expert-avatar-svg');
  assert.equal(setMascotState(null, 'done'), false);
  assert.equal(setMascotState({}, 'done'), false);
  assert.equal(mascotStateOf(other), null);
});

/* ---------------------------------------------------------------- */
/* What the app is doing → how the mascot looks                      */
/* ---------------------------------------------------------------- */

test('a live reply maps to thinking, working and waiting as it goes', () => {
  const R = 'chat-t1-1';
  const reply = createReply({ taskId: 't1', requestId: R, thinking: true });
  const step = (event) => applyProgress(reply, { requestId: R, ...event });
  assert.equal(companionStateFor(reply), 'thinking', 'nothing written yet');
  step({ phase: 'thinking', round: 0 });
  step({ phase: 'delta', kind: 'reasoning', text: 'Hmm.' });
  assert.equal(companionStateFor(reply), 'thinking', 'its thinking is still thinking');
  step({ phase: 'delta', kind: 'text', text: 'Let me look.' });
  assert.equal(companionStateFor(reply), 'working');
  step({ phase: 'preparing', serverId: 'Workspace', toolName: 'write_file' });
  assert.equal(companionStateFor(reply), 'working');
  step({ phase: 'approval', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' });
  assert.equal(companionStateFor(reply), 'waiting');
  step({ phase: 'tool', callId: 'step-1', title: 'Wrote a.md', serverId: 'Workspace', toolName: 'write_file' });
  assert.equal(companionStateFor(reply), 'working');
  step({ phase: 'tool-done', callId: 'step-1', ok: true });
  assert.equal(companionStateFor(reply), 'working');
  step({ phase: 'thinking', round: 1 });
  assert.equal(companionStateFor(reply), 'thinking', 'waiting for the model again');
  step({ phase: 'retry', attempt: 1 });
  assert.equal(companionStateFor(reply), 'thinking');
  // A subagent asking for approval makes the whole reply wait for the user.
  step({ phase: 'tool', callId: 'step-2', title: 'Subagent: Look', serverId: 'Agents', toolName: 'agent_task' });
  step({ phase: 'subagent', callId: 'step-2', status: 'running', description: 'Look', kind: 'explore' });
  assert.equal(companionStateFor(reply), 'working');
  step({ phase: 'subagent', callId: 'step-2', event: { phase: 'approval', callId: 'step-1', title: 'Ran ls', serverId: 'Workspace', toolName: 'run_command' } });
  assert.equal(companionStateFor(reply), 'waiting');
  assert.equal(companionStateFor(reply.items.find((item) => item.agent).agent), 'waiting', 'and its teammate');
  step({ phase: 'subagent', callId: 'step-2', event: { phase: 'tool', callId: 'step-1', title: 'Ran ls', serverId: 'Workspace', toolName: 'run_command' } });
  assert.equal(companionStateFor(reply), 'working');
  // Image and video generation.
  const media = createReply({ taskId: 't1', requestId: 'media-1', kind: 'media', mediaKind: 'video' });
  assert.equal(companionStateFor(media), 'working');
  media.mediaPhase = 'queued';
  assert.equal(companionStateFor(media), 'thinking');
});

test('outcomes, subagent statuses and sidebar tasks map to their states', () => {
  assert.equal(companionStateFor({ outcome: 'done' }), 'done');
  for (const outcome of ['failed', 'stopped', 'closed']) assert.equal(companionStateFor({ outcome }), 'error', outcome);
  assert.equal(companionStateFor({ outcome: 'weird' }), 'idle');
  assert.deepEqual(['queued', 'running', 'done', 'failed', 'stopped'].map((status) => companionStateFor({ status })),
    ['queued', 'working', 'done', 'error', 'stopped']);
  assert.equal(companionStateFor({ status: 'running', phase: 'approval' }), 'waiting');
  assert.equal(companionStateFor({ status: 'exploded' }), 'idle');
  for (const input of [undefined, null, 'working', 42, [], {}, { phase: 7 }, new Proxy({}, { get() { throw new Error('trap'); } })]) {
    assert.equal(companionStateFor(input), 'idle');
  }

  const reply = createReply({ taskId: 't', requestId: 'r' });
  applyProgress(reply, { phase: 'approval', callId: 'c', title: 'Ran ls', serverId: 'Workspace', toolName: 'run_command' });
  assert.equal(taskMascotState({ reply }), 'waiting', 'a task whose approval is pending waits for you');
  assert.equal(taskMascotState({ unread: true }), 'done', 'finished while away');
  assert.equal(taskMascotState({ unread: true, failed: true }), 'error');
  assert.equal(taskMascotState({}), null, 'idle tasks show nothing');
  assert.equal(taskMascotState(), null);
});

test('captions say the state and the time', () => {
  assert.equal(mascotCaption('working', '1m 12s'), 'working · 1m 12s');
  assert.equal(mascotCaption('waiting', '4s'), 'waiting for you · 4s');
  assert.equal(mascotCaption('error'), 'failed');
  assert.equal(mascotCaption('nonsense', 3), 'idle');
});

/* ---------------------------------------------------------------- */
/* mascot.css                                                        */
/* ---------------------------------------------------------------- */

test('mascot.css animates only transform and opacity, and goes still when asked', () => {
  const css = readFileSync(new URL('../src/mascot.css', import.meta.url), 'utf8');
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
  assert.ok(keyframes.length >= 12);
  for (const [, name, body] of keyframes) {
    for (const [, property] of body.matchAll(/([a-z-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity'].includes(property), `${name} animates ${property}`);
    }
    assert.match(css, new RegExp(`animation:\\s*${name}\\b`), `${name} is used`);
  }
  for (const [, property] of css.matchAll(/transition:\s*([a-z-]+)/g)) {
    assert.ok(['transform', 'opacity', 'none'].includes(property), `transition on ${property}`);
  }
  // Reduced motion stops everything; the states read from static offsets, faces and colours.
  const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedAt >= 0);
  assert.match(css.slice(reducedAt), /\.mascot \*\s*\{\s*animation:\s*none !important;\s*transition:\s*none !important;/);
  assert.match(css, /\.mascot--working \.mascot-ink-a \{\s*transform: translate\(/, 'working is out of register without motion too');
  assert.match(css, /\.mascot--error \.mascot-ink-b \{\s*transform: translate\(/);
  assert.match(css, /\.mascot--error \.mascot-alert \{\s*opacity: 1;/);
  assert.match(css, /\.mascot--waiting \.mascot-highlight \{\s*opacity: 1;/);
  // Off, hidden window, the snap that plays once, and the overprint in both themes.
  assert.match(css, /body\.companion-off \.mascot,/);
  assert.match(css, /body\.mascots-paused \.mascot \*\s*\{\s*animation-play-state: paused !important;/);
  assert.match(css, /\.mascot--done:not\(\.mascot--settled\) \.mascot-ink-a \{\s*animation: mascot-snap-a/);
  assert.match(css, /\.mascot-ink \{\s*mix-blend-mode: multiply;/);
  assert.match(css, /\[data-theme="dark"\] \.mascot-ink \{\s*mix-blend-mode: screen;/);
  // The shared riso tokens, each with a fallback while they are not defined.
  for (const token of ['--riso-pink', '--riso-blue', '--riso-yellow', '--riso-red', '--sm-mascot-ink-a', '--sm-mascot-ink-b', '--sm-ease-out', '--sm-font-display']) {
    assert.match(css, new RegExp(`var\\(${token},`), `${token} has a fallback`);
  }
  assert.match(css, /\.reply-companion-caption \{[^}]*font-size: 11px;/);
});

test('an active task row prints its state as a tag; idle rows get none', () => {
  assert.deepEqual(taskStateTag('thinking'), { state: 'working', label: 'Working' });
  assert.deepEqual(taskStateTag('working'), { state: 'working', label: 'Working' });
  assert.deepEqual(taskStateTag('waiting'), { state: 'waiting', label: 'Waiting for you' });
  assert.deepEqual(taskStateTag('done'), { state: 'done', label: 'Done' });
  assert.deepEqual(taskStateTag('error'), { state: 'failed', label: 'Failed' });
  assert.deepEqual(taskStateTag('stopped'), { state: 'stopped', label: 'Stopped' });
  // Every mini mascot state a row can show has a tag.
  for (const mood of [taskMascotState({ unread: true }), taskMascotState({ unread: true, failed: true })]) {
    assert.ok(taskStateTag(mood));
  }
  for (const odd of [null, undefined, 'idle', '', 'constructor', '__proto__', 7, {}]) assert.equal(taskStateTag(odd), null);
});
