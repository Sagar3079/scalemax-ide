'use strict';

// Minimal stdio MCP server used by test/mcp.test.cjs. It speaks
// newline-delimited JSON-RPC 2.0 on stdin/stdout, like a real server.
//
// Environment switches:
//   FAKE_MCP_CRASH=1        write 'boom' (plus FAKE_MCP_LEAK when set) to stderr and exit(3)
//   FAKE_MCP_PAGINATE=1     return the two tools on two tools/list pages via nextCursor
//   FAKE_MCP_ECHO_PREFIX=x  prefix echo output (proves configured env reaches the child)
//   FAKE_MCP_HUGE_LINE=1    write a stdout line larger than 4 MiB at startup; echo of "huge"
//                           (id first) or "huge-last" (id last, like the TypeScript SDK)
//                           answers with a line larger than 4 MiB
//   FAKE_MCP_STUBBORN=1     ignore SIGTERM and the end of stdin (only SIGKILL stops it)
//   FAKE_MCP_EXTRAS=1       also offer resources (two, on two resources/list pages, plus the
//                           template memo://notes/{day}) and prompts (review), and a tool
//                           "change" that adds a tool, a resource and a prompt, announcing each
//                           with its list_changed notification before it answers
//   FAKE_MCP_NO_TEMPLATES=1 (with EXTRAS) answer resources/templates/list with -32601
//   FAKE_MCP_HANG=initialize  never answer initialize; FAKE_MCP_HANG=tools: never answer tools/list

if (process.env.FAKE_MCP_CRASH === '1') {
  const leak = process.env.FAKE_MCP_LEAK ? ` ${process.env.FAKE_MCP_LEAK}` : '';
  process.stderr.write(`boom${leak}\n`);
  process.exit(3);
}

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo the provided text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

const EXTRAS = process.env.FAKE_MCP_EXTRAS === '1';
const HANG = process.env.FAKE_MCP_HANG || '';
if (EXTRAS) {
  TOOLS.push({ name: 'change', description: 'Change what this server offers.', inputSchema: { type: 'object', properties: {} } });
}
const RESOURCES = [
  { uri: 'memo://notes/today', name: 'Today', mimeType: 'text/plain', description: 'Notes for today.' },
  { uri: 'memo://images/logo', name: 'Logo', mimeType: 'image/png' },
];
const PROMPTS = [
  {
    name: 'review',
    title: 'Review a file',
    description: 'Ask for a review.',
    arguments: [
      { name: 'file', description: 'The file to review.', required: true },
      { name: 'focus', description: 'What to look at.' },
    ],
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function listTools(id, params) {
  if (process.env.FAKE_MCP_PAGINATE !== '1') {
    result(id, { tools: TOOLS });
    return;
  }
  if (params && params.cursor === 'page-2') result(id, { tools: [TOOLS[1]] });
  else result(id, { tools: [TOOLS[0]], nextCursor: 'page-2' });
}

function listResources(id, params) {
  if (params && params.cursor === 'resources-2') result(id, { resources: RESOURCES.slice(1) });
  else result(id, { resources: RESOURCES.slice(0, 1), nextCursor: 'resources-2' });
}

function readResource(id, params) {
  const uri = String((params && params.uri) || '');
  if (uri.startsWith('memo://notes/')) {
    result(id, { contents: [{ uri, mimeType: 'text/plain', text: `notes for ${uri.slice('memo://notes/'.length)}` }] });
  } else if (uri === 'memo://images/logo') {
    result(id, { contents: [{ uri, mimeType: 'image/png', blob: Buffer.from('fake png bytes').toString('base64') }] });
  } else {
    failure(id, -32002, 'Resource not found');
  }
}

function getPrompt(id, params) {
  const args = (params && params.arguments) || {};
  if (!params || params.name !== 'review' || typeof args.file !== 'string') {
    failure(id, -32602, 'Missing required argument: file');
    return;
  }
  result(id, {
    description: 'A review request.',
    messages: [
      { role: 'user', content: { type: 'text', text: `Review ${args.file}${args.focus ? ` for ${args.focus}` : ''}.` } },
      { role: 'assistant', content: { type: 'text', text: 'Sure, send it.' } },
    ],
  });
}

function callTool(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name === 'change' && EXTRAS) {
    TOOLS.push({ name: 'late', description: 'Added later.', inputSchema: { type: 'object', properties: {} } });
    RESOURCES.push({ uri: 'memo://notes/late', name: 'Late', mimeType: 'text/plain' });
    PROMPTS.push({ name: 'late', description: 'Added later.' });
    for (const kind of ['tools', 'resources', 'prompts']) send({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` });
    result(id, { content: [{ type: 'text', text: 'changed' }] });
    return;
  }
  if (name === 'echo' && process.env.FAKE_MCP_HUGE_LINE === '1' && (args.text === 'huge' || args.text === 'huge-last')) {
    const content = [{ type: 'text', text: 'y'.repeat(5 * 1024 * 1024) }];
    if (args.text === 'huge') result(id, { content });
    else process.stdout.write(`${JSON.stringify({ result: { content }, jsonrpc: '2.0', id })}\n`);
    return;
  }
  if (name === 'echo') {
    const prefix = process.env.FAKE_MCP_ECHO_PREFIX || '';
    result(id, { content: [{ type: 'text', text: `${prefix}${String(args.text ?? '')}` }] });
    return;
  }
  if (name === 'add') {
    const sum = Number(args.a) + Number(args.b);
    result(id, {
      content: [{ type: 'text', text: String(sum) }],
      structuredContent: { sum },
    });
    return;
  }
  result(id, { content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }], isError: true });
}

function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      if (HANG === 'initialize') return;
      result(id, {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        capabilities: EXTRAS
          ? { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }
          : { tools: {} },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      if (isRequest) result(id, {});
      return;
    case 'tools/list':
      if (HANG === 'tools') return;
      listTools(id, params);
      return;
    case 'resources/list':
      if (EXTRAS) listResources(id, params);
      else failure(id, -32601, 'Method not found');
      return;
    case 'resources/templates/list':
      if (EXTRAS && process.env.FAKE_MCP_NO_TEMPLATES !== '1') {
        result(id, { resourceTemplates: [{ uriTemplate: 'memo://notes/{day}', name: 'Notes of a day', mimeType: 'text/plain' }] });
      } else {
        failure(id, -32601, 'Method not found');
      }
      return;
    case 'resources/read':
      if (EXTRAS) readResource(id, params);
      else failure(id, -32601, 'Method not found');
      return;
    case 'prompts/list':
      if (EXTRAS) result(id, { prompts: PROMPTS });
      else failure(id, -32601, 'Method not found');
      return;
    case 'prompts/get':
      if (EXTRAS) getPrompt(id, params);
      else failure(id, -32601, 'Method not found');
      return;
    case 'tools/call':
      callTool(id, params);
      return;
    default:
      if (isRequest) failure(id, -32601, 'Method not found');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message;
      try { message = JSON.parse(line); } catch { message = null; }
      handle(message);
    }
    index = buffer.indexOf('\n');
  }
});
if (process.env.FAKE_MCP_STUBBORN === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on('end', () => process.exit(0));
}

// Startup noise that a client must tolerate: a non-JSON stdout line and a
// diagnostic stderr line.
process.stdout.write('fake-mcp starting up (this line is not JSON)\n');
process.stderr.write('fake-mcp: log line on stderr\n');
if (process.env.FAKE_MCP_HUGE_LINE === '1') {
  process.stdout.write(`${'x'.repeat(5 * 1024 * 1024)}\n`);
}
