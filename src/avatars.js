/**
 * ScaleMax expert avatars.
 *
 * Every expert is a friendly 2D character bust drawn as inline SVG in a 64x64
 * viewBox: a soft tinted badge, torso in the expert colour, neck, head, hair,
 * face and a role prop. avatarSpec() returns plain data so the look can be
 * tested without a DOM; renderAvatar() turns that data into SVG nodes with
 * createElementNS and setAttribute only. Motion is CSS-only (experts.css).
 *
 * Layers, back to front:
 *   .avatar-badge                 tinted circle
 *   .avatar-bob > .avatar-head    back hair, neck, ears, head, hair, face, head prop
 *   .avatar-torso + neckline      shoulders in the expert colour
 *   .avatar-prop-hand             prop held at the side
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Shared palette.
const INK = '#2a2530';
const WHITE = '#ffffff';
const STEEL = '#3a4152';
const METAL = '#cbd5e1';
const WOOD = '#c98b55';
const BLUSH = '#ff6f86';
const MOUTH = '#6b2536';
const TONGUE = '#f48a9b';

const SKIN_TONES = ['#ffe3cc', '#f6cba4', '#e8b088', '#d09565', '#b57a4e', '#96603d', '#6f4430'];
const HAIR_COLORS = ['#2b2227', '#4b2e22', '#7a4b2a', '#b7773a', '#dcb462', '#a13f2c', '#8d929c'];
const HAIR_STYLES = ['short', 'spiky', 'curly', 'long', 'bob', 'bun', 'ponytail', 'buzz'];
const TORSO_STYLES = ['crew', 'vneck', 'collar', 'hoodie', 'turtleneck'];
const MOUTH_STYLES = ['smile', 'grin'];
const BLINK_SECONDS = 5.2; // avatar-blink duration in experts.css
const BOB_SECONDS = 3.6; // avatar-bob duration in experts.css

/** Avatar style presets for the custom-expert form: { id, label, accessory }. */
export const AVATAR_STYLES = Object.freeze([
  { id: 'plain', label: 'Plain', accessory: null },
  { id: 'headphones', label: 'Headphones', accessory: 'headphones' },
  { id: 'beret', label: 'Beret', accessory: 'beret' },
  { id: 'glasses', label: 'Glasses', accessory: 'glasses' },
  { id: 'megaphone', label: 'Megaphone', accessory: 'megaphone' },
  { id: 'hardhat', label: 'Hard hat', accessory: 'hardhat' },
  { id: 'pencil', label: 'Pencil', accessory: 'pencil' },
  { id: 'shield', label: 'Shield', accessory: 'shield' },
  { id: 'clipboard', label: 'Clipboard', accessory: 'clipboard' },
].map(Object.freeze));

export { AVATAR_STYLES as AVATAR_ACCESSORY_PRESETS };

/** Torso colour presets for custom experts. */
export const AVATAR_COLORS = Object.freeze([
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b',
]);

/** Accepted avatarAccessory values, same list and order as custom-catalog.js. */
export const ACCESSORY_IDS = Object.freeze([
  ...AVATAR_STYLES.filter((style) => style.accessory).map((style) => style.accessory), null,
]);

const ACCESSORIES = new Set(ACCESSORY_IDS.filter(Boolean));
const HATS = new Set(['beret', 'hardhat']);

// Built-in experts; skin and hair are indexes into SKIN_TONES and HAIR_COLORS.
const BUILT_IN = new Map([
  ['full-stack-developer', { base: '#3b82f6', skin: 1, hair: 1, hairStyle: 'spiky', torso: 'hoodie', mouth: 'grin', accessory: 'headphones' }],
  ['ui-ux-designer', { base: '#a855f7', skin: 0, hair: 5, hairStyle: 'bob', torso: 'turtleneck', mouth: 'smile', accessory: 'beret' }],
  ['data-analyst', { base: '#06b6d4', skin: 6, hair: 0, hairStyle: 'curly', torso: 'collar', mouth: 'grin', accessory: 'glasses' }],
  ['growth-marketer', { base: '#f59e0b', skin: 2, hair: 2, hairStyle: 'ponytail', torso: 'vneck', mouth: 'grin', accessory: 'megaphone' }],
  ['devops-engineer', { base: '#ef4444', skin: 5, hair: 0, hairStyle: 'buzz', torso: 'crew', mouth: 'smile', accessory: 'hardhat' }],
  ['copywriter', { base: '#10b981', skin: 3, hair: 6, hairStyle: 'bun', torso: 'turtleneck', mouth: 'smile', accessory: 'pencil' }],
  ['security-auditor', { base: '#475569', skin: 4, hair: 0, hairStyle: 'short', torso: 'collar', mouth: 'smile', accessory: 'shield' }],
  ['product-manager', { base: '#ec4899', skin: 1, hair: 4, hairStyle: 'long', torso: 'vneck', mouth: 'grin', accessory: 'clipboard' }],
]);
const BUILT_IN_IDS = [...BUILT_IN.keys()];

/* ---------------------------------------------------------------- */
/* Seeds and colours                                                 */
/* ---------------------------------------------------------------- */

/** FNV-1a with a final avalanche so every bit slice is well mixed. */
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Parses #rgb, #rgba, #rrggbb or #rrggbbaa (alpha ignored) into [r, g, b]. */
function parseHex(value) {
  if (typeof value !== 'string') return null;
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!match || match[1].length === 5 || match[1].length === 7) return null;
  const digits = match[1].length <= 4 ? match[1].slice(0, 3).replace(/./g, '$&$&') : match[1].slice(0, 6);
  const n = Number.parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function darken(hex, amount) {
  return toHex(parseHex(hex).map((v) => v * (1 - amount)));
}

function hslToHex(hue, saturation, lightness) {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return 255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return toHex([channel(0), channel(8), channel(4)]);
}

function hueOf(hex) {
  const [r, g, b] = parseHex(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/* ---------------------------------------------------------------- */
/* Traits                                                            */
/* ---------------------------------------------------------------- */

const round1 = (n) => Math.round(n * 10) / 10;

function builtInTraits(id) {
  const preset = BUILT_IN.get(id);
  const index = BUILT_IN_IDS.indexOf(id);
  return {
    ...preset,
    key: id,
    skin: SKIN_TONES[preset.skin],
    hair: HAIR_COLORS[preset.hair],
    blinkDelay: round1((index * 2.3) % BLINK_SECONDS),
    bobDelay: round1((index * 1.3) % BOB_SECONDS),
  };
}

/** Custom configs and unknown seeds: every trait comes from the seed hash. */
function seededTraits(seedOrConfig) {
  const isConfig = seedOrConfig !== null && typeof seedOrConfig === 'object' && !Array.isArray(seedOrConfig);
  const raw = isConfig ? seedOrConfig.seed : seedOrConfig;
  let seed = 'expert';
  if (typeof raw === 'string' && raw) seed = raw.slice(0, 256);
  else if (typeof raw === 'number' && Number.isFinite(raw)) seed = String(raw);
  const h = hashSeed(seed);
  const parsed = isConfig ? parseHex(seedOrConfig.base) : null;
  const base = parsed ? toHex(parsed) : hslToHex(h % 360, 0.62, 0.55);
  const accessory = isConfig && ACCESSORIES.has(seedOrConfig.accessory) ? seedOrConfig.accessory : null;
  return {
    key: isConfig ? `custom-${h.toString(36)}-${base.slice(1)}-${accessory || 'plain'}` : `seed-${h.toString(36)}`,
    base,
    skin: SKIN_TONES[(h >>> 8) % SKIN_TONES.length],
    hair: HAIR_COLORS[(h >>> 11) % HAIR_COLORS.length],
    hairStyle: HAIR_STYLES[(h >>> 14) % HAIR_STYLES.length],
    torso: TORSO_STYLES[(h >>> 17) % TORSO_STYLES.length],
    mouth: MOUTH_STYLES[(h >>> 20) & 1],
    accessory,
    blinkDelay: ((h >>> 21) % 52) / 10,
    bobDelay: (h >>> 27) / 10,
  };
}

function resolveTraits(seedOrConfig) {
  try {
    if (typeof seedOrConfig === 'string' && BUILT_IN.has(seedOrConfig)) return builtInTraits(seedOrConfig);
    return seededTraits(seedOrConfig);
  } catch {
    // Hostile input such as throwing getters or revoked proxies.
    return seededTraits(undefined);
  }
}

/* ---------------------------------------------------------------- */
/* Shape helpers                                                     */
/* ---------------------------------------------------------------- */

const shape = (tag, attrs) => ({ tag, attrs, className: '' });
const named = (className, item) => ({ ...item, className });
const group = (className, children, attrs = {}) => ({ tag: 'g', attrs, className, children });
const circle = (cx, cy, r, fill, extra) => shape('circle', { cx, cy, r, fill, ...extra });
const ellipse = (cx, cy, rx, ry, fill, extra) => shape('ellipse', { cx, cy, rx, ry, fill, ...extra });
const rect = (x, y, width, height, rx, fill, extra) => shape('rect', { x, y, width, height, rx, fill, ...extra });
const path = (d, fill, extra) => shape('path', { d, fill, ...extra });
const stroke = (d, color, width, extra) => shape('path', {
  d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra,
});
const outline = (color, width) => ({ stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' });

/* ---------------------------------------------------------------- */
/* Hair, head and torso                                              */
/* ---------------------------------------------------------------- */

// Hair pieces: strings are paths, [cx, cy, r] triples are curls.
// `back` sits behind the head, `front` over it.
const HAIR = {
  short: {
    front: ['M19.3 27.6C18.2 17.8 23.6 11.6 32 11.6C40.6 11.6 46 17.6 44.7 27.6C43.6 24.2 42.8 21.6 41.2 19.8C36.6 22.4 28.4 22.6 23.2 19.8C21.4 21.8 20 24.4 19.3 27.6Z'],
  },
  spiky: {
    front: ['M19.4 27C18.4 20.2 20.2 15.4 23.4 13.2L22.4 8.6L27.2 11.2L29.2 6.6L32.8 10.4L36.4 6.6L37.8 11.4L42.6 8.8L41.4 13.6C44.4 15.6 45.8 20.4 44.6 27C43.4 23 41.6 20.6 39.2 19.6C34.4 21.8 27.8 21.6 24.2 19.8C22 21.2 20.4 23.6 19.4 27Z'],
  },
  curly: {
    back: [[18.4, 27.6, 4], [45.6, 27.6, 4]],
    front: [[20.8, 21.8, 4.4], [22.8, 15.6, 5.2], [28.2, 11.6, 5.8], [35.2, 11.2, 5.8], [41.2, 15, 5.2],
      [43.4, 21.6, 4.4], [26.2, 17.6, 3.6], [32, 16.6, 3.8], [37.8, 17.6, 3.6]],
  },
  long: {
    hidesEars: true,
    back: ['M17.2 27C16.6 15.8 23 10.4 32 10.4C41 10.4 47.4 15.8 46.8 27L47.6 41.6C47.8 44.6 45.8 46.4 42.8 46.4L21.2 46.4C18.2 46.4 16.2 44.6 16.4 41.6Z'],
    front: ['M19.6 28C18.8 17.6 24.4 12.4 32 12.4C39.6 12.4 45.2 17.6 44.4 28C43.4 23.4 41.6 20 38 18.6C35.4 21.6 29 22.6 23.8 21.4C21.6 23.2 20.2 25.4 19.6 28Z'],
  },
  bob: {
    hidesEars: true,
    back: ['M17 27.4C16.2 15.8 22.8 10.4 32 10.4C41.2 10.4 47.8 15.8 47 27.4C46.8 32.2 47.2 36 48.4 38.8C44.2 40.4 41 39.8 39.4 38.4L24.6 38.4C23 39.8 19.8 40.4 15.6 38.8C16.8 36 17.2 32.2 17 27.4Z'],
    front: ['M19.8 25.6C19.2 16.6 24.8 12.2 32 12.2C39.2 12.2 44.8 16.6 44.2 25.6C43.2 22.4 42.2 20.8 40.6 20.4L23.4 20.4C21.8 20.8 20.8 22.4 19.8 25.6Z'],
  },
  bun: {
    back: [[32, 9.4, 5.4]],
    front: ['M19.8 26.6C19 17 24.6 12.2 32 12.2C39.4 12.2 45 17 44.2 26.6C43 21.8 40.4 18.8 36.6 17.8C34.6 19.2 29.4 19.2 27.4 17.8C23.6 18.8 21 21.8 19.8 26.6Z'],
    tie: (accent) => ellipse(32, 13.4, 3.2, 1.3, accent),
  },
  ponytail: {
    back: ['M25.4 14C17.6 14.4 13.6 20.4 14.2 27.6C14.6 32.8 13.4 36.8 11.2 39.4C17 40.2 20.4 36.2 20.8 31C21.2 26 21.8 21 25.4 18.6Z'],
    front: ['M19.6 27.2C18.8 17.4 24.4 12.2 32 12.2C39.8 12.2 45.2 17.6 44.4 27.2C43.4 22.6 41.2 19.4 37.4 18.2C33 20.6 26.6 21 22.6 19.8C21 21.8 20.1 24.2 19.6 27.2Z'],
    tie: (accent) => circle(20.9, 17, 1.8, accent),
  },
  buzz: {
    front: ['M20.1 25C19.8 16.6 25.2 12.8 32 12.8C38.8 12.8 44.2 16.6 43.9 25C42.9 21.6 41.4 19.6 39 18.8C34.6 19.8 29.4 19.8 25 18.8C22.6 19.6 21.1 21.6 20.1 25Z'],
  },
};

/** Hair layers. Under a hat, tall parts (spikes, top curls, bun) are left out. */
function hairLayers(t) {
  const hatted = HATS.has(t.accessory);
  const style = HAIR[hatted && t.hairStyle === 'spiky' ? 'short' : t.hairStyle] || HAIR.short;
  const keep = (item) => !(hatted && Array.isArray(item) && item[1] < 12.5);
  const piece = (item) => (typeof item === 'string' ? path(item, t.hair) : circle(item[0], item[1], item[2], t.hair));
  const back = (style.back || []).filter(keep).map(piece);
  const front = (style.front || []).filter(keep).map(piece);
  const bunHidden = hatted && t.hairStyle === 'bun';
  if (style.tie && !bunHidden) front.push(style.tie(t.accent));
  return { back, front, hidesEars: Boolean(style.hidesEars) };
}

function ears(t) {
  return [
    ellipse(20.2, 27.6, 2.6, 3.3, t.skin), ellipse(20.6, 27.8, 1.2, 1.8, t.skinShade),
    ellipse(43.8, 27.6, 2.6, 3.3, t.skin), ellipse(43.4, 27.8, 1.2, 1.8, t.skinShade),
  ];
}

function face(t) {
  const mouth = t.mouth === 'grin'
    ? [
      path('M28.2 32.4Q32 33.6 35.8 32.4Q35.2 37.2 32 37.2Q28.8 37.2 28.2 32.4Z', MOUTH),
      path('M29.9 35.6Q32 34.2 34.1 35.6Q33.2 37 32 37Q30.8 37 29.9 35.6Z', TONGUE),
    ]
    : [stroke('M28.2 32.6Q32 36 35.8 32.6', INK, 1.5)];
  return [
    ellipse(23.8, 31, 2.4, 1.5, BLUSH, { 'fill-opacity': 0.32 }),
    ellipse(40.2, 31, 2.4, 1.5, BLUSH, { 'fill-opacity': 0.32 }),
    ellipse(32, 29.8, 1.3, 0.9, t.skinShade),
    stroke('M24.8 23.6Q27.2 22.2 29.6 23.4', t.brow, 1.3),
    stroke('M34.4 23.4Q36.8 22.2 39.2 23.6', t.brow, 1.3),
    group('avatar-eyes', [
      ellipse(27.2, 27, 1.7, 2.1, INK), ellipse(36.8, 27, 1.7, 2.1, INK),
      circle(27.9, 26.1, 0.7, WHITE), circle(37.5, 26.1, 0.7, WHITE),
    ]),
    ...mouth,
  ];
}

// Shoulders; the bottom edge follows the badge circle so no clip path is needed.
const TORSO = 'M12 54.4C12.6 48.4 17.6 44.6 25.6 43.6H38.4C46.4 44.6 51.4 48.4 52 54.4A30 30 0 0 1 12 54.4Z';

function neckline(t) {
  switch (t.torso) {
    case 'vneck':
      return [path('M27.2 43.6L32 50.2L36.8 43.6Z', t.skinShade), stroke('M26.4 43.8L32 51.4L37.6 43.8', t.accent, 1.5)];
    case 'collar':
      return [
        path('M27.6 43.6L32 49.4L36.4 43.6Z', t.skinShade),
        path('M26 43.2L31.4 49.2L26.4 50.2Z', WHITE),
        path('M38 43.2L32.6 49.2L37.6 50.2Z', WHITE),
      ];
    case 'hoodie':
      return [
        path('M21.4 45.6C23.6 42.4 27 41.8 32 41.8C37 41.8 40.4 42.4 42.6 45.6C40 50.4 24 50.4 21.4 45.6Z', t.accent),
        path('M27.4 41.6H36.6Q36 47.4 32 47.4Q28 47.4 27.4 41.6Z', t.skinShade),
        stroke('M29 48.2V53.6M35 48.2V53.6', WHITE, 1.2),
      ];
    case 'turtleneck':
      return [rect(26.4, 39.2, 11.2, 7, 3, t.accent)];
    default:
      return [path('M26.6 43.6Q32 48.2 37.4 43.6Z', t.skinShade), stroke('M26 43.8Q32 49.4 38 43.8', t.accent, 1.6)];
  }
}

/* ---------------------------------------------------------------- */
/* Role props                                                        */
/* ---------------------------------------------------------------- */

/** `head` parts ride on the head (and bob with it); `hand` parts are held at the side. */
function propParts(t) {
  switch (t.accessory) {
    case 'headphones':
      return {
        head: [
          stroke('M18.4 27C17.8 15.4 23.8 9.2 32 9.2C40.2 9.2 46.2 15.4 45.6 27', STEEL, 2.8),
          stroke('M18.6 32C19.2 36.6 22.4 38 26.4 36.8', STEEL, 1.4),
          circle(27, 36.6, 1.5, STEEL),
          rect(15.2, 22.6, 6.4, 10.4, 3.2, t.base, outline(STEEL, 1)),
          rect(19.4, 23.8, 3, 8, 1.5, STEEL),
          rect(42.4, 22.6, 6.4, 10.4, 3.2, t.base, outline(STEEL, 1)),
          rect(41.6, 23.8, 3, 8, 1.5, STEEL),
        ],
      };
    case 'beret':
      return {
        head: [
          path('M15.2 18.4C14.2 11.8 22 7.2 31.4 7.4C40.6 7.6 46.6 11 45.8 15.6C45.2 18.8 39.8 18.2 31.2 18.8C23.6 19.4 15.8 21.8 15.2 18.4Z', t.accent),
          stroke('M31.6 7.6L32.4 5', t.accent, 2),
        ],
        hand: [
          stroke('M45.2 57.6L52.6 44.6', WOOD, 2.6),
          stroke('M52.6 44.6L54.2 41.8', METAL, 3.2, { 'stroke-linecap': 'butt' }),
          path('M52.8 41Q53.4 38 56.8 37.3Q56.6 40.8 55.6 42.6Z', t.pop),
          circle(47.4, 53.8, 3, t.skin),
        ],
      };
    case 'glasses':
      return {
        head: [
          rect(23, 23.2, 8.4, 7.6, 2.6, WHITE, { 'fill-opacity': 0.3, ...outline(INK, 1.4) }),
          rect(32.6, 23.2, 8.4, 7.6, 2.6, WHITE, { 'fill-opacity': 0.3, ...outline(INK, 1.4) }),
          stroke('M31.4 26.4Q32 25.6 32.6 26.4M23 25.6L20.2 24.8M41 25.6L43.8 24.8', INK, 1.3),
        ],
        hand: [
          rect(41, 42.6, 15, 13.4, 2.4, WHITE, outline(INK, 1.2)),
          rect(43.8, 49.4, 2.6, 4, 0.6, t.base),
          rect(47.6, 46.8, 2.6, 6.6, 0.6, t.pop),
          rect(51.4, 44.6, 2.6, 8.8, 0.6, t.accent),
          stroke('M43.4 53.9H54', METAL, 1),
          circle(42.6, 55.4, 3, t.skin),
        ],
      };
    case 'megaphone':
      return {
        hand: [group('', [
          rect(40.6, 46.6, 4, 4.8, 1.4, STEEL),
          rect(45.4, 51.6, 2.8, 5.2, 1.2, STEEL),
          path('M44.2 46.2L55.4 41V57L44.2 51.8Z', WHITE, outline(INK, 1.1)),
          stroke('M48.8 44.4V53.6', t.pop, 1.8, { 'stroke-linecap': 'butt' }),
          ellipse(55.4, 49, 2, 8, t.pop, outline(INK, 1.1)),
          group('avatar-waves', [stroke('M59.4 44.6Q61.2 49 59.4 53.4M61.8 42.4Q64.2 49 61.8 55.6', t.accent, 1.3)]),
          circle(46.8, 55.4, 3, t.skin),
        ], { transform: 'rotate(-24 46 50)' })],
      };
    case 'hardhat':
      return {
        head: [
          path('M18.6 20C18.6 11.8 24.6 6.8 32 6.8C39.4 6.8 45.4 11.8 45.4 20Z', '#fbbf24', outline('#b45309', 1.1)),
          rect(30, 7.4, 4, 12.4, 1.6, '#fde68a'),
          rect(15, 18.6, 34, 3.4, 1.7, '#f59e0b', outline('#b45309', 1.1)),
        ],
      };
    case 'pencil':
      // Tucked over the right ear: drawn level, then tilted so the tip points at the ear.
      return {
        head: [group('', [
          rect(40.4, 13, 3.6, 4.8, 1.6, '#f9a8b8'),
          rect(43.6, 13, 2.4, 4.8, 0, METAL),
          rect(46, 13, 9.6, 4.8, 0, '#facc15'),
          rect(46, 14.8, 9.6, 1.2, 0, '#eab308'),
          path('M55.6 13L60.4 15.4L55.6 17.8Z', '#f4d2a4'),
          path('M58.6 14.5L60.4 15.4L58.6 16.3Z', INK),
        ], { transform: 'rotate(131 50.4 15.4)' })],
      };
    case 'shield':
      return {
        hand: [
          circle(39.8, 50.4, 3, t.skin),
          path('M48 39.2L56.6 42.2V48.6C56.6 53.6 52.8 56.8 48 58.4C43.2 56.8 39.4 53.6 39.4 48.6V42.2Z', '#f1f5f9', outline(INK, 1.2)),
          path('M48 42.2L53.8 44.2V48.6C53.8 52 51.4 54.4 48 55.6C44.6 54.4 42.2 52 42.2 48.6V44.2Z', t.accent),
          stroke('M44.8 48.8L47.2 51.2L51.4 46.4', WHITE, 1.9),
        ],
      };
    case 'clipboard':
      return {
        hand: [
          rect(10, 39, 14.4, 17.6, 2.2, '#b7794a', outline('#7c4a24', 1)),
          rect(12, 42.2, 10.4, 12.6, 1, WHITE),
          rect(13.7, 37.4, 7, 4.2, 1.4, '#94a3b8', outline('#64748b', 0.8)),
          stroke('M13.4 45.6l1.1 1.1l2-2.2M13.4 48.8l1.1 1.1l2-2.2M13.4 52l1.1 1.1l2-2.2', t.accent, 1.2),
          stroke('M17.8 45.8H20.8M17.8 49H20.8M17.8 52.2H20.8', METAL, 1.3),
          circle(23.4, 54.6, 3, t.skin),
        ],
      };
    default:
      return {};
  }
}

function buildShapes(t) {
  const hair = hairLayers(t);
  const prop = propParts(t);
  const head = [
    ...hair.back,
    rect(27.4, 32, 9.2, 13.6, 3.4, t.skinShade), // neck, long enough to stay tucked in while bobbing
    ...(hair.hidesEars ? [] : ears(t)),
    ellipse(32, 26, 12, 12.8, t.skin),
    ...hair.front,
    ...face(t),
  ];
  if (prop.head) head.push(group('avatar-prop avatar-prop-head', prop.head));
  const shapes = [
    named('avatar-badge', circle(32, 32, 30, t.base, { 'fill-opacity': 0.2 })),
    group('avatar-bob', [group('avatar-head', head)]),
    named('avatar-torso', path(TORSO, t.base)),
    ...neckline(t),
  ];
  if (prop.hand) shapes.push(group('avatar-prop avatar-prop-hand', prop.hand));
  return shapes;
}

/* ---------------------------------------------------------------- */
/* Public API                                                        */
/* ---------------------------------------------------------------- */

/**
 * Describes an avatar as plain data; no DOM needed.
 * @param {string|{seed?: string, base?: string|null, accessory?: string|null}} seedOrConfig
 *   A built-in expert id, any seed string, or a custom-expert config. Anything
 *   else falls back to a default character.
 * @returns {{key: string, base: string, accent: string, pop: string, skin: string,
 *   hair: string, hairStyle: string, torso: string, mouth: string,
 *   accessory: string|null, blinkDelay: number, bobDelay: number,
 *   shapes: Array<{tag: string, attrs: object, className: string, children?: Array}>}}
 */
export function avatarSpec(seedOrConfig) {
  const traits = resolveTraits(seedOrConfig);
  const t = {
    ...traits,
    accent: darken(traits.base, 0.3),
    pop: hslToHex((hueOf(traits.base) + 150) % 360, 0.72, 0.58),
    skinShade: darken(traits.skin, 0.12),
    brow: darken(traits.hair, 0.15),
  };
  return {
    key: t.key,
    base: t.base,
    accent: t.accent,
    pop: t.pop,
    skin: t.skin,
    hair: t.hair,
    hairStyle: t.hairStyle,
    torso: t.torso,
    mouth: t.mouth,
    accessory: t.accessory,
    blinkDelay: t.blinkDelay,
    bobDelay: t.bobDelay,
    shapes: buildShapes(t),
  };
}

function pixelSize(options) {
  let raw;
  try {
    raw = options?.size;
  } catch {
    raw = undefined;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 32;
  return Number.isFinite(n) && n > 0 ? Math.min(512, Math.max(8, Math.round(n))) : 32;
}

function createNode(spec) {
  const node = document.createElementNS(SVG_NS, spec.tag);
  for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, String(value));
  if (spec.className) node.setAttribute('class', spec.className);
  for (const child of spec.children || []) node.appendChild(createNode(child));
  return node;
}

/**
 * Renders an expert avatar as a decorative inline SVG element.
 * Signature: renderAvatar(seedOrConfig, { size = 32 } = {}); a null or odd
 * options value also falls back to 32px instead of throwing.
 * @param {string|{seed?: string, base?: string|null, accessory?: string|null}} seedOrConfig
 * @param {{size?: number}} [options] Rendered width and height in px.
 * @returns {SVGSVGElement}
 */
export function renderAvatar(seedOrConfig, options = {}) {
  const spec = avatarSpec(seedOrConfig);
  const size = String(pixelSize(options));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'expert-avatar-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Negative delays start each character mid-cycle so blinks and bobs are staggered.
  svg.style.setProperty('--blink-delay', `${-spec.blinkDelay}s`);
  svg.style.setProperty('--bob-delay', `${-spec.bobDelay}s`);
  for (const child of spec.shapes) svg.appendChild(createNode(child));
  return svg;
}
