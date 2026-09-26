// Connectors with one-click sign-in through the service's official MCP server, mapped to the
// directory listing that serves them. The main process owns the server URLs
// (lib/mcp-directory.cjs); the renderer only passes the connector id to
// scalemaxAPI.mcp.signIn({ connectorId }). test/mcp-directory.test.mjs keeps both in sync.
export const MCP_SIGN_IN = Object.freeze({
  notion: 'notion',
  linear: 'linear',
  sentry: 'sentry',
  jira: 'atlassian',
  confluence: 'atlassian',
  stripe: 'stripe',
  vercel: 'vercel',
  cloudflare: 'cloudflare',
  intercom: 'intercom',
  supabase: 'supabase',
  netlify: 'netlify',
  airtable: 'airtable',
  dropbox: 'dropbox',
  zapier: 'zapier',
});

// Display names of the listings (Jira and Confluence share one Atlassian sign-in).
export const MCP_LISTING_NAMES = Object.freeze({
  notion: 'Notion',
  linear: 'Linear',
  sentry: 'Sentry',
  atlassian: 'Atlassian (Jira + Confluence)',
  stripe: 'Stripe',
  vercel: 'Vercel',
  cloudflare: 'Cloudflare Workers',
  intercom: 'Intercom',
  supabase: 'Supabase',
  netlify: 'Netlify',
  airtable: 'Airtable',
  dropbox: 'Dropbox',
  zapier: 'Zapier',
});
