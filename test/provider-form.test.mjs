import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Assistant's provider form (src/app.js) in a small stand-in document: the form's own
// elements exist, every other lookup finds nothing (the app treats that as a view not shown).
class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.value = '';
    this.placeholder = '';
    this.type = '';
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    this.ownText = '';
  }
  get textContent() { return this.children.length ? this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('') : this.ownText; }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  removeEventListener() {}
  fire(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const listener of this.listeners[type] || []) listener(event);
    return event;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  append(...items) { for (const item of items) { if (typeof item === 'object') item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.ownText = ''; this.append(...items); }
  focus() { globalThis.document.activeElement = this; }
  matches() { return false; }
  closest(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1).split(/[[\s]/)[0] : null;
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    for (let node = this; node; node = node.parent) {
      if (cls && node.className.split(' ').includes(cls)) return node;
      if (id && node.id === id) return node;
    }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll(selector) {
    const cls = selector.slice(1);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (typeof child !== 'object') continue;
        if (child.className?.split(' ').includes(cls)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, width: 0 }; }
}

const ids = ['provider-form', 'provider-kind', 'provider-base-url', 'provider-base-url-group', 'provider-detected-group',
  'provider-detected-base', 'provider-api-key', 'provider-model', 'provider-model-text-group', 'provider-model-select-group',
  'provider-model-hint', 'model-picker', 'model-picker-button', 'model-picker-list', 'provider-status', 'provider-test',
  'provider-test-dot', 'provider-save', 'provider-clear'];
const nodes = Object.fromEntries(ids.map((id) => [`#${id}`, new FakeElement(id.includes('button') || id.startsWith('provider-test') ? 'button' : 'div', id)]));
nodes['#model-picker'].append(nodes['#model-picker-button'], nodes['#model-picker-list']);
nodes['#model-picker-list'].hidden = true;

globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.dispatchEvent ??= () => true;
globalThis.document = {
  addEventListener() {},
  querySelector: (selector) => nodes[selector] || null,
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => Object.assign(new FakeElement(tag), { appendChild: (child) => child }),
  createTextNode: () => new FakeElement('#text'),
  activeElement: null,
  body: new FakeElement('body'),
};

const { default: app } = await import('../src/app.js');
app.bindProvider();

const $ = (selector) => nodes[selector];
const BASE = 'http://127.0.0.1:47301/v1';
const STUB_MODELS = [
  { id: 'stub-coder-large', displayName: 'Stub Coder Large', available: true, chat: true },
  { id: 'stub-coder-mini', displayName: 'stub-coder-mini', available: true, chat: true },
];
const FRESH = { profileId: 'default', profileName: 'ScaleMax', kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/token/v1',
  model: '', hasKey: false, keyStorage: 'none', enabledModels: [], models: [], configured: false };

// A fresh, unsaved provider; a bridge whose discover/save answer like main does.
function setup({ provider = FRESH, models = STUB_MODELS, discover } = {}) {
  const saved = [];
  const toasts = [];
  window.scalemaxAPI = {
    provider: {
      discover: async (input) => (discover ? discover(input) : { ok: true, data: { kind: input.kind, baseUrl: input.baseUrl, models } }),
      save: async (input) => {
        saved.push(input);
        return { ok: true, data: { ...FRESH, kind: input.kind, baseUrl: input.baseUrl, model: input.model, models: input.models,
          configured: true, hasKey: Boolean(input.apiKey), profileName: '127.0.0.1:47301' } };
      },
      profiles: async () => ({ ok: true, data: { activeId: 'default', profiles: [] } }),
    },
  };
  app.showToast = (message) => toasts.push(message);
  app.provider = structuredClone(provider);
  app.providerCatalog = structuredClone(provider.models || []);
  app.formProfileId = undefined;
  app.syncProviderForm();
  app.renderProviderStatus();
  return { saved, toasts };
}

function chooseCustom(baseUrl = BASE) {
  $('#provider-kind').value = 'custom';
  $('#provider-kind').fire('change');
  $('#provider-base-url').value = baseUrl;
  $('#provider-base-url').fire('input');
  $('#provider-api-key').value = 'sk-test-local';
  $('#provider-api-key').fire('input');
}

const options = () => $('#model-picker-list').children;
const optionLines = () => options().map((option) => option.children.filter((line) => typeof line !== 'string').map((line) => line.textContent));

test('Test connection comes before Save provider in the form (reading and Tab order)', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="provider-test"') < html.indexOf('id="provider-save"'));
  assert.ok(html.indexOf('id="provider-save"') < html.indexOf('id="provider-clear"'));
});

test('a custom endpoint asks for a neutral key and an exact model ID until a test lists its models', () => {
  setup();
  assert.equal($('#provider-api-key').placeholder, 'sm_live_…');
  chooseCustom();
  assert.equal($('#provider-api-key').placeholder, 'Your API key');
  assert.equal($('#provider-model-select-group').hidden, true);
  assert.equal($('#provider-model-text-group').hidden, false);
  assert.match($('#provider-model-hint').textContent, /Test the connection to list the endpoint's models/);
});

test('after Test connection the models are a picker, the first chat model is chosen, and Save works at once', async () => {
  const { saved } = setup();
  chooseCustom();
  await app.testProvider();
  assert.equal($('#provider-model-select-group').hidden, false);
  assert.equal($('#provider-model-text-group').hidden, true);
  // The endpoint's name for a model, and its id once below it; no second line when it gives none.
  assert.deepEqual(optionLines(), [['Stub Coder Large', 'stub-coder-large'], ['stub-coder-mini'],
    ['Other model ID…', 'Type an ID the endpoint does not list']]);
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  assert.equal($('#model-picker-button').textContent, 'Stub Coder Large stub-coder-large');
  assert.match($('#provider-status').textContent, /2 models found at http:\/\/127\.0\.0\.1:47301\/v1\. Stub Coder Large is selected; Save provider to use it\./);
  // Nothing is saved yet: the composer's menu keeps the saved provider's (empty) list.
  assert.deepEqual(app.providerCatalog, []);
  await app.saveProvider();
  assert.equal(saved.length, 1);
  assert.deepEqual({ ...saved[0], models: saved[0].models.map((model) => model.id) }, {
    kind: 'custom', model: 'stub-coder-large', enabledModels: [], models: ['stub-coder-large', 'stub-coder-mini'],
    baseUrl: BASE, apiKey: 'sk-test-local',
  });
  // Saved: now the composer's menu lists them, and the form shows the saved provider.
  assert.deepEqual(app.providerCatalog.map((model) => model.id), ['stub-coder-large', 'stub-coder-mini']);
  assert.equal($('#model-picker-button').textContent, 'Stub Coder Large stub-coder-large');
});

test('picking another listed model saves that one', async () => {
  const { saved } = setup();
  chooseCustom();
  await app.testProvider();
  // A click on the option's name lands on the list (one listener for every option).
  $('#model-picker-list').fire('click', { target: options()[1].children[0] });
  assert.equal($('#model-picker-button').textContent, 'stub-coder-mini');
  await app.saveProvider();
  assert.equal(saved[0].model, 'stub-coder-mini');
});

test('"Other model ID…" shows the ID field; Save sends what was typed, or says what is missing', async () => {
  const { saved, toasts } = setup();
  chooseCustom();
  await app.testProvider();
  app.pickFormModel(options().at(-1));
  assert.equal($('#provider-model-text-group').hidden, false);
  assert.equal($('#model-picker-button').textContent, 'Other model ID…');
  assert.equal(document.activeElement, $('#provider-model'));
  // The field starts from the model that was chosen, so it can be edited into a variant.
  assert.equal($('#provider-model').value, 'stub-coder-large');
  $('#provider-model').value = '';
  await app.saveProvider();
  assert.equal(saved.length, 0);
  assert.equal(toasts.at(-1), 'Type the model ID, or pick one of the listed models.');
  $('#provider-model').value = 'stub-coder-large-ft';
  await app.saveProvider();
  assert.equal(saved[0].model, 'stub-coder-large-ft');
  // A listed model is one click away again.
  setup();
  chooseCustom();
  await app.testProvider();
  app.pickFormModel(options().at(-1));
  app.pickFormModel(options()[1]);
  assert.equal($('#provider-model-text-group').hidden, true);
  assert.equal(app.formModel(), 'stub-coder-mini');
});

test('an endpoint that lists no models is saved with a typed ID; without one Save says what to do', async () => {
  const { saved, toasts } = setup();
  chooseCustom();
  await app.saveProvider();
  assert.equal(saved.length, 0);
  assert.equal(toasts.at(-1), 'Type the model ID, or Test connection to list the endpoint\'s models.');
  assert.equal(document.activeElement, $('#provider-model'));
  $('#provider-model').value = 'llama3';
  await app.saveProvider();
  assert.deepEqual([saved[0].model, saved[0].models], ['llama3', []]);
});

test('a failed test keeps the typed form and shows the endpoint\'s own reason', async () => {
  const message = "Couldn't reach http://127.0.0.1:47399/v1 — nothing is listening there. Is the server running?";
  const { toasts } = setup({ discover: async () => ({ ok: false, error: { code: 'NETWORK', message } }) });
  chooseCustom('http://127.0.0.1:47399/v1');
  await app.testProvider();
  assert.equal($('#provider-status').textContent, message);
  assert.equal(toasts.at(-1), message);
  assert.equal($('#provider-base-url').value, 'http://127.0.0.1:47399/v1');
  assert.equal($('#provider-model-text-group').hidden, false);
});

test('another base URL after a test hides that endpoint\'s models until it is tested', async () => {
  setup();
  chooseCustom();
  await app.testProvider();
  assert.equal($('#provider-model-select-group').hidden, false);
  $('#provider-base-url').value = 'http://127.0.0.1:9999/v1';
  $('#provider-base-url').fire('input');
  assert.equal($('#provider-model-select-group').hidden, true);
  assert.equal($('#provider-model-text-group').hidden, false);
  // The same URL with a trailing slash is the same endpoint.
  $('#provider-base-url').value = `${BASE}/`;
  $('#provider-base-url').fire('input');
  assert.equal($('#provider-model-select-group').hidden, false);
});

test('testing again keeps the model picked before when the endpoint still lists it', async () => {
  setup();
  chooseCustom();
  await app.testProvider();
  app.pickFormModel(options()[1]);
  await app.testProvider();
  assert.equal(app.formModel(), 'stub-coder-mini');
  // An exact ID typed before the first test, which the endpoint does not list, is kept too.
  setup();
  chooseCustom();
  $('#provider-model').value = 'my-private-model';
  await app.testProvider();
  assert.equal(app.formModel(), 'my-private-model');
  assert.equal($('#model-picker-button').textContent, 'Other model ID…');
});

test('a stored key is offered only for the endpoint it belongs to', () => {
  setup({ provider: { ...FRESH, kind: 'custom', baseUrl: BASE, model: 'stub-coder-large', hasKey: true, configured: true, models: STUB_MODELS } });
  assert.equal($('#provider-api-key').placeholder, 'Key stored — leave blank to keep it');
  $('#provider-base-url').value = 'https://api.openai.com/v1';
  $('#provider-base-url').fire('input');
  assert.equal($('#provider-api-key').placeholder, 'Your API key');
});

test('the form follows the saved provider when it changes elsewhere, unless the user is editing it', async () => {
  setup({ provider: { ...FRESH, kind: 'custom', baseUrl: BASE, model: 'stub-coder-large', configured: true, models: STUB_MODELS } });
  assert.equal($('#provider-kind').value, 'custom');
  assert.equal(app.formModel(), 'stub-coder-large');
  // The composer's model menu switched the model: the Assistant picker shows it.
  app.provider = { ...app.provider, model: 'stub-coder-mini' };
  app.renderProviderStatus();
  assert.equal(app.formModel(), 'stub-coder-mini');
  // While the user edits, a render keeps their edits.
  $('#provider-base-url').value = 'http://127.0.0.1:8080/v1';
  $('#provider-base-url').fire('input');
  app.provider = { ...app.provider, model: 'stub-coder-large' };
  app.renderProviderStatus();
  assert.equal($('#provider-base-url').value, 'http://127.0.0.1:8080/v1');
  // Another provider chosen in the menu: the form shows that one.
  app.provider = { ...FRESH, profileId: 'p-other' };
  app.renderProviderStatus();
  assert.equal($('#provider-kind').value, 'scalemax');
  assert.equal($('#provider-api-key').value, '');
});

test('the Assistant picker opens with the keyboard and Escape closes it', async () => {
  setup();
  chooseCustom();
  await app.testProvider();
  const picker = $('#model-picker');
  picker.fire('keydown', { key: 'ArrowDown' });
  assert.equal($('#model-picker-list').hidden, false);
  assert.equal(document.activeElement, options()[0], 'the chosen model has focus');
  picker.fire('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, options()[1]);
  picker.fire('keydown', { key: 'End' });
  assert.equal(document.activeElement, options().at(-1));
  picker.fire('keydown', { key: 'Escape' });
  assert.equal($('#model-picker-list').hidden, true);
  assert.equal(document.activeElement, $('#model-picker-button'));
});

test('ScaleMax lists its models after a test; Save sends the endpoint that accepted the key', async () => {
  const scalemax = [{ id: 'flux-2-pro', displayName: 'FLUX 2 Pro', chat: false, output: 'image' },
    { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', chat: true }];
  const { saved } = setup({ discover: async () => ({ ok: true, data: { kind: 'scalemax', baseUrl: 'https://api.scalemax.pro/v1', models: scalemax } }) });
  assert.equal($('#provider-model-select-group').hidden, false);
  assert.equal($('#provider-model-text-group').hidden, true);
  assert.equal($('#model-picker-button').disabled, true);
  assert.equal($('#model-picker-button').textContent, 'Test the connection to load models');
  $('#provider-api-key').value = 'sm_live_test_key_1234567890';
  await app.testProvider();
  // Chat models only, and no "Other model ID…" for ScaleMax.
  assert.deepEqual(optionLines(), [['DeepSeek V4 Flash', 'deepseek-v4-flash']]);
  assert.equal($('#provider-detected-base').textContent, 'https://api.scalemax.pro/v1');
  await app.saveProvider();
  assert.deepEqual([saved[0].kind, saved[0].model, saved[0].baseUrl, saved[0].enabledModels, saved[0].models.length],
    ['scalemax', 'deepseek-v4-flash', 'https://api.scalemax.pro/v1', ['deepseek-v4-flash'], 2]);
});
