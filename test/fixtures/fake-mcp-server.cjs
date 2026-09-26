'use strict';

// Minimal stdio MCP server used by test/mcp.test.cjs. It speaks
// newline-delimited JSON-RPC 2.0 on stdin/stdout, like a real server.
//
// Environment switches:
//   FAKE_MCP_CRASH=1        write 'boom' (plus FAKE_MCP_LEAK when set) to stderr and exit(3)
//   FAKE_MCP_PAGINATE=1     return the two tools on two tools/list pages via nextCursor
//   FAKE_MCP_ECHO_PREFIX=x  prefix echo output (proves configured env reaches the child)
//   FAKE_MCP_HUGE_LINE=1    write an unterminated stdout line larger than 4 MiB

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

function callTool(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
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
      result(id, {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      if (isRequest) result(id, {});
      return;
    case 'tools/list':
      listTools(id, params);
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
process.stdin.on('end', () => process.exit(0));

// Startup noise that a client must tolerate: a non-JSON stdout line and a
// diagnostic stderr line.
process.stdout.write('fake-mcp starting up (this line is not JSON)\n');
process.stderr.write('fake-mcp: log line on stderr\n');
if (process.env.FAKE_MCP_HUGE_LINE === '1') {
  process.stdout.write('x'.repeat(5 * 1024 * 1024));
}
