'use strict';

// Official remote MCP servers that support zero-setup sign-in (MCP authorization with dynamic
// client registration and PKCE). Verified live on 2026-09-26: each one registered ScaleMax as a
// loopback client and served its real consent or login page for the resulting authorize URL.
//
// Not listed, and why (same check):
//   figma   registration refused (HTTP 403; approved clients only)
//   asana   registration only on the legacy SSE endpoint, which ScaleMax does not speak
//   github, hubspot, slack   no dynamic client registration
//
// The main process owns these URLs. The renderer only ever passes a connector id; its mirror in
// src/mcp-directory.js is kept in sync by test/mcp-directory.test.mjs.

const MCP_DIRECTORY = Object.freeze([
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', connectors: ['notion'] },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', connectors: ['linear'] },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', connectors: ['sentry'] },
  { id: 'atlassian', name: 'Atlassian (Jira + Confluence)', url: 'https://mcp.atlassian.com/v1/mcp', connectors: ['jira', 'confluence'] },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com/', connectors: ['stripe'] },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com/', connectors: ['vercel'] },
  { id: 'cloudflare', name: 'Cloudflare Workers', url: 'https://bindings.mcp.cloudflare.com/mcp', connectors: ['cloudflare'] },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', connectors: ['intercom'] },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', connectors: ['supabase'] },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp', connectors: ['netlify'] },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', connectors: ['airtable'] },
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', connectors: ['dropbox'] },
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', connectors: ['zapier'] },
].map((entry) => Object.freeze({ ...entry, connectors: Object.freeze([...entry.connectors]) })));

/** The directory listing that serves a connector, or null. */
function forConnector(connectorId) {
  if (typeof connectorId !== 'string') return null;
  return MCP_DIRECTORY.find((entry) => entry.connectors.includes(connectorId)) || null;
}

/** The directory listing with this id, or null. */
function byId(id) {
  return MCP_DIRECTORY.find((entry) => entry.id === id) || null;
}

module.exports = { MCP_DIRECTORY, forConnector, byId };
