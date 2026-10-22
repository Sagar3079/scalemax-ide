import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  avatarSpec, renderAvatar, risoPlates, risoDuotone, AVATAR_STYLES, AVATAR_COLORS, AVATAR_ACCESSORY_PRESETS, ACCESSORY_IDS,
} from '../src/avatars.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BUILT_INS = {
  'full-stack-developer': 'headphones',
  'ui-ux-designer': 'beret',
  'data-analyst': 'glasses',
  'growth-marketer': 'megaphone',
  'devops-engineer': 'hardhat',
  copywriter: 'pencil',
  'security-auditor': 'shield',
  'product-manager': 'clipboard',
};
const HEX = /^#[0-9a-f]{6}$/;

function flatten(shapes, out = []) {
  for (const shape of shapes) {
    out.push(shape);
    if (shape.children) flatten(shape.children, out);
  }
  return out;
}

/** All shapes inside prop groups (head or hand). */
function propShapes(spec) {
  const groups = flatten(spec.shapes).filter((shape) => shape.className.split(' ').includes('avatar-prop'));
  return groups.flatMap((prop) => flatten(prop.children));
}

const findClass = (spec, className) => flatten(spec.shapes).find((shape) => shape.className === className);

const BAD_INPUTS = [
  undefined, null, 0, 42, -1.5, NaN, Infinity, true, false, '', 'unknown-id', '__proto__', 'constructor',
  [], ['data-analyst'], {}, Object.create(null), () => 'x', Symbol('seed'), 10n,
  { seed: 42 }, { seed: null, base: null, accessory: null }, { seed: {}, base: 7, accessory: 3 },
  { seed: 'x', base: 'red' }, { seed: 'x', base: '#12345' }, { seed: 'x', base: '#ggg' },
  { seed: 'x', base: 'url(javascript:alert(1))' }, { seed: 'x', accessory: 'crown' },
  { seed: 'x', accessory: 'plain' }, { seed: '<script>alert(1)</script>', base: '"><svg onload=1>', accessory: '<b>' },
  { get seed() { throw new Error('boom'); } },
  new Proxy({}, { get() { throw new Error('trap'); } }),
];

test('exports the style, colour and accessory presets', async () => {
  assert.equal(AVATAR_STYLES.length, 9);
  assert.deepEqual(AVATAR_STYLES[0], { id: 'plain', label: 'Plain', accessory: null });
  for (const style of AVATAR_STYLES) {
    assert.equal(typeof style.id, 'string');
    assert.equal(typeof style.label, 'string');
  }
  assert.equal(AVATAR_ACCESSORY_PRESETS, AVATAR_STYLES);
  assert.equal(AVATAR_COLORS.length, 8);
  for (const color of AVATAR_COLORS) assert.match(color, HEX);
  assert.deepEqual([...ACCESSORY_IDS], [
    'headphones', 'beret', 'glasses', 'megaphone', 'hardhat', 'pencil', 'shield', 'clipboard', null,
  ]);
  // Imported here so a problem in the catalog module only fails this check.
  const { AVATAR_ACCESSORIES } = await import('../src/custom-catalog.js');
  assert.deepEqual([...ACCESSORY_IDS], AVATAR_ACCESSORIES, 'matches custom-catalog validation');
  assert.deepEqual(AVATAR_STYLES.map((style) => style.accessory).sort(), [...ACCESSORY_IDS].sort());
});

test('the eight built-in experts are distinct characters with their role prop', () => {
  const specs = Object.entries(BUILT_INS).map(([id, accessory]) => {
    const spec = avatarSpec(id);
    assert.equal(spec.key, id);
    assert.equal(spec.accessory, accessory, id);
    assert.ok(propShapes(spec).length > 0, `${id} draws its prop`);
    assert.equal(findClass(spec, 'avatar-torso').attrs.fill, spec.base);
    return spec;
  });
  assert.equal(new Set(specs.map((spec) => JSON.stringify(spec.shapes))).size, 8);
  assert.equal(new Set(specs.map((spec) => spec.base)).size, 8);
  assert.ok(new Set(specs.map((spec) => spec.skin)).size >= 6, 'varied skin tones');
  assert.equal(new Set(specs.map((spec) => spec.hairStyle)).size, 8, 'a different hair style each');
  assert.equal(new Set(specs.map((spec) => spec.blinkDelay)).size, 8, 'blinks are staggered');
});

test('every character has the bust parts', () => {
  for (const input of [...Object.keys(BUILT_INS), { seed: 'custom-a', base: '#64748b', accessory: null }]) {
    const spec = avatarSpec(input);
    for (const className of ['avatar-badge', 'avatar-bob', 'avatar-head', 'avatar-eyes', 'avatar-torso']) {
      assert.ok(findClass(spec, className), `${className} in ${spec.key}`);
    }
    const head = findClass(spec, 'avatar-head');
    assert.ok(flatten(head.children).some((shape) => shape.attrs.fill === spec.skin), 'skin-toned head');
    assert.ok(flatten(head.children).some((shape) => shape.attrs.fill === spec.hair), 'hair');
  }
});

test('a custom config honours its base colour and accessory', () => {
  const spec = avatarSpec({ seed: 'custom-expert-1', base: '#10b981', accessory: 'shield' });
  assert.equal(spec.base, '#10b981');
  assert.equal(spec.accessory, 'shield');
  assert.equal(findClass(spec, 'avatar-torso').attrs.fill, '#10b981');
  assert.ok(propShapes(spec).length > 0);

  const plain = avatarSpec({ seed: 'custom-expert-1', base: '#10b981', accessory: null });
  assert.equal(plain.accessory, null);
  assert.equal(propShapes(plain).length, 0);
  assert.equal(plain.skin, spec.skin, 'seed, not accessory, picks the skin tone');
  assert.equal(plain.hairStyle, spec.hairStyle);

  assert.equal(avatarSpec({ seed: 'a', base: '#ABC' }).base, '#aabbcc');
  assert.equal(avatarSpec({ seed: 'a', base: '#10B981cc' }).base, '#10b981');
  const fallback = avatarSpec({ seed: 'custom-expert-1', base: null });
  assert.match(fallback.base, HEX);
  assert.equal(fallback.base, avatarSpec({ seed: 'custom-expert-1' }).base, 'hash colour fallback is stable');
});

test('the same seed always gives the same spec', () => {
  for (const input of ['data-analyst', 'some-seed', { seed: 'custom-expert-9', base: '#ec4899', accessory: 'pencil' }]) {
    assert.deepEqual(avatarSpec(input), avatarSpec(input));
  }
});

test('different seeds vary skin tone and hair', () => {
  const specs = Array.from({ length: 24 }, (_, i) => avatarSpec({ seed: `custom-expert-${i}` }));
  assert.ok(new Set(specs.map((spec) => spec.skin)).size >= 4, 'skin tones vary');
  assert.ok(new Set(specs.map((spec) => spec.hairStyle)).size >= 4, 'hair styles vary');
  assert.ok(new Set(specs.map((spec) => spec.hair)).size >= 4, 'hair colours vary');
  assert.ok(new Set(specs.map((spec) => spec.base)).size >= 12, 'fallback colours vary');
  assert.equal(new Set(specs.map((spec) => spec.key)).size, 24, 'keys differ per seed');
});

test('bad input falls back to a valid character without throwing', () => {
  for (const input of BAD_INPUTS) {
    const spec = avatarSpec(input);
    assert.match(spec.base, HEX);
    assert.ok(spec.accessory === null || ACCESSORY_IDS.includes(spec.accessory));
    assert.ok(findClass(spec, 'avatar-head'));
  }
  assert.equal(avatarSpec({ seed: 'x', base: 'red' }).base, avatarSpec({ seed: 'x' }).base);
  assert.equal(avatarSpec({ seed: 'x', accessory: 'crown' }).accessory, null);
  assert.equal(avatarSpec('unknown-id').accessory, null);
  assert.deepEqual(avatarSpec(undefined), avatarSpec(null));
});

test('every accessory in AVATAR_STYLES draws its prop with every colour', () => {
  for (const style of AVATAR_STYLES) {
    for (const base of AVATAR_COLORS) {
      const spec = avatarSpec({ seed: `custom-${style.id}-${base}`, base, accessory: style.accessory });
      assert.equal(spec.accessory, style.accessory);
      assert.equal(spec.base, base);
      if (style.accessory) assert.ok(propShapes(spec).length >= 2, `${style.id} prop`);
      else assert.equal(propShapes(spec).length, 0);
    }
  }
});

test('shapes are plain, safe SVG data', () => {
  const inputs = [
    ...Object.keys(BUILT_INS),
    ...AVATAR_STYLES.map((style) => ({ seed: `safe-${style.id}`, base: '#8b5cf6', accessory: style.accessory })),
    ...BAD_INPUTS,
  ];
  const tags = new Set(['g', 'circle', 'ellipse', 'rect', 'path']);
  for (const input of inputs) {
    for (const shape of flatten(avatarSpec(input).shapes)) {
      assert.ok(tags.has(shape.tag), shape.tag);
      assert.match(shape.className, /^[a-z -]*$/);
      for (const [name, value] of Object.entries(shape.attrs)) {
        assert.match(name, /^[a-z][a-zA-Z-]*$/);
        assert.notEqual(name, 'id', 'no element ids');
        assert.ok(!name.startsWith('on'), 'no event handlers');
        assert.ok(['string', 'number'].includes(typeof value));
        const text = String(value);
        assert.ok(!text.includes('<') && !text.includes('>'), `${name}=${text}`);
        assert.ok(!text.toLowerCase().includes('javascript:'), `${name}=${text}`);
        assert.ok(!text.includes('url('), 'no references');
      }
    }
  }
});

test('avatars.js builds nodes without markup strings', () => {
  const source = readFileSync(new URL('../src/avatars.js', import.meta.url), 'utf8');
  for (const banned of ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'DOM' + 'Parser', 'createContextual' + 'Fragment', 'document.' + 'write']) {
    assert.ok(!source.includes(banned), `avatars.js must not use ${banned}`);
  }
  assert.match(source, /createElementNS\(/);
});

test('renderAvatar creates namespaced nodes with setAttribute only', () => {
  const created = [];
  class FakeElement {
    constructor(namespace, tag) {
      this.namespace = namespace;
      this.tag = tag;
      this.attributes = new Map();
      this.children = [];
      this.styles = new Map();
      this.style = { setProperty: (name, value) => this.styles.set(name, value) };
      created.push(this);
    }

    setAttribute(name, value) {
      assert.equal(typeof value, 'string');
      this.attributes.set(name, value);
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    append(...nodes) { this.children.push(...nodes); }

    set innerHTML(value) { throw new Error('markup assignment'); }

    set outerHTML(value) { throw new Error('markup assignment'); }

    set textContent(value) { throw new Error('text assignment'); }

    insertAdjacentHTML() { throw new Error('markup insertion'); }
  }
  const fakeDocument = {
    createElementNS: (namespace, tag) => new FakeElement(namespace, tag),
    createElement() { throw new Error('use createElementNS'); },
  };
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const svg = renderAvatar({ seed: 'custom-expert-7', base: '#ec4899', accessory: 'clipboard' }, { size: 56 });
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attributes.get('viewBox'), '0 0 64 64');
    assert.equal(svg.attributes.get('width'), '56');
    assert.equal(svg.attributes.get('height'), '56');
    assert.equal(svg.attributes.get('aria-hidden'), 'true');
    assert.equal(svg.attributes.get('focusable'), 'false');
    assert.match(svg.attributes.get('class'), /\bexpert-avatar-svg\b/);
    assert.match(svg.styles.get('--blink-delay'), /^-?\d+(\.\d+)?s$/);
    assert.ok(created.every((node) => node.namespace === SVG_NS));
    assert.ok(created.every((node) => !node.attributes.has('id')));

    const spec = avatarSpec({ seed: 'custom-expert-7', base: '#ec4899', accessory: 'clipboard' });
    assert.equal(created.length, flatten(spec.shapes).length + 1, 'one node per shape');
    const torso = created.find((node) => node.attributes.get('class') === 'avatar-torso');
    assert.equal(torso.attributes.get('fill'), '#ec4899');
    // The two-ink reprint rides along as CSS custom properties; the drawing keeps its colours.
    assert.equal(torso.styles.get('--riso-fill'), risoDuotone('#ec4899'));
    assert.equal(torso.styles.get('--riso-fill-dark'), risoDuotone('#ec4899', 'dark'));
    for (const node of created) {
      for (const [attr, prop] of [['fill', '--riso-fill'], ['stroke', '--riso-stroke']]) {
        const value = node.attributes.get(attr);
        if (typeof value === 'string' && value.startsWith('#')) {
          assert.match(node.styles.get(prop), /^#[0-9a-f]{6}$/, `${attr} ${value} is reprinted`);
          assert.match(node.styles.get(`${prop}-dark`), /^#[0-9a-f]{6}$/);
        } else {
          assert.equal(node.styles.has(prop), false, `${attr} ${value} is left alone`);
        }
      }
    }

    assert.equal(renderAvatar('data-analyst').attributes.get('width'), '32', 'default size');
    assert.equal(renderAvatar('data-analyst', { size: 42 }).attributes.get('width'), '42');
    for (const input of BAD_INPUTS) assert.equal(renderAvatar(input).tag, 'svg');
    for (const options of [null, undefined, {}, { size: -4 }, { size: 'big' }, { size: Symbol('s') }, 7]) {
      assert.equal(renderAvatar('copywriter', options).attributes.get('width'), '32');
    }
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
});

test('the two-ink duotone prints skin light pink, dark hair navy-purple and clothes blue or pink by hue', () => {
  const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const luma = (hex) => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  // White is unprinted paper on either press.
  assert.deepEqual(risoPlates('#ffffff'), { blue: 0, pink: 0 });
  assert.equal(risoDuotone('#fff'), '#f3f4f1');
  assert.equal(risoDuotone('#ffffff', 'dark'), '#d4d6d0');
  // Skin: mostly the pink plate, light.
  for (const skin of ['#ffe3cc', '#f6cba4', '#e8b088', '#d09565']) {
    const plates = risoPlates(skin);
    assert.ok(plates.pink > plates.blue && plates.pink >= 0.15 && plates.pink <= 0.45, `${skin} ${JSON.stringify(plates)}`);
    assert.ok(luma(risoDuotone(skin)) > 0.7, `${skin} stays light`);
    const [r, , b] = rgb(risoDuotone(skin));
    assert.ok(r > b, `${skin} reads pink`);
  }
  // Dark hair and outlines take both plates: a dark blue-purple, blue over red.
  for (const dark of ['#2b2227', '#2a2530']) {
    const plates = risoPlates(dark);
    assert.ok(plates.blue > 0.9 && plates.pink > 0.6, `${dark} ${JSON.stringify(plates)}`);
    const [r, , b] = rgb(risoDuotone(dark));
    assert.ok(luma(risoDuotone(dark)) < 0.3 && b > r, `${dark} prints navy`);
  }
  // Clothes by hue: cool colours on the blue plate, warm ones on the pink plate.
  for (const cool of ['#3b82f6', '#06b6d4', '#10b981']) {
    const plates = risoPlates(cool);
    assert.ok(plates.blue >= 0.7 && plates.pink === 0, `${cool} ${JSON.stringify(plates)}`);
  }
  for (const warm of ['#ec4899', '#ef4444', '#f59e0b']) {
    const plates = risoPlates(warm);
    assert.ok(plates.pink >= 0.6 && plates.pink > plates.blue * 3, `${warm} ${JSON.stringify(plates)}`);
  }
  // Violets overprint both.
  const violet = risoPlates('#a855f7');
  assert.ok(violet.blue > 0.3 && violet.pink > 0.3);
  // Every reprint is a colour the press can make: never past the paper.
  for (const color of [...AVATAR_COLORS, '#2a2530', '#ffe3cc', '#dcb462', '#8d929c']) {
    for (const theme of ['light', 'dark']) {
      const out = risoDuotone(color, theme);
      assert.match(out, /^#[0-9a-f]{6}$/);
      const paper = theme === 'dark' ? [212, 214, 208] : [243, 244, 241];
      rgb(out).forEach((channel, i) => assert.ok(channel <= paper[i], `${color} ${theme}`));
    }
  }
  // On deep stock dark parts print lighter, so they stay readable on the dark cards.
  assert.ok(luma(risoDuotone('#2b2227', 'dark')) > luma(risoDuotone('#2b2227')) + 0.05);
  // Not a hex colour: no plates, passed through.
  for (const odd of ['none', 'currentColor', '', '#12', '#12345', 'red', null, undefined, 7]) {
    assert.equal(risoPlates(odd), null);
    assert.equal(risoDuotone(odd), odd);
  }
});

test('experts.css animates only transform and opacity and honours reduced motion', () => {
  const css = readFileSync(new URL('../src/experts.css', import.meta.url), 'utf8');
  const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
  assert.ok(keyframes.length >= 3);
  for (const [, body] of keyframes) {
    for (const [, property] of body.matchAll(/([a-z-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity'].includes(property), `keyframes animate ${property}`);
    }
  }
  const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedAt >= 0, 'has a reduced-motion block');
  assert.match(css.slice(reducedAt), /\.expert-avatar-svg \*[^{]*\{\s*animation:\s*none !important;/);
  assert.match(css, /transform-box:\s*fill-box;\s*transform-origin:\s*center;/);
  assert.match(css, /\.expert-card:hover \.avatar-prop/);
  assert.match(css, /\.expert-card:focus-within \.avatar-prop/);
  assert.match(css, /var\(--blink-delay/);
});
