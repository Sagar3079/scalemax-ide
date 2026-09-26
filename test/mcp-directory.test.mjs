import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MCP_SIGN_IN, MCP_LISTING_NAMES } from '../src/mcp-directory.js';
import { CONNECTOR_CATALOG } from '../src/connector-catalog.js';

const require = createRequire(import.meta.url);
const { MCP_DIRECTORY, forConnector, byId } = require('../lib/mcp-directory.cjs');

test('the renderer mirror matches the main-process directory', () => {
  const expected = {};
  for (const listing of MCP_DIRECTORY) for (const connector of listing.connectors) expected[connector] = listing.id;
  assert.deepEqual({ ...MCP_SIGN_IN }, expected);
  assert.deepEqual({ ...MCP_LISTING_NAMES }, Object.fromEntries(MCP_DIRECTORY.map((listing) => [listing.id, listing.name])));
});

test('every listing serves real catalog connectors over https', () => {
  const connectorIds = new Set(CONNECTOR_CATALOG.map((entry) => entry.id));
  const seen = new Set();
  for (const listing of MCP_DIRECTORY) {
    assert.match(listing.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.equal(new URL(listing.url).protocol, 'https:');
    assert.ok(listing.connectors.length > 0);
    for (const connector of listing.connectors) {
      assert.ok(connectorIds.has(connector), `${connector} is not in the connector catalog`);
      assert.equal(seen.has(connector), false, `${connector} is listed twice`);
      seen.add(connector);
      assert.equal(forConnector(connector), listing);
    }
    assert.equal(byId(listing.id), listing);
  }
  assert.equal(forConnector('github'), null);
  assert.equal(forConnector('constructor'), null);
  assert.equal(byId('toString'), null);
  assert.ok(Object.isFrozen(MCP_DIRECTORY) && Object.isFrozen(MCP_DIRECTORY[0]));
});
