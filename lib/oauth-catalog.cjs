'use strict';

// ScaleMax OAuth catalog (25 connectors), main process only. The renderer never supplies provider
// URLs: it passes a connector id and reads display details through connectors.getOAuthConfig.
// Part A (github .. asana) and part B (slack .. netlify) were checked against provider docs on 2026-09-26.
//
// Field notes:
// - scopes: ready-to-send string, already joined with scopeSeparator ('' = omit the scope param).
// - tokenAuth 'post': client_id (+ client_secret when one is configured) in the body; 'basic': HTTP Basic
//   (without a configured secret the engine falls back to client_id in the body).
// - tokenFormat: body encoding for both the code exchange and refresh ('form' | 'json').
// - secret: 'required' = confidential client, a client secret must be configured.
//           'optional' = a public client (PKCE, no secret) is supported; a secret is still sent if the
//                        registration has one.
//           'none'     = public client that must not send a secret (Microsoft "Mobile and desktop" apps,
//                        Slack and Zoom PKCE apps).
// - loopback: 'yes'            http://127.0.0.1:<port>/callback can be registered.
//             'localhost-only' Use http://localhost:<port>/callback (http is only accepted for the localhost
//                              hostname, so 127.0.0.1 is rejected or undocumented).
//             'no'             Provider requires HTTPS or has no usable redirect; the loopback flow can't work.
//             'unknown'        Docs don't say; test before relying on it.
// - redirectHost: host of the redirect URI: 'localhost' for 'localhost-only', otherwise '127.0.0.1'.
// - identity: called with `Authorization: Bearer <access_token>` unless noted. `{access_token}` in
//   identity.headers must be substituted by the caller (no Bearer header is added then). `field` is a dot
//   path; numeric segments index arrays (e.g. result.0.name).
// - refreshUrl (figma only): refresh uses a different endpoint than tokenUrl.
// - needsShop (shopify only): `{shop}` in URLs is replaced with the validated <store>.myshopify.com domain.

const OAUTH_PROVIDERS = {
  // ---------------------------------------------------------------------------------------------------
  // Part A (13 connectors). Checked against provider docs on 2026-09-26.
  // ---------------------------------------------------------------------------------------------------

  // verified: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // No scope already reads public repos/profile. Private repos need 'repo' (read/write; OAuth apps have
    // no read-only private-repo scope). Adding 'offline_access' opts into 8h tokens + refresh tokens.
    scopes: 'read:user',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'required',
    extraParams: {},
    // GitHub rejects requests without a User-Agent; Node/Electron fetch sends one by default.
    identity: {
      method: 'GET',
      url: 'https://api.github.com/user',
      field: 'login',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Register callback URL http://127.0.0.1/callback (or exactly http://127.0.0.1:53682/callback). For loopback callbacks GitHub lets redirect_uri use a different port; host and path must match. Prefer 127.0.0.1 over localhost.',
    registerUrl: 'https://github.com/settings/applications/new',
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
  },

  // verified: https://docs.sentry.io/api/auth/
  sentry: {
    authorizeUrl: 'https://sentry.io/oauth/authorize/',
    tokenUrl: 'https://sentry.io/oauth/token/',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'org:read project:read event:read',
    scopeSeparator: ' ',
    pkce: true,
    // Create the application with client type "Public" (PKCE + rotating refresh tokens, no secret).
    // A "Confidential" application also works if its secret is supplied.
    secret: 'optional',
    extraParams: {},
    // API index endpoint (undocumented but long-standing): no scope required, returns the token owner.
    identity: { method: 'GET', url: 'https://sentry.io/api/0/', field: 'user.email' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Register http://127.0.0.1:53682/callback exactly. Sentry also matches a loopback URI registered without a port against any port (host, path and query must match). The token only covers the organization chosen on the consent screen.',
    registerUrl: 'https://sentry.io/settings/account/api/applications/',
    docsUrl: 'https://docs.sentry.io/api/auth/',
  },

  // verified: https://developers.notion.com/guides/get-started/authorization
  notion: {
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    tokenAuth: 'basic',
    tokenFormat: 'json',
    // Notion has no OAuth scopes; capabilities are configured on the public connection.
    scopes: '',
    scopeSeparator: ' ',
    pkce: false,
    secret: 'required',
    extraParams: { owner: 'user' },
    // Returns the connection's bot user; owner.user is the authorizing person. The name is only
    // present when the connection has a user-information capability enabled.
    identity: {
      method: 'GET',
      url: 'https://api.notion.com/v1/users/me',
      field: 'bot.owner.user.name',
      headers: { 'Notion-Version': '2026-03-11' },
    },
    loopback: 'unknown',
    redirectHost: '127.0.0.1',
    redirectNote: 'Add http://127.0.0.1:53682/callback as a redirect URI on the public connection and expect an exact match (port included). Notion docs say nothing about http or loopback redirects; http://localhost callbacks are common in practice, 127.0.0.1 is unconfirmed.',
    registerUrl: 'https://www.notion.so/developers',
    docsUrl: 'https://developers.notion.com/guides/get-started/authorization',
  },

  // verified: https://developers.google.com/identity/protocols/oauth2/native-app
  'google-drive': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Restricted scope: public release needs Google verification; in "Testing" status refresh tokens last 7 days.
    scopes: 'https://www.googleapis.com/auth/drive.readonly',
    scopeSeparator: ' ',
    pkce: true,
    // Current installed-app docs list client_secret as optional for the code exchange and refresh.
    secret: 'optional',
    // Desktop clients always receive a refresh token; these two matter only for Web-type clients.
    extraParams: { access_type: 'offline', prompt: 'consent' },
    identity: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user', field: 'user.emailAddress' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Create an OAuth client of type "Desktop app": it accepts http://127.0.0.1 on any port with no redirect URI registration. A Web-type client would need the exact URI registered. Enable the Drive API in the same project.',
    registerUrl: 'https://console.cloud.google.com/auth/clients',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  },

  // verified: https://developers.google.com/identity/protocols/oauth2/native-app
  'google-calendar': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Sensitive scope: public release needs Google verification; in "Testing" status refresh tokens last 7 days.
    scopes: 'https://www.googleapis.com/auth/calendar.readonly',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: { access_type: 'offline', prompt: 'consent' },
    // The primary calendar's id is normally the account's primary email address.
    identity: { method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary', field: 'id' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Create an OAuth client of type "Desktop app": it accepts http://127.0.0.1 on any port with no redirect URI registration. A Web-type client would need the exact URI registered. Enable the Calendar API in the same project.',
    registerUrl: 'https://console.cloud.google.com/auth/clients',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  },

  // verified: https://developers.google.com/identity/protocols/oauth2/native-app
  gmail: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Restricted scope: public release needs Google verification; in "Testing" status refresh tokens last 7 days.
    scopes: 'https://www.googleapis.com/auth/gmail.readonly',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: { access_type: 'offline', prompt: 'consent' },
    identity: { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', field: 'emailAddress' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Create an OAuth client of type "Desktop app": it accepts http://127.0.0.1 on any port with no redirect URI registration. A Web-type client would need the exact URI registered. Enable the Gmail API in the same project.',
    registerUrl: 'https://console.cloud.google.com/auth/clients',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  },

  // verified: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
  onedrive: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // User.Read is needed for /me; offline_access is needed for a refresh token.
    scopes: 'User.Read Files.Read offline_access',
    scopeSeparator: ' ',
    pkce: true,
    // Public client: sending a secret for a "Mobile and desktop" redirect makes the token call fail.
    secret: 'none',
    extraParams: {},
    identity: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me', field: 'userPrincipalName' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Register the redirect under the "Mobile and desktop applications" platform. The portal text box rejects http with 127.0.0.1, so add http://127.0.0.1/callback through the app manifest (public client redirect URIs). Ports are ignored when matching loopback redirects; [::1] is not supported. Account types must include personal accounts for consumer OneDrive; single-tenant apps must replace "common" with their tenant ID.',
    registerUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow',
  },

  // verified: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
  'microsoft-teams': {
    // Teams Graph APIs do not support personal Microsoft accounts, so sign-in is limited to work/school.
    authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Delegated Team.ReadBasic.All / Channel.ReadBasic.All do not need admin consent (tenant policy may still block user consent).
    scopes: 'User.Read Team.ReadBasic.All Channel.ReadBasic.All offline_access',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'none',
    extraParams: {},
    identity: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me', field: 'userPrincipalName' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Same registration as OneDrive: "Mobile and desktop applications" public client, http://127.0.0.1/callback added through the app manifest, no secret. Ports are ignored for loopback matching. Single-tenant apps must replace "organizations" with their tenant ID.',
    registerUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow',
  },

  // verified: https://developers.dropbox.com/oauth-guide
  dropbox: {
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    // Body credentials so a PKCE-only (secretless) client can send just client_id + code_verifier.
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Each scope must also be ticked on the app's Permissions tab.
    scopes: 'account_info.read files.metadata.read files.content.read',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: { token_access_type: 'offline' },
    // RPC endpoint with no arguments: send JSON null (or no body and no Content-Type).
    identity: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/users/get_current_account',
      field: 'email',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Add http://127.0.0.1:53682/callback in the App Console. Dropbox requires an exact match including port and path, and allows http only for local addresses (its own SDK samples use http://127.0.0.1).',
    registerUrl: 'https://www.dropbox.com/developers/apps',
    docsUrl: 'https://developers.dropbox.com/oauth-guide',
  },

  // verified: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
  jira: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'json',
    // Add the Jira API and the User Identity API (read:me) to the app; only registered scopes can be requested.
    scopes: 'read:jira-work read:me offline_access',
    scopeSeparator: ' ',
    // 3LO has no PKCE or public clients. Atlassian policy also says integrations should ship one
    // distributable 3LO app rather than ask each customer to create their own.
    pkce: false,
    secret: 'required',
    extraParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    identity: { method: 'GET', url: 'https://api.atlassian.com/me', field: 'email', headers: { Accept: 'application/json' } },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'redirect_uri must equal the callback URL set under Authorization in the developer console (port included). Docs do not cover loopback; the console is reported to allow http only for localhost callbacks, so http://127.0.0.1 may be refused and http://localhost:53682/callback is the safer choice.',
    registerUrl: 'https://developer.atlassian.com/console/myapps/',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/',
  },

  // verified: https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/
  confluence: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'json',
    // Classic scopes (recommended by Atlassian); content.all does not substitute for space.summary.
    scopes: 'read:confluence-space.summary read:confluence-content.all read:me offline_access',
    scopeSeparator: ' ',
    pkce: false,
    secret: 'required',
    extraParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    identity: { method: 'GET', url: 'https://api.atlassian.com/me', field: 'email', headers: { Accept: 'application/json' } },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'redirect_uri must equal the callback URL set under Authorization in the developer console (port included). Docs do not cover loopback; the console is reported to allow http only for localhost callbacks, so http://127.0.0.1 may be refused and http://localhost:53682/callback is the safer choice.',
    registerUrl: 'https://developer.atlassian.com/console/myapps/',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/',
  },

  // verified: https://linear.app/developers/oauth-2-0-authentication
  linear: {
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'read',
    scopeSeparator: ',',
    pkce: true,
    // With PKCE the secret is optional for both the exchange and refresh (24h access tokens, rotating refresh).
    secret: 'optional',
    extraParams: {},
    // OAuth tokens use "Bearer" (personal API keys do not). GraphQL returns 200 on auth errors, so check data.viewer.
    identity: {
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      field: 'data.viewer.email',
      requireField: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { id name email } }' }),
    },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Add http://127.0.0.1:53682/callback as a callback URL on the OAuth application; redirect_uri must match it. The docs example uses an http://localhost callback; port-agnostic loopback matching is not documented, so register the exact port.',
    registerUrl: 'https://linear.app/settings/api/applications/new',
    docsUrl: 'https://linear.app/developers/oauth-2-0-authentication',
  },

  // verified: https://developers.asana.com/docs/oauth
  asana: {
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    // Register exactly these scopes (not "Full permissions"; with Full permissions the scope param must be omitted).
    scopes: 'users:read workspaces:read projects:read tasks:read',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'required',
    extraParams: {},
    // users:read is required for /users/me and its email field.
    identity: { method: 'GET', url: 'https://app.asana.com/api/1.0/users/me', field: 'data.email' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Docs require https redirect URLs, with urn:ietf:wg:oauth:2.0:oob for native apps (this flow cannot receive OOB codes). Asana\'s own 2025 OAuth demo registers http://localhost:4567/oauth-callback and an older forum answer limits the http exception to URLs starting with http://localhost, so 127.0.0.1 is likely refused; a 2026 forum reply calls localhost unsupported, so treat loopback as fragile. Exact match, port included.',
    registerUrl: 'https://app.asana.com/0/my-apps',
    docsUrl: 'https://developers.asana.com/docs/oauth',
  },

  // ---------------------------------------------------------------------------------------------------
  // Part B (slack .. netlify, 12 connectors). Checked against each provider's official docs on 2026-09-26.
  // ---------------------------------------------------------------------------------------------------

  // verified: https://docs.slack.dev/authentication/installing-with-oauth
  // Also: https://docs.slack.dev/authentication/using-pkce, https://docs.slack.dev/reference/methods/oauth.v2.user.access
  // The user-only v2_user flow returns the xoxp user token at top-level access_token (no tokenPath needed).
  // Classic alternative: https://slack.com/oauth/v2/authorize + extraParams.user_scope, then the user token
  // is at authed_user.access_token (and refresh data under authed_user when token rotation is on).
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2_user/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.user.access',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'channels:read,channels:history,users:read',
    scopeSeparator: ',',
    pkce: true,
    // PKCE turns the app into a public client: the code exchange sends no client_secret.
    secret: 'none',
    extraParams: {},
    // auth.test answers 200 with ok:false for a bad token, so the identity field must be present.
    identity: { method: 'POST', url: 'https://slack.com/api/auth.test', field: 'user', requireField: true },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Redirect URLs must be HTTPS unless PKCE is turned on under OAuth & Permissions (one-way switch; the app becomes a public client). With PKCE on, http://localhost:<port> counts as a desktop redirect, so register http://localhost:53682/callback. 127.0.0.1 is not documented. Desktop redirects cannot request bot scopes, and the code exchange sends no client_secret. Refresh tokens expire after 30 days once PKCE is on.',
    registerUrl: 'https://api.slack.com/apps',
    docsUrl: 'https://docs.slack.dev/authentication/installing-with-oauth',
  },

  // verified: https://docs.discord.com/developers/topics/oauth2
  // PKCE and the Public Client toggle are documented in the Social SDK guide:
  // https://docs.discord.com/developers/discord-social-sdk/development-guides/account-linking-with-discord
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'identify guilds',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'required',
    extraParams: {},
    identity: { method: 'GET', url: 'https://discord.com/api/v10/users/@me', field: 'username' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Register the exact URI http://127.0.0.1:53682/callback under OAuth2 > Redirects; the match includes the port. Discord\'s own desktop guidance uses an http://127.0.0.1 callback. The token endpoint accepts form bodies only (JSON is rejected). The secret can be dropped only if the app enables Public Client and uses PKCE.',
    registerUrl: 'https://discord.com/developers/applications',
    docsUrl: 'https://docs.discord.com/developers/topics/oauth2',
  },

  // verified: https://developers.zoom.us/docs/integrations/oauth/
  // Scopes are chosen on the Marketplace app (granular scopes), not sent in the authorize URL.
  // Needed for identity: user:read:user. Basic read example: meeting:read:list_meetings.
  zoom: {
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: '',
    scopeSeparator: ' ',
    pkce: true,
    // Public Client OAuth: the exchange sends client_id + code_verifier and no secret.
    secret: 'none',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.zoom.us/v2/users/me', field: 'email' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Loopback works only for PKCE public clients: turn on "Use Public Client OAuth" under App Credentials and use the public client ID (the exchange sends client_id + code_verifier with no Authorization header). Register http://127.0.0.1/callback in the redirect/allow list; Zoom ignores the port but not the host, so do not use localhost. Non-PKCE apps must use HTTPS. Add scope user:read:user on the app\'s Scopes page.',
    registerUrl: 'https://marketplace.zoom.us/',
    docsUrl: 'https://developers.zoom.us/docs/integrations/oauth/',
  },

  // verified: https://github.com/Airtable/oauth-example
  // Official Airtable example repo. The reference page (https://airtable.com/developers/web/api/oauth-reference)
  // renders client-side only and could not be fetched.
  airtable: {
    authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
    tokenUrl: 'https://airtable.com/oauth2/v1/token',
    // Airtable requires HTTP Basic when the integration has a secret; with no secret configured the engine
    // falls back to client_id in the body.
    tokenAuth: 'basic',
    tokenFormat: 'form',
    scopes: 'data.records:read schema.bases:read user.email:read',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.airtable.com/v0/meta/whoami', field: 'email' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'PKCE (S256) is mandatory. The redirect URI must match exactly; Airtable\'s official example registers http://localhost:<port>/..., so register http://localhost:53682/callback (127.0.0.1 is undocumented). Don\'t generate a client secret for a desktop app: with no secret, client_id goes in the body. If the integration has a secret, Airtable requires HTTP Basic auth instead (tokenAuth basic).',
    registerUrl: 'https://airtable.com/create/oauth',
    docsUrl: 'https://github.com/Airtable/oauth-example',
  },

  // verified: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
  // Token endpoint: https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
  // v1 OAuth endpoints stop working 2027-02-16; semver (v3) APIs are unsupported from Sept 2027.
  // Identity alternative with the user's email: POST /oauth/2026-09/token/introspect (form body with
  // client_id, client_secret, token, token_type_hint=access_token) -> field "user". It is not Bearer-callable.
  hubspot: {
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/2026-09/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'oauth crm.objects.contacts.read',
    scopeSeparator: ' ',
    pkce: false,
    secret: 'required',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.hubapi.com/account-info/2026-09/details', field: 'portalName' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Redirects must be HTTPS, except http://localhost for testing. IP addresses are not supported, so 127.0.0.1 fails: add http://localhost:53682/callback to redirectUrls in app-hsmeta.json. Apps are created with the HubSpot CLI (hs project create / upload). The scope param must include every required scope configured on the app.',
    registerUrl: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app',
    docsUrl: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth',
  },

  // verified: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html
  // Also: https://developer.salesforce.com/docs/platform/mobile-sdk/guide/eca-create.html (secret-less ECA settings),
  // https://developer.salesforce.com/docs/platform/mobile-sdk/guide/oauth-scope-parameter-values.html (scopes).
  // The token response has no expires_in and includes instance_url, which API calls must use.
  salesforce: {
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'api refresh_token openid',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: {},
    identity: { method: 'GET', url: 'https://login.salesforce.com/services/oauth2/userinfo', field: 'preferred_username' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Create an External Client App (Setup > External Client App Manager); new connected apps are restricted since Spring \'26. Use callback http://localhost:53682/callback; Salesforce allows http only for localhost, and 127.0.0.1 is reported to be rejected. Enable PKCE and uncheck "Require Secret for Web Server Flow" and "Require Secret for Refresh Token Flow". Select scopes api, refresh_token and openid. For sandboxes, swap login.salesforce.com for test.salesforce.com.',
    registerUrl: 'https://developer.salesforce.com/docs/platform/mobile-sdk/guide/eca-create.html',
    docsUrl: 'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html',
  },

  // verified: https://developers.figma.com/docs/rest-api/oauth-apps/
  // file_read / files:read were removed in Nov 2025; granular scopes are required.
  // Refresh: POST refreshUrl with Basic auth and body refresh_token=...; the response has no new
  // refresh_token (the old one stays valid), so keep the stored refresh token.
  figma: {
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
    tokenAuth: 'basic',
    tokenFormat: 'form',
    scopes: 'current_user:read file_content:read',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'required',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.figma.com/v1/me', field: 'email' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'The docs don\'t state loopback rules. Developers on Figma\'s forum report http://localhost:<port>/callback working, so register http://localhost:53682/callback (127.0.0.1 is untested). The code expires 30 seconds after consent, so exchange it immediately. The client secret is always required (HTTP Basic). The app can stay private to your team, which skips Figma review.',
    registerUrl: 'https://www.figma.com/developers/apps',
    docsUrl: 'https://developers.figma.com/docs/rest-api/oauth-apps/',
  },

  // verified: https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth
  // Scopes are configured in the Developer Hub. The token response carries both `token` and `access_token`.
  // EU/AU workspaces use app.eu.intercom.com / app.au.intercom.com and api.eu.intercom.io / api.au.intercom.io.
  intercom: {
    authorizeUrl: 'https://app.intercom.com/oauth',
    tokenUrl: 'https://api.intercom.io/auth/eagle/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: '',
    scopeSeparator: ' ',
    pkce: false,
    secret: 'required',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.intercom.io/me', field: 'email' },
    loopback: 'no',
    redirectHost: '127.0.0.1',
    redirectNote: 'Intercom requires HTTPS redirect URLs, so the http loopback flow can\'t work. Use an Intercom access token (token path) or an HTTPS callback you host.',
    registerUrl: 'https://app.intercom.com/a/apps/_/developer-hub',
    docsUrl: 'https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth',
  },

  // verified: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
  // Admin API tokens go in X-Shopify-Access-Token, not Authorization: Bearer. 2026-07 is the latest stable version.
  // Optional: add expiring=1 to the code-exchange body to get 60-minute tokens plus a 90-day refresh token.
  // That is mandatory for public apps, but not for custom-distribution apps.
  // No-redirect alternative for your own store: client credentials grant (24 h tokens),
  // https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
  shopify: {
    authorizeUrl: 'https://{shop}/admin/oauth/authorize',
    tokenUrl: 'https://{shop}/admin/oauth/access_token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'read_products',
    scopeSeparator: ',',
    pkce: false,
    secret: 'required',
    needsShop: true,
    extraParams: {},
    identity: {
      method: 'POST',
      url: 'https://{shop}/admin/api/2026-07/graphql.json',
      field: 'data.shop.name',
      // GraphQL reports auth errors in a 200 body, so the shop name must be present.
      requireField: true,
      headers: { 'X-Shopify-Access-Token': '{access_token}', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    },
    loopback: 'unknown',
    redirectHost: '127.0.0.1',
    redirectNote: 'The redirect must exactly match one configured on the Dev Dashboard app. Shopify doesn\'t document plain-http loopback: its local tooling uses HTTPS (a tunnel or a mkcert https://localhost cert), community reports use https://127.0.0.1, and the redirect host may have to match the app URL host. Test http://127.0.0.1:53682/callback before relying on it. Validate `shop` against ^[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com$ and verify the callback hmac.',
    registerUrl: 'https://dev.shopify.com/dashboard',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant',
  },

  // verified: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
  // Endpoints: https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
  // Self-managed third-party OAuth launched 2026-06-03. Scope IDs are dot-delimited (colon style is rejected);
  // the full list is at GET /client/v4/oauth/scopes. The OIDC userinfo endpoint only returns `sub`, so identity
  // uses the first account name instead.
  cloudflare: {
    authorizeUrl: 'https://dash.cloudflare.com/oauth2/auth',
    tokenUrl: 'https://dash.cloudflare.com/oauth2/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'account.read offline_access',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.cloudflare.com/client/v4/accounts', field: 'result.0.name' },
    loopback: 'yes',
    redirectHost: '127.0.0.1',
    redirectNote: 'Create a client under Manage Account > OAuth clients. For desktop apps, choose Authorization Code with PKCE (S256), token auth method "none", and grant types authorization_code plus refresh_token. The docs don\'t spell out loopback rules, but they recommend this setup for desktop/CLI apps and Wrangler itself uses a localhost callback. Register http://127.0.0.1:53682/callback. Private clients can only be authorized by members of your account.',
    registerUrl: 'https://dash.cloudflare.com/?to=/:account/oauth-clients',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/',
  },

  // verified: https://vercel.com/docs/sign-in-with-vercel/authorization-server-api
  // Also: https://vercel.com/docs/sign-in-with-vercel/manage-from-dashboard, https://vercel.com/.well-known/openid-configuration
  // This is "Sign in with Vercel" (standard OAuth/OIDC). The old draft mixed its authorize URL with the
  // Integrations token endpoint (api.vercel.com/v2/oauth/access_token), which belongs to the separate
  // integration install flow (vercel.com/integrations/<slug>/new) and does not work with this authorize URL.
  vercel: {
    authorizeUrl: 'https://vercel.com/oauth/authorize',
    tokenUrl: 'https://api.vercel.com/login/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: 'openid email offline_access',
    scopeSeparator: ' ',
    pkce: true,
    secret: 'optional',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.vercel.com/login/oauth/userinfo', field: 'email' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Create an App under Team Settings > Apps. Add Authorization Callback URL http://localhost:53682/callback; the docs use http://localhost for local development, and 127.0.0.1 is undocumented. PKCE S256 is required. Choose client authentication "none" for a secret-less desktop client. Enable openid, email and offline_access on the Permissions page. Access tokens currently cover identity only (REST API permissions are in private beta), so reading projects or deployments still needs a Vercel access token or a Vercel Integration.',
    registerUrl: 'https://vercel.com/dashboard',
    docsUrl: 'https://vercel.com/docs/sign-in-with-vercel/authorization-server-api',
  },

  // verified: https://docs.netlify.com/api/get-started/
  // Also: https://developers.netlify.com/guides/generating-personal-access-tokens-with-netlify-oauth/
  // The token endpoint isn't listed in the main docs; it's confirmed on Netlify's forum
  // (https://answers.netlify.com/t/oauth-application-with-response-type-code/26467).
  // Tokens don't expire and no refresh token is issued. There are no scopes.
  netlify: {
    authorizeUrl: 'https://app.netlify.com/authorize',
    tokenUrl: 'https://api.netlify.com/oauth/token',
    tokenAuth: 'post',
    tokenFormat: 'form',
    scopes: '',
    scopeSeparator: ' ',
    pkce: false,
    secret: 'required',
    extraParams: {},
    identity: { method: 'GET', url: 'https://api.netlify.com/api/v1/user', field: 'email' },
    loopback: 'localhost-only',
    redirectHost: 'localhost',
    redirectNote: 'Register an OAuth app under User settings > Applications. Netlify\'s own guide uses http://localhost:8888/ as the redirect, so register http://localhost:53682/callback (127.0.0.1 is undocumented).',
    registerUrl: 'https://app.netlify.com/user/applications',
    docsUrl: 'https://docs.netlify.com/api/get-started/',
  },
};

// The catalog is shared configuration owned by the main process; freeze it so no caller can
// rewrite a provider URL at runtime.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

module.exports = { OAUTH_PROVIDERS: deepFreeze(OAUTH_PROVIDERS) };
