// Connectors with OAuth sign-in, mapped to how their provider treats the loopback redirect:
// 'yes' | 'localhost-only' | 'unknown' | 'no' ('no' = connect with an access token instead).
// The main process owns every provider URL, scope and secret rule (lib/oauth-catalog.cjs);
// read those through scalemaxAPI.connectors.getOAuthConfig({ id }).
export const OAUTH_SUPPORT = Object.freeze({
  github: 'yes',
  sentry: 'yes',
  notion: 'unknown',
  'google-drive': 'yes',
  'google-calendar': 'yes',
  gmail: 'yes',
  onedrive: 'yes',
  'microsoft-teams': 'yes',
  dropbox: 'yes',
  jira: 'localhost-only',
  confluence: 'localhost-only',
  linear: 'yes',
  asana: 'localhost-only',
  slack: 'localhost-only',
  discord: 'yes',
  zoom: 'yes',
  airtable: 'localhost-only',
  hubspot: 'localhost-only',
  salesforce: 'localhost-only',
  figma: 'localhost-only',
  intercom: 'no',
  shopify: 'unknown',
  cloudflare: 'yes',
  vercel: 'localhost-only',
  netlify: 'localhost-only',
});
