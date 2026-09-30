// Well-known MCP servers the MCP card can add in one step. Every entry was connected through
// ScaleMax's own MCP client on 2026-09-27 (initialize + tools/list; tool counts at that time).
//
//   signin  sign in with your account in the browser (no app registration or keys)
//   public  public servers: just a URL
//   local   runs on this Mac through npx (Node.js) or uvx (uv); `folder` ones use the open workspace
//
// The one-click sign-ins reuse the connector directory (src/mcp-directory.js); GitHub goes
// through the GitHub CLI like its connector card.
import { MCP_LISTING_NAMES, MCP_SIGN_IN } from './mcp-directory.js';

const SIGN_IN_DESCRIPTIONS = {
  notion: 'Search and edit pages and databases.',
  linear: 'Issues, projects and cycles.',
  sentry: 'Errors, issues and releases.',
  atlassian: 'Jira issues and Confluence pages.',
  stripe: 'Customers, payments and billing data.',
  vercel: 'Projects, deployments and logs.',
  cloudflare: 'Workers bindings: KV, R2, D1 and more.',
  intercom: 'Conversations and contacts.',
  supabase: 'Projects, databases and SQL.',
  netlify: 'Sites, deploys and settings.',
  airtable: 'Bases, tables and records.',
  dropbox: 'Files and folders.',
  zapier: 'Actions you set up in Zapier.',
};

function connectorFor(listing) {
  return Object.entries(MCP_SIGN_IN).find(([, id]) => id === listing)?.[0] || listing;
}

export const MCP_PRESETS = Object.freeze([
  { id: 'github', name: 'GitHub', group: 'signin', via: 'cli', description: 'Repositories, issues and pull requests (logs in through the GitHub CLI).' },
  ...Object.entries(MCP_LISTING_NAMES).map(([listing, name]) => ({
    id: listing, name, group: 'signin', via: 'directory', connectorId: connectorFor(listing), description: SIGN_IN_DESCRIPTIONS[listing] || '',
  })),
  { id: 'semgrep', name: 'Semgrep', group: 'signin', via: 'url', url: 'https://mcp.semgrep.ai/mcp', description: 'Scan code for security issues.' },

  { id: 'deepwiki', name: 'DeepWiki', group: 'public', url: 'https://mcp.deepwiki.com/mcp', description: 'Ask questions about any public GitHub repository.' },
  { id: 'context7', name: 'Context7', group: 'public', url: 'https://mcp.context7.com/mcp', description: 'Up-to-date library documentation and code examples.' },
  { id: 'microsoft-learn', name: 'Microsoft Learn', group: 'public', url: 'https://learn.microsoft.com/api/mcp', description: 'Microsoft and Azure documentation.' },
  { id: 'aws-knowledge', name: 'AWS Knowledge', group: 'public', url: 'https://knowledge-mcp.global.api.aws', description: 'AWS documentation and regional availability.' },
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', group: 'public', url: 'https://docs.mcp.cloudflare.com/mcp', description: 'Search the Cloudflare documentation.' },
  { id: 'huggingface', name: 'Hugging Face', group: 'public', url: 'https://huggingface.co/mcp', description: 'Search models, datasets and Spaces.' },
  { id: 'gitmcp', name: 'GitMCP', group: 'public', url: 'https://gitmcp.io/docs', description: 'Documentation and code of any GitHub project.' },

  // Local servers run as the user, outside the sandbox, so each is pinned to one exact release
  // (checked 2026-09-30 on npm and PyPI): a new release, compromised or not, never runs on its
  // own. Update a version here deliberately.
  { id: 'filesystem', name: 'Filesystem', group: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', '{folder}'], folder: true, description: 'Read and write files in the open workspace folder.' },
  { id: 'git', name: 'Git', group: 'local', command: 'uvx', args: ['mcp-server-git@2026.8.18', '--repository', '{folder}'], folder: true, description: 'Status, diffs, log and commits of the open workspace.' },
  { id: 'playwright', name: 'Playwright browser', group: 'local', command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--headless'], description: 'Open web pages, click, type and take snapshots.' },
  { id: 'fetch', name: 'Fetch', group: 'local', command: 'uvx', args: ['mcp-server-fetch@2026.8.18'], description: 'Fetch a web page as Markdown.' },
  { id: 'memory', name: 'Memory', group: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.8.31'], description: 'A knowledge graph the model can remember things in.' },
  { id: 'sequential-thinking', name: 'Sequential thinking', group: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.8.31'], description: 'Step-by-step problem solving.' },
  { id: 'time', name: 'Time', group: 'local', command: 'uvx', args: ['mcp-server-time@2026.8.18'], description: 'Current time and time-zone conversion.' },
].map((preset) => Object.freeze(preset)));

export const PRESET_GROUPS = Object.freeze([
  ['signin', 'Sign in with your account', 'Opens the service in your browser. No app registration or API key needed.'],
  ['public', 'Public: just a URL', 'Free public servers; nothing to sign in to.'],
  ['local', 'Runs on this Mac', 'Started with npx (Node.js) or uvx (uv). ScaleMax asks before running a command.'],
]);

/** The command and args of a local preset, with {folder} filled in. */
export function presetCommand(preset, folder) {
  return { command: preset.command, args: preset.args.map((arg) => (arg === '{folder}' ? folder : arg)) };
}

/** The saved server that came from this preset, or null. */
export function presetServer(preset, servers) {
  return servers.find((server) => {
    if (preset.via === 'directory') return server.auth?.directoryId === preset.id;
    if (preset.via === 'cli') return server.connector === 'github';
    if (preset.url) return server.transport === 'http' && server.url?.replace(/\/+$/, '') === preset.url.replace(/\/+$/, '');
    if (preset.command) {
      // By package, whatever version: a server added before the presets were pinned still counts.
      const pkg = packageName(preset.args.find((arg) => !arg.startsWith('-') && arg !== '{folder}'));
      return server.transport === 'stdio' && server.command === preset.command
        && (server.args || []).some((arg) => packageName(arg) === pkg);
    }
    return false;
  }) || null;
}

/** "@scope/name@1.2.3" → "@scope/name", "name@1.2.3" → "name". */
function packageName(arg) {
  if (typeof arg !== 'string') return '';
  const at = arg.lastIndexOf('@');
  return at > 0 ? arg.slice(0, at) : arg;
}
