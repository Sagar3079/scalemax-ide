import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OAUTH_SUPPORT } from '../src/oauth-catalog.js';

const require = createRequire(import.meta.url);
const { OAUTH_PROVIDERS } = require('../lib/oauth-catalog.cjs');

const IDS = [
  'github', 'sentry', 'notion', 'google-drive', 'google-calendar', 'gmail', 'onedrive', 'microsoft-teams',
  'dropbox', 'jira', 'confluence', 'linear', 'asana', 'slack', 'discord', 'zoom', 'airtable', 'hubspot',
  'salesforce', 'figma', 'intercom', 'shopify', 'cloudflare', 'vercel', 'netlify',
];
const LOOPBACK_VALUES = new Set(['yes', 'localhost-only', 'no', 'unknown']);
const SECRET_MODES = new Set(['required', 'optional', 'none']);
const SAMPLE_SHOP = 'example.myshopify.com';

function assertHttps(value, label) {
  assert.equal(typeof value, 'string', label);
  const url = new URL(value.split('{shop}').join(SAMPLE_SHOP));
  assert.equal(url.protocol, 'https:', label);
  assert.equal(url.username, '', label);
  assert.equal(url.password, '', label);
}

test('the renderer support map mirrors the main-process catalog', () => {
  assert.deepEqual(Object.keys(OAUTH_PROVIDERS), IDS);
  assert.deepEqual(Object.keys(OAUTH_SUPPORT).sort(), Object.keys(OAUTH_PROVIDERS).sort());
  for (const [id, config] of Object.entries(OAUTH_PROVIDERS)) {
    assert.equal(OAUTH_SUPPORT[id], config.loopback, id);
  }
  for (const value of Object.values(OAUTH_SUPPORT)) assert.ok(LOOPBACK_VALUES.has(value), value);
});

test('every provider entry is complete and only uses https endpoints', () => {
  for (const [id, config] of Object.entries(OAUTH_PROVIDERS)) {
    assertHttps(config.authorizeUrl, `${id}.authorizeUrl`);
    assertHttps(config.tokenUrl, `${id}.tokenUrl`);
    if (config.refreshUrl !== undefined) assertHttps(config.refreshUrl, `${id}.refreshUrl`);
    assertHttps(config.registerUrl, `${id}.registerUrl`);
    assertHttps(config.docsUrl, `${id}.docsUrl`);
    assert.ok(SECRET_MODES.has(config.secret), `${id}.secret`);
    assert.equal('needsSecret' in config, false, `${id} still has needsSecret`);
    assert.ok(LOOPBACK_VALUES.has(config.loopback), `${id}.loopback`);
    assert.equal(config.redirectHost, config.loopback === 'localhost-only' ? 'localhost' : '127.0.0.1', `${id}.redirectHost`);
    assert.ok(['post', 'basic'].includes(config.tokenAuth), `${id}.tokenAuth`);
    assert.ok(['form', 'json'].includes(config.tokenFormat), `${id}.tokenFormat`);
    assert.equal(typeof config.scopes, 'string', `${id}.scopes`);
    assert.equal(typeof config.pkce, 'boolean', `${id}.pkce`);
    assert.ok(typeof config.redirectNote === 'string' && config.redirectNote.length > 0, `${id}.redirectNote`);
    for (const value of Object.values(config.extraParams)) assert.equal(typeof value, 'string', `${id}.extraParams`);
    assert.equal(typeof config.identity.field, 'string', `${id}.identity.field`);
    assertHttps(config.identity.url, `${id}.identity.url`);
    const usesShop = [config.authorizeUrl, config.tokenUrl, config.identity.url].some((url) => url.includes('{shop}'));
    assert.equal(usesShop, config.needsShop === true, `${id}.needsShop`);
  }
});

test('secret modes, token auth and special cases follow the provider research', () => {
  const byMode = (mode) => IDS.filter((id) => OAUTH_PROVIDERS[id].secret === mode);
  assert.deepEqual(byMode('none'), ['onedrive', 'microsoft-teams', 'slack', 'zoom']);
  assert.deepEqual(byMode('required'), [
    'github', 'notion', 'jira', 'confluence', 'asana', 'discord', 'hubspot', 'figma', 'intercom', 'shopify', 'netlify',
  ]);
  assert.deepEqual(byMode('optional'), [
    'sentry', 'google-drive', 'google-calendar', 'gmail', 'dropbox', 'linear', 'airtable', 'salesforce', 'cloudflare',
    'vercel',
  ]);
  assert.equal(OAUTH_PROVIDERS.airtable.tokenAuth, 'basic');
  assert.equal(OAUTH_PROVIDERS.figma.refreshUrl, 'https://api.figma.com/v1/oauth/refresh');
  assert.equal(OAUTH_PROVIDERS.intercom.loopback, 'no');
  assert.deepEqual(IDS.filter((id) => OAUTH_PROVIDERS[id].needsShop), ['shopify']);
});

test('the catalog and the support map are frozen', () => {
  assert.ok(Object.isFrozen(OAUTH_PROVIDERS));
  assert.ok(Object.isFrozen(OAUTH_PROVIDERS.github));
  assert.ok(Object.isFrozen(OAUTH_PROVIDERS.github.identity));
  assert.ok(Object.isFrozen(OAUTH_PROVIDERS.github.extraParams));
  assert.ok(Object.isFrozen(OAUTH_SUPPORT));
});
