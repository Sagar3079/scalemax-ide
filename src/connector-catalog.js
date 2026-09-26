// Curated setup metadata; official documentation researched on 2026-09-15.
// Capabilities describe provider possibilities, not implemented ScaleMax features.
// This catalog installs nothing and grants no authorization; provider calls happen only in the main process.
// Credentials live in the main-process secret store (lib/connectors.cjs), never in this catalog or client code.
// Authentication summaries cover selected setup paths, not every provider-supported method.
export const CONNECTOR_CATALOG = [
  // Development
  {
    "id": "github",
    "name": "GitHub",
    "category": "Development",
    "description": "Setup guide for repository hosting, issue tracking, and pull request workflows.",
    "auth": "A personal access token can authorize REST API requests; required permissions depend on the operation.",
    "docsUrl": "https://docs.github.com/v3/auth",
    "homepage": "https://github.com/",
    "setupSteps": [
      "Create a personal access token in GitHub for the intended account and repositories.",
      "Approve only required access and keep the token in a server-side secret store.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Repository metadata", "Issues", "Pull requests"],
    "featured": true
  },
  {
    "id": "docker-hub",
    "name": "Docker Hub",
    "category": "Development",
    "description": "Setup guide for container image repositories and registry account metadata.",
    "auth": "Personal or organization access tokens support API authentication; token permissions and account policies limit access.",
    "docsUrl": "https://docs.docker.com/reference/api/hub/latest/",
    "homepage": "https://hub.docker.com/",
    "setupSteps": [
      "Choose a Docker Hub account or organization and its intended repositories.",
      "Create an appropriate access token with limited permissions and store it server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Repository metadata", "Image tags", "Organization metadata"],
    "featured": false
  },
  {
    "id": "sentry",
    "name": "Sentry",
    "category": "Development",
    "description": "Setup guide for application error tracking and release observability.",
    "auth": "API access uses authentication tokens from an internal integration or user account; token type and permissions depend on the endpoint.",
    "docsUrl": "https://docs.sentry.io/api/auth/",
    "homepage": "https://sentry.io/",
    "setupSteps": [
      "Choose a Sentry organization and create an internal integration or suitable user token.",
      "Grant only required project permissions and store the token server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Error issues", "Project metadata", "Release metadata"],
    "featured": true
  },

  // Productivity
  {
    "id": "notion",
    "name": "Notion",
    "category": "Productivity",
    "description": "Setup guide for workspace pages, structured content, and knowledge workflows.",
    "auth": "Internal connections use a workspace token; public connections use OAuth 2.0 with user-approved content access.",
    "docsUrl": "https://developers.notion.com/guides/get-started/authorization",
    "homepage": "https://www.notion.com/",
    "setupSteps": [
      "Create an internal or public connection in the Notion developer portal.",
      "Share required pages with the internal connection or configure public OAuth consent.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Pages", "Data sources", "Content search"],
    "featured": true
  },
  {
    "id": "google-drive",
    "name": "Google Drive",
    "category": "Productivity",
    "description": "Setup guide for cloud files, folders, and controlled document sharing.",
    "auth": "OAuth 2.0 authorizes user data access; consent, requested permissions, and Google verification requirements apply.",
    "docsUrl": "https://developers.google.com/workspace/drive/api/guides/about-sdk",
    "homepage": "https://drive.google.com/",
    "setupSteps": [
      "Enable the Drive API in a Google Cloud project and configure an OAuth client.",
      "Configure consent and minimum file access; complete required Google verification before release.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["File search", "File transfers", "Sharing permissions"],
    "featured": true
  },
  {
    "id": "google-calendar",
    "name": "Google Calendar",
    "category": "Productivity",
    "description": "Setup guide for calendars, scheduled events, and attendee information.",
    "auth": "OAuth 2.0 authorizes user calendar access; permissions and consent determine accessible calendars and operations.",
    "docsUrl": "https://developers.google.com/workspace/calendar/api/guides/overview",
    "homepage": "https://calendar.google.com/",
    "setupSteps": [
      "Enable the Calendar API in a Google Cloud project and configure an OAuth client.",
      "Configure consent for minimum calendar access and satisfy applicable verification requirements.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Calendar lists", "Events", "Calendar permissions"],
    "featured": true
  },
  {
    "id": "onedrive",
    "name": "OneDrive",
    "category": "Productivity",
    "description": "Setup guide for Microsoft cloud files through Microsoft Graph.",
    "auth": "Microsoft identity platform access tokens authorize Graph requests; delegated or application access depends on the operation and account type.",
    "docsUrl": "https://learn.microsoft.com/en-us/graph/onedrive-concept-overview",
    "homepage": "https://www.microsoft.com/en-us/microsoft-365/onedrive/online-cloud-storage",
    "setupSteps": [
      "Register a Microsoft Entra application for the intended OneDrive account types.",
      "Configure supported Graph file permissions and obtain user or administrator consent as required.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Files and folders", "Sharing links", "Change tracking"],
    "featured": false
  },
  {
    "id": "dropbox",
    "name": "Dropbox",
    "category": "Productivity",
    "description": "Setup guide for cloud file storage and file-sharing workflows.",
    "auth": "OAuth 2.0 authorizes access; app permissions and the selected content access model limit available data.",
    "docsUrl": "https://developers.dropbox.com/oauth-guide",
    "homepage": "https://www.dropbox.com/",
    "setupSteps": [
      "Register a Dropbox app and choose its file access model and redirect configuration.",
      "Request minimum permissions and arrange user OAuth consent; protect tokens server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["File metadata", "File transfers", "Shared links"],
    "featured": false
  },
  {
    "id": "jira",
    "name": "Jira",
    "category": "Productivity",
    "description": "Setup guide for Jira Cloud issues, project tracking, and workflow metadata.",
    "auth": "Atlassian OAuth 2.0 three-legged authorization grants user-approved Jira Cloud access, constrained by app and user permissions.",
    "docsUrl": "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
    "homepage": "https://www.atlassian.com/software/jira",
    "setupSteps": [
      "Register an OAuth integration in the Atlassian developer console and configure its callback.",
      "Select required Jira permissions and arrange user authorization for the intended sites.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Issues", "Projects", "Workflow transitions"],
    "featured": true
  },
  {
    "id": "confluence",
    "name": "Confluence",
    "category": "Productivity",
    "description": "Setup guide for Confluence Cloud documentation and team knowledge spaces.",
    "auth": "Atlassian OAuth 2.0 three-legged authorization grants access constrained by approved permissions and the user's content access.",
    "docsUrl": "https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/",
    "homepage": "https://www.atlassian.com/software/confluence",
    "setupSteps": [
      "Register an Atlassian OAuth integration and configure its callback and Confluence permissions.",
      "Arrange user authorization for the intended sites and confirm access to required spaces.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Pages", "Spaces", "Content search"],
    "featured": false
  },
  {
    "id": "linear",
    "name": "Linear",
    "category": "Productivity",
    "description": "Setup guide for product issue tracking through Linear's GraphQL API.",
    "auth": "Personal API keys support individual tooling; OAuth 2.0 is recommended for applications used by others.",
    "docsUrl": "https://linear.app/developers/graphql",
    "homepage": "https://linear.app/",
    "setupSteps": [
      "Create a Linear personal API key or register an OAuth application for shared use.",
      "Authorize the intended workspace and limit access to the required teams and operations.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Issues", "Teams", "Workflow states"],
    "featured": true
  },
  {
    "id": "trello",
    "name": "Trello",
    "category": "Productivity",
    "description": "Setup guide for board-based planning, lists, and task cards.",
    "auth": "REST access uses an app API key and a user-authorized token; Trello also documents OAuth 1.0.",
    "docsUrl": "https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/",
    "homepage": "https://trello.com/",
    "setupSteps": [
      "Create a Trello Power-Up app key and configure any required redirect origins.",
      "Arrange user token authorization for required board operations and protect the token.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Boards", "Lists", "Cards"],
    "featured": false
  },
  {
    "id": "asana",
    "name": "Asana",
    "category": "Productivity",
    "description": "Setup guide for team tasks, project organization, and work tracking.",
    "auth": "Personal access tokens act with the owner's permissions; OAuth supports apps used by multiple users.",
    "docsUrl": "https://developers.asana.com/docs/authentication",
    "homepage": "https://asana.com/",
    "setupSteps": [
      "Create a personal token or register an OAuth app in the Asana developer console.",
      "Arrange authorized workspace access and protect credentials with minimum necessary permissions.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Tasks", "Projects", "Workspace metadata"],
    "featured": false
  },

  // Communication
  {
    "id": "slack",
    "name": "Slack",
    "category": "Communication",
    "description": "Setup guide for workspace messaging and channel-based collaboration.",
    "auth": "Slack apps use OAuth 2.0 and permission-limited tokens; token type and workspace approval depend on the intended operation.",
    "docsUrl": "https://docs.slack.dev/authentication/",
    "homepage": "https://slack.com/",
    "setupSteps": [
      "Create a Slack app and configure only the required bot or user permissions.",
      "Arrange app installation and authorization in the intended workspace, including required admin approval.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Messages", "Channel metadata", "Event subscriptions"],
    "featured": true
  },
  {
    "id": "discord",
    "name": "Discord",
    "category": "Communication",
    "description": "Setup guide for authorized bot interactions and community messaging.",
    "auth": "Bot tokens authenticate bot accounts; OAuth 2.0 handles supported user authorization and app installation flows.",
    "docsUrl": "https://docs.discord.com/developers/topics/oauth2",
    "homepage": "https://discord.com/",
    "setupSteps": [
      "Create a Discord application and configure its bot, installation settings, and required permissions.",
      "Have an authorized user approve installation in the intended server; keep bot credentials private.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Bot messages", "Channel metadata", "Application commands"],
    "featured": true
  },
  {
    "id": "microsoft-teams",
    "name": "Microsoft Teams",
    "category": "Communication",
    "description": "Setup guide for team collaboration resources through Microsoft Graph.",
    "auth": "Microsoft identity platform tokens authorize Graph access; supported delegated or application permissions and tenant consent vary by operation.",
    "docsUrl": "https://learn.microsoft.com/en-us/graph/teams-concept-overview",
    "homepage": "https://www.microsoft.com/en-us/microsoft-teams/group-chat-software",
    "setupSteps": [
      "Register a Microsoft Entra application for the intended tenant and Teams operations.",
      "Select supported Graph permissions and obtain required user or administrator consent.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Teams", "Channels", "Online meetings"],
    "featured": true
  },
  {
    "id": "gmail",
    "name": "Gmail",
    "category": "Communication",
    "description": "Setup guide for authorized mailbox, message, and draft workflows.",
    "auth": "OAuth 2.0 authorizes mailbox access; sensitive or restricted permissions may require Google verification and security assessment.",
    "docsUrl": "https://developers.google.com/workspace/gmail/api/guides",
    "homepage": "https://mail.google.com/",
    "setupSteps": [
      "Enable the Gmail API in a Google Cloud project and configure an OAuth client.",
      "Configure minimum mailbox permissions and user consent; satisfy applicable verification requirements.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Messages", "Drafts", "Labels"],
    "featured": true
  },
  {
    "id": "zoom",
    "name": "Zoom",
    "category": "Communication",
    "description": "Setup guide for authorized meeting and account workflows.",
    "auth": "User OAuth authorizes API requests on a user's behalf; app permissions and account policies determine access.",
    "docsUrl": "https://developers.zoom.us/docs/integrations/oauth/",
    "homepage": "https://www.zoom.com/",
    "setupSteps": [
      "Create a General app in Zoom Marketplace and configure OAuth redirects and permissions.",
      "Arrange user authorization and required account approval; protect access and refresh tokens.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Meetings", "User profiles", "Webinars"],
    "featured": false
  },
  {
    "id": "twilio",
    "name": "Twilio",
    "category": "Communication",
    "description": "Setup guide for programmable messaging, voice, and communication events.",
    "auth": "Twilio recommends API key credentials for applications, using HTTP Basic authentication; account and regional permissions apply.",
    "docsUrl": "https://www.twilio.com/docs/usage/requests-to-twilio",
    "homepage": "https://www.twilio.com/",
    "setupSteps": [
      "Choose a Twilio account, region, and the messaging or voice resources required.",
      "Create an API key with appropriate access and store its credentials server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["SMS messaging", "Voice calls", "Status webhooks"],
    "featured": false
  },
  {
    "id": "sendgrid",
    "name": "SendGrid",
    "category": "Communication",
    "description": "Setup guide for transactional email and email delivery tooling.",
    "auth": "The SendGrid Web API uses API keys as bearer credentials; key permissions limit accessible account features.",
    "docsUrl": "https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication",
    "homepage": "https://sendgrid.com/",
    "setupSteps": [
      "Choose the SendGrid account and review its sender and email-delivery setup requirements.",
      "Create a permission-limited API key in account settings and store it server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Email sending", "Email templates", "Delivery events"],
    "featured": false
  },

  // Data
  {
    "id": "airtable",
    "name": "Airtable",
    "category": "Data",
    "description": "Setup guide for structured records, bases, and collaborative data workflows.",
    "auth": "Personal access tokens support internal use; OAuth supports user-granted access. Permissions and authorized bases or workspaces limit access.",
    "docsUrl": "https://airtable.com/developers/web/api/authentication",
    "homepage": "https://airtable.com/",
    "setupSteps": [
      "Create an Airtable personal access token or register an OAuth integration.",
      "Grant only required base or workspace access and protect token material server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Records", "Base schemas", "Record changes"],
    "featured": true
  },
  {
    "id": "postgresql",
    "name": "PostgreSQL",
    "category": "Data",
    "description": "Setup guide for a PostgreSQL database deployment, not a hosted account service.",
    "auth": "Database roles and server-configured client authentication control access; credentials and methods depend on the deployment.",
    "docsUrl": "https://www.postgresql.org/docs/current/client-authentication.html",
    "homepage": "https://www.postgresql.org/",
    "setupSteps": [
      "Have the database administrator provision a least-privilege login role for the intended database.",
      "Configure approved client access and encrypted transport; protect database credentials outside client code.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["SQL queries", "Schema metadata", "Transactions"],
    "featured": true
  },
  {
    "id": "mysql",
    "name": "MySQL",
    "category": "Data",
    "description": "Setup guide for a MySQL database deployment and its structured data.",
    "auth": "MySQL verifies the account, client host, authentication-plugin credentials, and account state; database privileges govern operations.",
    "docsUrl": "https://dev.mysql.com/doc/refman/8.4/en/connection-access.html",
    "homepage": "https://www.mysql.com/",
    "setupSteps": [
      "Have the database administrator create a least-privilege account for the intended database and client host.",
      "Configure approved network access and encrypted transport; store credentials outside client code.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["SQL queries", "Table metadata", "Record updates"],
    "featured": false
  },
  {
    "id": "mongodb",
    "name": "MongoDB",
    "category": "Data",
    "description": "Setup guide focused on MongoDB Atlas database access and document data.",
    "auth": "Atlas database users are separate from Atlas accounts; password or other supported database authentication works with assigned database roles.",
    "docsUrl": "https://www.mongodb.com/docs/atlas/security-add-mongodb-users/",
    "homepage": "https://www.mongodb.com/",
    "setupSteps": [
      "Create an Atlas database user and assign only required database or collection privileges.",
      "Restrict intended cluster access and configure approved network access and protected credentials.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Document queries", "Aggregations", "Collection metadata"],
    "featured": false
  },
  {
    "id": "supabase",
    "name": "Supabase",
    "category": "Data",
    "description": "Setup guide for project data APIs, user identity, and storage services.",
    "auth": "Project API keys identify applications; user tokens and row-level security govern user access. Secret keys are backend-only and bypass row-level security.",
    "docsUrl": "https://supabase.com/docs/guides/getting-started/api-keys",
    "homepage": "https://supabase.com/",
    "setupSteps": [
      "Choose a Supabase project and the application access model for the intended data.",
      "Configure user authorization and row-level policies; keep any privileged secret key backend-only.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Table data", "User authentication", "Object storage"],
    "featured": true
  },
  {
    "id": "firebase",
    "name": "Firebase",
    "category": "Data",
    "description": "Setup guide for Firebase project services using a trusted server runtime.",
    "auth": "The Admin SDK uses Google application default credentials or service-account credentials; privileged access requires appropriate project authorization.",
    "docsUrl": "https://firebase.google.com/docs/admin/setup",
    "homepage": "https://firebase.google.com/",
    "setupSteps": [
      "Choose a Firebase project and enable only the services needed by the planned workflow.",
      "Authorize a server identity with minimum permissions; prefer managed credentials over downloaded keys.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Firestore data", "User management", "Cloud Messaging"],
    "featured": false
  },

  // Cloud
  {
    "id": "aws",
    "name": "AWS",
    "category": "Cloud",
    "description": "Setup guide for selected AWS resources; each AWS service requires its own adapter coverage.",
    "auth": "IAM roles and temporary credentials are recommended for workloads; IAM policies restrict actions and resources.",
    "docsUrl": "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html",
    "homepage": "https://aws.amazon.com/",
    "setupSteps": [
      "Choose the AWS account, regions, and specific services the planned adapter will support.",
      "Authorize a least-privilege workload role and temporary credential path; avoid long-lived keys.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Object storage", "Compute resources", "Monitoring data"],
    "featured": true
  },
  {
    "id": "azure",
    "name": "Microsoft Azure",
    "category": "Cloud",
    "description": "Setup guide for selected Azure resources using supported workload identity access.",
    "auth": "Managed identities on supported Azure hosts obtain Microsoft Entra tokens without app-managed secrets; role assignments authorize target resources.",
    "docsUrl": "https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview",
    "homepage": "https://azure.microsoft.com/",
    "setupSteps": [
      "Choose Azure resources and a supported hosting environment for the future adapter.",
      "Assign a managed identity to that host and grant minimum roles on target resources.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Storage resources", "Compute resources", "Resource metadata"],
    "featured": false
  },
  {
    "id": "google-cloud",
    "name": "Google Cloud",
    "category": "Cloud",
    "description": "Setup guide for selected Google Cloud APIs and project resources.",
    "auth": "Application default credentials discover a configured identity; workload identity or an attached service account can avoid keys, while IAM controls access.",
    "docsUrl": "https://docs.cloud.google.com/docs/authentication",
    "homepage": "https://cloud.google.com/",
    "setupSteps": [
      "Choose a Google Cloud project and enable the specific APIs needed by the planned adapter.",
      "Configure an authorized workload identity or service account with minimum IAM permissions.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Object storage", "Compute resources", "Project metadata"],
    "featured": false
  },
  {
    "id": "cloudflare",
    "name": "Cloudflare",
    "category": "Cloud",
    "description": "Setup guide for account, zone, and supported edge-platform resources.",
    "auth": "API tokens grant selected permissions on specific resources; account-owned token support depends on the API operation.",
    "docsUrl": "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
    "homepage": "https://www.cloudflare.com/",
    "setupSteps": [
      "Choose the Cloudflare account or zones and identify the intended API operations.",
      "Create a resource-restricted API token with minimum permissions and store it securely server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["DNS records", "Zone metadata", "Worker resources"],
    "featured": true
  },
  {
    "id": "vercel",
    "name": "Vercel",
    "category": "Cloud",
    "description": "Setup guide for project deployments and hosting metadata.",
    "auth": "Vercel REST API requests use access tokens; token resource restrictions and expiration determine permitted access.",
    "docsUrl": "https://vercel.com/docs/accounts/access-tokens",
    "homepage": "https://vercel.com/",
    "setupSteps": [
      "Choose the Vercel account, team, or project intended for the planned workflow.",
      "Create a minimally scoped access token with an expiration and store it server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Projects", "Deployments", "Domains"],
    "featured": true
  },
  {
    "id": "netlify",
    "name": "Netlify",
    "category": "Cloud",
    "description": "Setup guide for site hosting, deployments, and associated project resources.",
    "auth": "Personal access tokens support individual tooling; public integrations require OAuth 2.0. Team access policies still apply.",
    "docsUrl": "https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/",
    "homepage": "https://www.netlify.com/",
    "setupSteps": [
      "Choose Netlify sites and create a personal token or register an OAuth application.",
      "Arrange required account or team authorization and protect tokens and client secrets server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Sites", "Deployments", "Form submissions"],
    "featured": false
  },

  // Commerce & CRM
  {
    "id": "stripe",
    "name": "Stripe",
    "category": "Commerce & CRM",
    "description": "Setup guide for payment and billing data, starting with a Stripe sandbox.",
    "auth": "Server APIs use secret or restricted API keys; publishable keys are not server credentials. Test and live data are separate.",
    "docsUrl": "https://docs.stripe.com/keys",
    "homepage": "https://stripe.com/",
    "setupSteps": [
      "Choose a Stripe sandbox and define the intended payment or billing operations.",
      "Create a restricted test key where supported and store it in a server-side secret vault.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Payment records", "Customers", "Subscriptions"],
    "featured": true
  },
  {
    "id": "shopify",
    "name": "Shopify",
    "category": "Commerce & CRM",
    "description": "Setup guide for store administration through Shopify's GraphQL Admin API.",
    "auth": "Admin API access uses store access tokens; token acquisition depends on the app model and merchant or organization authorization.",
    "docsUrl": "https://shopify.dev/docs/apps/build/authentication-authorization",
    "homepage": "https://www.shopify.com/",
    "setupSteps": [
      "Create a Shopify app and select the documented authentication path for its distribution model.",
      "Configure minimum permissions and complete the applicable merchant or organization authorization setup.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Products", "Orders", "Inventory"],
    "featured": true
  },
  {
    "id": "hubspot",
    "name": "HubSpot",
    "category": "Commerce & CRM",
    "description": "Setup guide for customer records, sales pipelines, and CRM workflows.",
    "auth": "OAuth is required for multi-account apps; static access tokens support single-account installation under the documented app model.",
    "docsUrl": "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview",
    "homepage": "https://www.hubspot.com/",
    "setupSteps": [
      "Create a HubSpot app and choose OAuth or static authentication for its distribution model.",
      "Select required CRM permissions and arrange authorized account installation; protect tokens server-side.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Contacts", "Companies", "Deals"],
    "featured": false
  },
  {
    "id": "salesforce",
    "name": "Salesforce",
    "category": "Commerce & CRM",
    "description": "Setup guide for authorized Salesforce organization data and CRM operations.",
    "auth": "OAuth 2.0 authorizes REST API access; Salesforce recommends external client apps for new app registrations.",
    "docsUrl": "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_oauth_and_connected_apps.htm",
    "homepage": "https://www.salesforce.com/",
    "setupSteps": [
      "Create an external client app in the intended Salesforce organization and configure OAuth.",
      "Have an administrator approve minimum API access and the appropriate authorization flow.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["CRM records", "Object metadata", "Record queries"],
    "featured": false
  },

  // Design & Support
  {
    "id": "figma",
    "name": "Figma",
    "category": "Design & Support",
    "description": "Setup guide for design-file inspection and collaboration metadata.",
    "auth": "OAuth 2.0 supports user-authorized apps; personal tokens support individual tooling. Available permissions and API features vary by account and plan.",
    "docsUrl": "https://developers.figma.com/docs/rest-api/authentication/",
    "homepage": "https://www.figma.com/",
    "setupSteps": [
      "Register a Figma OAuth app or create a personal access token for individual use.",
      "Authorize only required file access and confirm relevant account and plan permissions.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["File inspection", "Image exports", "Comments"],
    "featured": true
  },
  {
    "id": "intercom",
    "name": "Intercom",
    "category": "Design & Support",
    "description": "Setup guide for customer conversations and support workspace data.",
    "auth": "Private apps can use access tokens for their own workspace; apps accessing other users' workspaces must use OAuth, not request private tokens.",
    "docsUrl": "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication",
    "homepage": "https://www.intercom.com/",
    "setupSteps": [
      "Create an Intercom developer app and choose a private-workspace or public OAuth model.",
      "Configure minimum access and workspace authorization; never ask customers for their private access tokens.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Conversations", "Contacts", "Support tickets"],
    "featured": false
  },

  // Automation
  {
    "id": "zapier",
    "name": "Zapier",
    "category": "Automation",
    "description": "Setup guide for the Zapier Workflow API, not automatic authorization of third-party apps.",
    "auth": "Most Workflow API operations use OAuth 2.0 user access tokens; some require app access tokens or a client ID as documented per operation.",
    "docsUrl": "https://docs.zapier.com/powered-by-zapier/authentication/getting-started",
    "homepage": "https://zapier.com/",
    "setupSteps": [
      "Arrange Zapier developer app access and review Workflow API eligibility and client setup.",
      "Configure the documented authorization method; external app accounts require separate user authorization.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Workflow creation", "Workflow management", "App discovery"],
    "featured": false
  },
  {
    "id": "make",
    "name": "Make",
    "category": "Automation",
    "description": "Setup guide for Make API scenario workflows and automation resources.",
    "auth": "Make API tokens authorize selected API resources; OAuth 2.0 is an alternative that requires an approved client setup.",
    "docsUrl": "https://developers.make.com/api-documentation/authentication",
    "homepage": "https://www.make.com/",
    "setupSteps": [
      "Review Make API availability for the intended organization and scenario workflow.",
      "Create a minimally permitted API token or request OAuth client access; authorize external apps separately.",
      "In ScaleMax, choose Connect: the credential is encrypted on this device, and Test checks it with the provider where a validation endpoint exists."
    ],
    "capabilities": ["Scenario metadata", "Scenario execution", "Execution history"],
    "featured": false
  }
];
