/**
 * The ScaleMax companion: a small robot-blob printed in two riso inks.
 *
 * The character is drawn twice, once per ink: ink A (fluorescent pink) and ink B (blue). The two
 * layers overprint (mix-blend-mode in mascot.css), and how well they register tells the state:
 * registered when idle or done, drifting while thinking, jittering out of register while working,
 * stuck out of register after an error. A yellow highlighter pass sits behind it while it waits
 * for the user, and a red dot marks a failure.
 *
 * mascotSpec() returns plain data, so the drawing can be tested without a DOM; renderMascot()
 * turns it into SVG nodes with createElementNS and setAttribute only; setMascotState() swaps the
 * state classes and the face in place, so the ink layers stay put and CSS animates the change
 * (the snap into register when a task finishes). Motion is CSS-only (mascot.css).
 *
 * Variants:
 *   companion  56 px, beside a reply: body, arms, antenna, a face with brows (64-unit drawing)
 *   teammate   ~20 px, a subagent: head only, same two-ink logic (32-unit drawing)
 *   mini       16 px, a sidebar task row: head only, heavier lines, eyes only (32-unit drawing)
 *
 * Layers, back to front:
 *   .mascot-highlight                     yellow highlighter pass (waiting)
 *   .mascot-figure > .mascot-ink-a        pink separation (+ cheeks, pink only)
 *                  > .mascot-ink-b        blue separation (+ chest light, blue only)
 *   .mascot-alert                         red dot (error)
 * Each ink layer: body, antenna (stem + .mascot-antenna-ball), arms, .mascot-face
 * (.mascot-eyes > .mascot-blink > eyes, .mascot-mouth, .mascot-brows).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const MASCOT_STATES = Object.freeze(['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'queued', 'stopped']);
export const MASCOT_VARIANTS = Object.freeze(['companion', 'teammate', 'mini']);
const DEFAULT_SIZES = Object.freeze({ companion: 56, teammate: 20, mini: 16 });

/** Words for each state, as captions say them ("working · 1m 12s"). */
export const MASCOT_LABELS = Object.freeze({
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'waiting for you',
  done: 'done',
  error: 'failed',
  queued: 'queued',
  stopped: 'stopped',
});

// The face for each state: eye shape, mouth and brows ('' for none).
const FACES = Object.freeze({
  idle: { eyes: 'dot', mouth: 'smile', brows: '' },
  thinking: { eyes: 'dot', mouth: 'hmm', brows: '' },
  working: { eyes: 'focus', mouth: 'smile', brows: '' },
  waiting: { eyes: 'dot', mouth: 'open', brows: 'raised' },
  done: { eyes: 'happy', mouth: 'grin', brows: '' },
  error: { eyes: 'x', mouth: 'frown', brows: 'worried' },
  queued: { eyes: 'closed', mouth: 'flat', brows: '' },
  stopped: { eyes: 'flat', mouth: 'flat', brows: '' },
});

/* ---------------------------------------------------------------- */
/* Geometry                                                          */
/* ---------------------------------------------------------------- */

// `scale` sizes the face parts, `line` is their stroke width; `stroke` and `tint` are the body's
// outline and flat-tint opacity. Mini drops the mouth, brows, cheeks and arms: at 16 px only the
// eyes and the registration read.
const HEAD_32 = 'M16 7.2C22.6 7.2 27 11.2 27 17.4C27 23.6 22.6 27.2 16 27.2C9.4 27.2 5 23.6 5 17.4C5 11.2 9.4 7.2 16 7.2Z';
const GEOMETRY = Object.freeze({
  companion: {
    view: 64, stroke: 2.4, tint: 0.2, scale: 1, line: 2.2,
    body: 'M32 14C44.2 14 51 21.2 51 32.4V42C51 50 45.4 54.5 37.4 54.5H26.6C18.6 54.5 13 50 13 42V32.4C13 21.2 19.8 14 32 14Z',
    stem: 'M32 14V8.8',
    ball: [32, 6.2, 3],
    arms: ['M13.6 38.4Q8.4 40.2 8.8 45.6', 'M50.4 38.4Q55.6 40.2 55.2 45.6'],
    eyes: [[25.4, 31.6], [38.6, 31.6]],
    mouth: [32, 39.6],
    brows: true,
    cheeks: [[20.8, 37.4, 2.6, 1.6], [43.2, 37.4, 2.6, 1.6]],
    chest: [32, 47.6, 1.7],
    highlight: 'M5 46.2L59.4 41Q61.6 40.8 61.7 42.9L61.9 51Q62 52.9 60 53.1L6.2 58Q4.1 58.2 4 56.1L3.4 48.3Q3.3 46.4 5 46.2Z',
    alert: [53, 12.2, 3.4],
  },
  teammate: {
    view: 32, stroke: 2, tint: 0.22, scale: 0.62, line: 1.6,
    body: HEAD_32,
    stem: 'M16 7.2V4.6',
    ball: [16, 3.2, 1.9],
    arms: [],
    eyes: [[12.3, 17.2], [19.7, 17.2]],
    mouth: [16, 21.9],
    brows: false,
    cheeks: [[9.2, 20.8, 1.7, 1.1], [22.8, 20.8, 1.7, 1.1]],
    chest: null,
    highlight: 'M2.4 23.4L29 20.6Q30.4 20.5 30.4 21.8L30.6 26.7Q30.6 28 29.3 28.1L3.2 30.7Q1.8 30.8 1.8 29.4L1.4 24.7Q1.3 23.5 2.4 23.4Z',
    alert: [26.8, 6.4, 2.6],
  },
  mini: {
    view: 32, stroke: 2.8, tint: 0.3, scale: 0.8, line: 2.4,
    body: 'M16 7.4C23 7.4 28 11.6 28 18.2C28 24.8 23.2 28.6 16 28.6C8.8 28.6 4 24.8 4 18.2C4 11.6 9 7.4 16 7.4Z',
    stem: 'M16 7.4V4.6',
    ball: [16, 3, 2.4],
    arms: [],
    eyes: [[11.6, 18.2], [20.4, 18.2]],
    mouth: null,
    brows: false,
    cheeks: [],
    chest: null,
    highlight: 'M1.6 23.6L29.6 20.6Q31 20.5 31 21.8L31.2 27.4Q31.2 28.7 29.9 28.8L2.4 31.6Q1 31.7 1 30.3L0.6 24.9Q0.5 23.7 1.6 23.6Z',
    alert: [27.4, 5.2, 3.6],
  },
});

/* ---------------------------------------------------------------- */
/* Shape helpers                                                     */
/* ---------------------------------------------------------------- */

const round2 = (value) => Math.round(value * 100) / 100;
const shape = (tag, attrs, className = '') => ({ tag, attrs, className });
const group = (className, children) => ({ tag: 'g', attrs: {}, className, children });
const INK = 'currentColor';
const line = (d, width, className = '') => shape('path', {
  d, fill: 'none', stroke: INK, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}, className);

/**
 * A path drawn around a centre: `segments` are [command, x1, y1, x2, y2, …] in face units, scaled
 * by `s` and moved to (cx, cy).
 */
function around(cx, cy, s, segments) {
  return segments.map(([command, ...numbers]) => command + numbers
    .map((value, index) => round2(index % 2 ? cy + value * s : cx + value * s)).join(' ')).join('');
}

function eyeShapes(kind, [cx, cy], s, width) {
  switch (kind) {
    case 'happy':
      return [line(around(cx, cy, s, [['M', -2.9, 1.3], ['Q', 0, -2.9, 2.9, 1.3]]), width)];
    case 'x':
      return [line(around(cx, cy, s, [['M', -2.2, -2.2], ['L', 2.2, 2.2], ['M', 2.2, -2.2], ['L', -2.2, 2.2]]), width)];
    case 'closed':
      return [line(around(cx, cy, s, [['M', -2.7, 0.2], ['Q', 0, 2.3, 2.7, 0.2]]), width)];
    case 'flat':
      return [line(around(cx, cy, s, [['M', -2.6, 0.4], ['L', 2.6, 0.4]]), width)];
    case 'focus':
      // Concentrating: a little narrower.
      return [shape('ellipse', { cx: round2(cx), cy: round2(cy + 0.3 * s), rx: round2(2.5 * s), ry: round2(2.2 * s), fill: INK })];
    default:
      return [shape('ellipse', { cx: round2(cx), cy: round2(cy), rx: round2(2.4 * s), ry: round2(2.9 * s), fill: INK })];
  }
}

function mouthShape(kind, [cx, cy], s, width) {
  const className = 'mascot-mouth';
  switch (kind) {
    case 'grin':
      return shape('path', { d: `${around(cx, cy, s, [['M', -4.2, -1.6], ['Q', 0, -0.4, 4.2, -1.6], ['Q', 3.6, 3.2, 0, 3.2], ['Q', -3.6, 3.2, -4.2, -1.6]])}Z`, fill: INK }, className);
    case 'open':
      return shape('ellipse', { cx: round2(cx), cy: round2(cy + 0.3 * s), rx: round2(1.8 * s), ry: round2(2.2 * s), fill: INK }, className);
    case 'frown':
      return line(around(cx, cy, s, [['M', -3.2, 1.6], ['Q', 0, -1.2, 3.2, 1.6]]), width, className);
    case 'flat':
      return line(around(cx, cy, s, [['M', -2.6, 0.2], ['L', 2.6, 0.2]]), width, className);
    case 'hmm':
      return line(around(cx, cy, s, [['M', -3, 0.6], ['Q', -1.5, -0.8, 0, 0.4], ['Q', 1.5, 1.4, 3, 0]]), width, className);
    default:
      return line(around(cx, cy, s, [['M', -3.4, -1], ['Q', 0, 2.4, 3.4, -1]]), width, className);
  }
}

function browShapes(kind, eyes, s, width) {
  if (!kind) return [];
  const [[lx, ly], [rx, ry]] = eyes;
  const lift = 6.2 * s;
  if (kind === 'worried') {
    // Inner ends raised.
    return [
      line(around(lx, ly - lift, s, [['M', -3, 1], ['L', 2.4, -0.6]]), width),
      line(around(rx, ry - lift, s, [['M', -2.4, -0.6], ['L', 3, 1]]), width),
    ];
  }
  return [
    line(around(lx, ly - lift, s, [['M', -2.8, 0.7], ['Q', 0, -1.4, 2.8, 0.7]]), width),
    line(around(rx, ry - lift, s, [['M', -2.8, 0.7], ['Q', 0, -1.4, 2.8, 0.7]]), width),
  ];
}

/** The face as shapes: eyes (in a blink group inside a look group), mouth, brows. */
function faceShapes(variant, state) {
  const geometry = GEOMETRY[variant];
  const face = FACES[state];
  const s = geometry.scale;
  const children = [
    group('mascot-eyes', [group('mascot-blink', geometry.eyes.flatMap((eye) => eyeShapes(face.eyes, eye, s, geometry.line)))]),
  ];
  if (geometry.mouth) children.push(mouthShape(face.mouth, geometry.mouth, s, geometry.line));
  if (geometry.brows && face.brows) children.push(group('mascot-brows', browShapes(face.brows, geometry.eyes, s, geometry.line * 0.85)));
  return children;
}

/** One ink's separation of the whole character. `ink` is 'a' (pink) or 'b' (blue). */
function inkLayer(variant, state, ink) {
  const geometry = GEOMETRY[variant];
  const [bx, by, br] = geometry.ball;
  const children = [
    shape('path', {
      d: geometry.body, fill: INK, 'fill-opacity': geometry.tint, stroke: INK, 'stroke-width': geometry.stroke, 'stroke-linejoin': 'round',
    }, 'mascot-body'),
    line(geometry.stem, geometry.stroke, 'mascot-antenna'),
    shape('circle', { cx: bx, cy: by, r: br, fill: INK }, 'mascot-antenna-ball'),
  ];
  geometry.arms.forEach((d, index) => {
    children.push(group(`mascot-arm mascot-arm-${index ? 'r' : 'l'}`, [line(d, round2(geometry.stroke * 1.35))]));
  });
  // Details printed in one ink only: the cheeks in pink, the chest light in blue.
  if (ink === 'a') {
    for (const [cx, cy, rx, ry] of geometry.cheeks) {
      children.push(shape('ellipse', { cx, cy, rx, ry, fill: INK, 'fill-opacity': 0.45 }, 'mascot-cheek'));
    }
  }
  if (ink === 'b' && geometry.chest) {
    const [cx, cy, r] = geometry.chest;
    children.push(shape('circle', { cx, cy, r, fill: INK }, 'mascot-chest'));
  }
  children.push(group('mascot-face', faceShapes(variant, state)));
  return group(`mascot-ink mascot-ink-${ink}`, children);
}

/* ---------------------------------------------------------------- */
/* Input                                                             */
/* ---------------------------------------------------------------- */

function read(options, key) {
  try {
    return options !== null && typeof options === 'object' ? options[key] : undefined;
  } catch {
    // Hostile input such as throwing getters or revoked proxies.
    return undefined;
  }
}

function normalizeState(value) {
  return typeof value === 'string' && MASCOT_STATES.includes(value) ? value : 'idle';
}

function normalizeVariant(value) {
  return typeof value === 'string' && MASCOT_VARIANTS.includes(value) ? value : 'companion';
}

function pixelSize(value, variant) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(512, Math.max(8, Math.round(n))) : DEFAULT_SIZES[variant];
}

/* ---------------------------------------------------------------- */
/* Public API                                                        */
/* ---------------------------------------------------------------- */

/**
 * Describes a mascot as plain data; no DOM needed.
 * @param {{state?: string, variant?: 'companion'|'teammate'|'mini', size?: number, settled?: boolean}} [options]
 *   `settled`: already in this state when drawn (a redraw), so entrance motion (the snap into
 *   register, the highlighter swipe) does not play again. Anything odd falls back to an idle
 *   companion of the default size.
 * @returns {{state: string, variant: string, size: number, viewBox: string, settled: boolean,
 *   classes: string[], className: string, label: string,
 *   face: {eyes: string, mouth: string, brows: string}, eyes: string,
 *   layers: Array<{ink: 'a'|'b', className: string, shapes: Array}>,
 *   shapes: Array<{tag: string, attrs: object, className: string, children?: Array}>}}
 */
export function mascotSpec(options = {}) {
  const state = normalizeState(read(options, 'state'));
  const variant = normalizeVariant(read(options, 'variant'));
  const size = pixelSize(read(options, 'size'), variant);
  const settled = read(options, 'settled') === true;
  const geometry = GEOMETRY[variant];
  const classes = ['mascot', `mascot--${state}`, `mascot--${variant}`, ...(settled ? ['mascot--settled'] : [])];
  const inkA = inkLayer(variant, state, 'a');
  const inkB = inkLayer(variant, state, 'b');
  const [ax, ay, ar] = geometry.alert;
  const face = FACES[state];
  return {
    state,
    variant,
    size,
    viewBox: `0 0 ${geometry.view} ${geometry.view}`,
    settled,
    classes,
    className: classes.join(' '),
    label: MASCOT_LABELS[state],
    face: { ...face, mouth: geometry.mouth ? face.mouth : '', brows: geometry.brows ? face.brows : '' },
    eyes: face.eyes,
    layers: [
      { ink: 'a', className: inkA.className, shapes: inkA.children },
      { ink: 'b', className: inkB.className, shapes: inkB.children },
    ],
    shapes: [
      shape('path', { d: geometry.highlight, fill: INK }, 'mascot-highlight'),
      group('mascot-figure', [inkA, inkB]),
      shape('circle', { cx: ax, cy: ay, r: ar, fill: INK }, 'mascot-alert'),
    ],
  };
}

function createNode(spec) {
  const node = document.createElementNS(SVG_NS, spec.tag);
  for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, String(value));
  if (spec.className) node.setAttribute('class', spec.className);
  for (const child of spec.children || []) node.appendChild(createNode(child));
  return node;
}

/**
 * Renders a mascot as a decorative inline SVG element (aria-hidden; the words around it say what
 * it shows). Takes a spec from mascotSpec(), or the same options mascotSpec() takes.
 * @returns {SVGSVGElement}
 */
export function renderMascot(spec) {
  const data = spec && typeof spec === 'object' && Array.isArray(read(spec, 'shapes')) && read(spec, 'classes')
    ? spec : mascotSpec(spec);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', data.viewBox);
  svg.setAttribute('width', String(data.size));
  svg.setAttribute('height', String(data.size));
  svg.setAttribute('class', data.className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const child of data.shapes) svg.appendChild(createNode(child));
  return svg;
}

function classesOf(el) {
  try {
    return String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/** The state a rendered mascot shows now, or null for something that is not a mascot. */
export function mascotStateOf(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const classes = classesOf(el);
  if (!classes.includes('mascot')) return null;
  return MASCOT_STATES.find((state) => classes.includes(`mascot--${state}`)) || null;
}

/**
 * Moves a rendered mascot to `state` in place: the state class is swapped and each ink's face is
 * redrawn, while the ink layers stay the same nodes, so CSS animates the change (the inks snap
 * into register on 'done'). Nothing happens when it already shows that state. Returns whether
 * `el` is a mascot.
 */
export function setMascotState(el, state) {
  const current = mascotStateOf(el);
  if (current === null && !classesOf(el).includes('mascot')) return false;
  const next = normalizeState(state);
  if (current === next) return true;
  const classes = classesOf(el);
  const variant = MASCOT_VARIANTS.find((name) => classes.includes(`mascot--${name}`)) || 'companion';
  const kept = classes.filter((name) => name !== 'mascot--settled' && !MASCOT_STATES.some((item) => name === `mascot--${item}`));
  el.setAttribute('class', [...kept, `mascot--${next}`].join(' '));
  const faces = typeof el.querySelectorAll === 'function' ? [...el.querySelectorAll('.mascot-face')] : [];
  for (const face of faces) face.replaceChildren(...faceShapes(variant, next).map(createNode));
  return true;
}

/* ---------------------------------------------------------------- */
/* What the app is doing → how the companion looks                   */
/* ---------------------------------------------------------------- */

const OUTCOME_STATES = Object.freeze({ done: 'done', failed: 'error', stopped: 'error', closed: 'error' });
const AGENT_STATES = Object.freeze({ queued: 'queued', running: 'working', done: 'done', failed: 'error', stopped: 'stopped' });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Subagents of a live reply that are still at work (src/reply-ui.js: queued or running, their
// step not finished).
function workingAgents(reply) {
  const items = Array.isArray(reply.items) ? reply.items : [];
  return items.filter((item) => isObject(item) && item.type === 'tool' && isObject(item.agent)
    && item.state !== 'ok' && item.state !== 'error' && (item.agent.status === 'queued' || item.agent.status === 'running'));
}

/**
 * Maps what the app knows to a mascot state:
 *   { outcome: 'done'|'failed'|'stopped'|'closed' }       a reply that ended → 'done' | 'error'
 *   a subagent ({ status: 'queued'|'running'|'done'|'failed'|'stopped', phase }) → teammate state
 *     ('waiting' while one of its calls waits for approval)
 *   a live reply (src/reply-ui.js createReply)  → 'waiting' while a call (its own or a
 *     subagent's) waits for approval, 'thinking' while the model has not written anything in this
 *     round (or is asked again), 'working' while it writes, prepares or runs tools; a media
 *     generation is 'working' ('thinking' while queued at the provider)
 * Anything else is 'idle'.
 */
export function companionStateFor(info) {
  if (!isObject(info)) return 'idle';
  try {
    if (typeof info.outcome === 'string') return Object.hasOwn(OUTCOME_STATES, info.outcome) ? OUTCOME_STATES[info.outcome] : 'idle';
    if (typeof info.status === 'string') {
      if (!Object.hasOwn(AGENT_STATES, info.status)) return 'idle';
      return info.status === 'running' && info.phase === 'approval' ? 'waiting' : AGENT_STATES[info.status];
    }
    if (info.kind === 'media') return info.mediaPhase === 'queued' ? 'thinking' : 'working';
    if (typeof info.phase !== 'string') return 'idle';
    const agents = workingAgents(info);
    if (info.phase === 'approval' || agents.some((item) => item.agent.phase === 'approval')) return 'waiting';
    if (agents.length && (info.phase === 'tool' || info.phase === 'working')) return 'working';
    switch (info.phase) {
      case 'writing':
      case 'preparing':
      case 'tool':
      case 'working':
        return 'working';
      default:
        return 'thinking';
    }
  } catch {
    return 'idle';
  }
}

/**
 * A sidebar task row's mini mascot, or null for an idle task (it shows nothing): its running
 * reply's state; a reply that finished while the task was not on screen is 'done', or 'error'
 * when it failed.
 */
export function taskMascotState({ reply = null, unread = false, failed = false } = {}) {
  if (isObject(reply)) return companionStateFor(reply);
  if (unread === true) return failed === true ? 'error' : 'done';
  return null;
}

// A task row's printed state tag (styles.css .sm-state-tag) for each mini mascot state.
const TASK_TAGS = Object.freeze({
  thinking: Object.freeze({ state: 'working', label: 'Working' }),
  working: Object.freeze({ state: 'working', label: 'Working' }),
  waiting: Object.freeze({ state: 'waiting', label: 'Waiting for you' }),
  done: Object.freeze({ state: 'done', label: 'Done' }),
  error: Object.freeze({ state: 'failed', label: 'Failed' }),
  queued: Object.freeze({ state: 'queued', label: 'Queued' }),
  stopped: Object.freeze({ state: 'stopped', label: 'Stopped' }),
});

/**
 * The state tag under an active sidebar task's title, from its mini mascot state (taskMascotState):
 * WORKING (thinking or working), WAITING FOR YOU, DONE (finished while away), FAILED, QUEUED or
 * STOPPED. Null for an idle task, which keeps its one line.
 * @returns {{state: 'working'|'waiting'|'done'|'failed'|'queued'|'stopped', label: string} | null}
 */
export function taskStateTag(mood) {
  return typeof mood === 'string' && Object.hasOwn(TASK_TAGS, mood) ? TASK_TAGS[mood] : null;
}

/** "working · 1m 12s": the state's words, then the time when there is one. */
export function mascotCaption(state, elapsed = '') {
  const words = MASCOT_LABELS[normalizeState(state)];
  return typeof elapsed === 'string' && elapsed ? `${words} · ${elapsed}` : words;
}
