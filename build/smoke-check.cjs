'use strict';

// Development-only boot check driven by SCALEMAX_SMOKE=1 (see main.js).
// Verifies the renderer ES-module graph links and the provider IPC bridge works.
// Excluded from packaged builds (electron-builder `files` omits test/).

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_MCP_SERVER = path.join(__dirname, '..', 'test', 'fixtures', 'fake-mcp-server.cjs');
// The smoke run's app data (main.js): the sandbox keeps the model's commands out of it.
const SMOKE_DATA = path.join(os.tmpdir(), `scalemax-smoke-${process.pid}`);

// Minimal OpenAI-compatible stub on loopback, reachable from the provider.
// With tools offered and a "use echo" request it answers with a tool call,
// then turns the tool result into the final reply (exercises the tool loop).
const SLOW_TEXT = 'This is a slow streamed reply that arrives in many small pieces.';
function stubReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1] || {};
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const echo = tools.find((tool) => /_echo$/.test(tool?.function?.name || ''));
  const list = tools.find((tool) => tool?.function?.name === 'workspace_list');
  const run = tools.find((tool) => tool?.function?.name === 'workspace_run');
  const write = tools.find((tool) => tool?.function?.name === 'workspace_write');
  const edit = tools.find((tool) => tool?.function?.name === 'workspace_edit');
  // `provider:compact` is a separate no-tools call whose fixed system message never reaches the
  // normal chat/tool loop. Its short response is persisted as app-owned context, not a chat turn.
  if (messages.some((message) => message.role === 'system' && String(message.content).includes('conversation compactor'))) {
    return { role: 'assistant', content: 'Stub summary: earlier work is complete; retain the current request and constraints.' };
  }
  if (typeof last.content === 'string' && last.content.includes('check compact context')) {
    const summary = messages.some((message) => String(message.content).startsWith('[ScaleMax conversation summary'));
    const oldest = messages.some((message) => String(message.content).includes('old-0'));
    return { role: 'assistant', content: `compact context: ${summary}:${oldest}` };
  }
  // Creates one file and edits another in one round (the reply's changes, for review and undo).
  if (write && edit && typeof last.content === 'string' && last.content.includes('make changes')) {
    return {
      role: 'assistant',
      content: 'Changing two files.',
      tool_calls: [
        { id: 'call_smoke_write', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'made/new.md', content: 'fresh file\n' }) } },
        { id: 'call_smoke_edit', type: 'function', function: { name: 'workspace_edit', arguments: JSON.stringify({ path: 'b-note.txt', old_text: 'line two', new_text: 'line 2' }) } },
      ],
    };
  }
  if (typeof last.content === 'string' && last.content.includes('name your tools')) {
    return { role: 'assistant', content: `tools: ${tools.map((tool) => tool.function.name).join(',')}` };
  }
  // Feature specs: the three documents in one round, then one task ticked off, then the answer.
  const said = (text) => messages.some((message) => typeof message?.content === 'string' && message.content.includes(text));
  const specWrite = tools.find((tool) => tool?.function?.name === 'spec_write');
  const specTask = tools.find((tool) => tool?.function?.name === 'spec_task');
  if (specWrite && specTask && said('write the offline sync spec')) {
    const call = (id, args) => ({ id, type: 'function', function: { name: 'spec_write', arguments: JSON.stringify({ spec: 'Offline Sync', ...args }) } });
    if (!messages.some((message) => message.role === 'tool')) {
      return {
        role: 'assistant',
        content: 'Writing the spec down first.',
        tool_calls: [
          call('call_spec_req', { doc: 'requirements', content: '# Requirements\n\n1. As a user, I can work offline.\n' }),
          call('call_spec_design', { doc: 'design', content: '# Design\n\nA queue in lib/sync.cjs.\n' }),
          call('call_spec_tasks', { doc: 'tasks', content: '# Tasks\n\n- [ ] Add the queue\n- [ ] Flush it on reconnect\n  - [ ] Retry once\n' }),
        ],
      };
    }
    if (!messages.some((message) => message.role === 'tool' && String(message.content).includes('is now done'))) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_spec_tick', type: 'function', function: { name: 'spec_task', arguments: JSON.stringify({ spec: 'offline-sync', task: 1, done: true }) } }],
      };
    }
    return { role: 'assistant', content: 'The spec is written and the first task is done.' };
  }
  // Plan permission: the model tries to write and is refused, so it answers with the plan. The
  // same write, asked for again after "Run this plan", goes through.
  if (write && (said('plan a change') || said('Run the plan you just proposed'))) {
    if (last.role === 'tool') {
      return String(last.content).includes('Plan permission')
        ? { role: 'assistant', content: 'Plan: create planned.md with one line, then run the tests.' }
        : { role: 'assistant', content: 'Done: planned.md is written.' };
    }
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_plan_write', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'planned.md', content: 'planned line\n' }) } }],
    };
  }
  // First completion gets its usage; the next completion fails, exercising partial billing.
  if (last.role === 'tool' && messages.some((message) => typeof message?.content === 'string' && message.content.includes('fail after tool'))) {
    return { role: 'assistant', content: 'Partial after a billed tool round.', failAfter: 'stub second round failed' };
  }
  if (list && typeof last.content === 'string' && last.content.includes('fail after tool')) {
    return { role: 'assistant', content: null, tool_calls: [{ id: 'call_smoke_fail_usage', type: 'function', function: { name: 'workspace_list', arguments: '{}' } }] };
  }
  if (last.role === 'tool') return { role: 'assistant', content: `tool said: ${last.content}` };
  // A command that prints, waits and prints again: its output shows while it runs.
  if (run && typeof last.content === 'string' && last.content.includes('use workspace run')) {
    return {
      role: 'assistant',
      content: 'Running it now.',
      tool_calls: [{ id: 'call_smoke_run', type: 'function', function: { name: 'workspace_run', arguments: JSON.stringify({ command: 'printf smoke-run-a; sleep 1.2; printf smoke-run-b' }) } }],
    };
  }
  // Background commands and the sandbox: a command that keeps running and answers what is typed
  // into it; one that tries to read ScaleMax's own data (the sandbox refuses); the same outside
  // the sandbox (the user is always asked).
  if (run && typeof last.content === 'string' && last.content.includes('start a job')) {
    return {
      role: 'assistant',
      content: 'Starting it in the background.',
      tool_calls: [{ id: 'call_smoke_job', type: 'function', function: { name: 'workspace_run', arguments: JSON.stringify({ command: 'echo job-ready; while read line; do echo "job got $line"; done', background: true, wait_seconds: 2 }) } }],
    };
  }
  if (run && typeof last.content === 'string' && (last.content.includes('read app data') || last.content.includes('leave the sandbox'))) {
    const outside = last.content.includes('leave the sandbox');
    const command = `ls ${JSON.stringify(SMOKE_DATA)}${outside ? ' > /dev/null && echo outside-ok' : ''}`;
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: outside ? 'call_smoke_outside' : 'call_smoke_refused', type: 'function', function: { name: 'workspace_run', arguments: JSON.stringify(outside ? { command, sandbox: false } : { command }) } }],
    };
  }
  // Built-in workspace tools: list the open folder, or say which folder the instructions name.
  if (list && typeof last.content === 'string' && last.content.includes('use workspace list')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_smoke_ws', type: 'function', function: { name: 'workspace_list', arguments: '{}' } }],
    };
  }
  if (typeof last.content === 'string' && last.content.includes('which folder')) {
    const system = messages.find((message) => message.role === 'system');
    const folder = /project folder "([^"]+)"/.exec(system?.content || '');
    return { role: 'assistant', content: `folder: ${folder ? folder[1] : 'none'}` };
  }
  if (typeof last.content === 'string' && (last.content.includes('slow stream') || last.content.includes('hold stream'))) {
    return { role: 'assistant', content: SLOW_TEXT };
  }
  // Streams its text, then fails like an overloaded upstream (streamed requests only).
  if (typeof last.content === 'string' && last.content.includes('fail midway')) {
    return { role: 'assistant', content: 'Partial answer before the failure.', failAfter: 'stub overloaded' };
  }
  // The conversation as the model got it: roles, with notes from ScaleMax marked.
  if (typeof last.content === 'string' && last.content.includes('show history')) {
    const turns = messages.filter((message) => message.role !== 'system')
      .map((message) => message.role + (String(message.content).startsWith('[Note from ScaleMax') ? '(note)' : ''));
    return { role: 'assistant', content: `history: ${turns.join(',')}` };
  }
  if (echo && typeof last.content === 'string' && last.content.includes('use echo')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_smoke_1', type: 'function', function: { name: echo.function.name, arguments: JSON.stringify({ text: 'smoke-echo' }) } }],
    };
  }
  return { role: 'assistant', content: 'pong' };
}

// A held stream waits for the next request containing "release" after its own request arrived
// (a release that came first still counts), or 15 s.
const heldStreams = new Set();
let releases = 0;
function releaseHeld() {
  releases += 1;
  for (const resume of [...heldStreams]) resume();
  heldStreams.clear();
}
// The reply as Server-Sent Events, the way the ScaleMax API streams: the text in small pieces,
// each tool call's name first and its arguments after, then the finish reason and the usage.
function streamReply(res, message, delayMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', model: 'smoke-model' };
  const events = [];
  const text = typeof message.content === 'string' ? message.content : '';
  for (const piece of text.match(/[\s\S]{1,6}/g) || []) events.push({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
  (message.tool_calls || []).forEach((call, index) => {
    events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] } }] });
    events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.function.arguments } }] } }] });
  });
  if (message.failAfter) {
    events.push({ error: { message: message.failAfter, type: 'server_error' } });
  } else {
    events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
    events.push({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
  }
  let index = 0;
  let waiting = Boolean(message.hold);
  const heldAt = releases;
  const next = () => {
    if (res.destroyed) return;
    if (waiting && index === 2 && releases > heldAt) waiting = false;
    if (waiting && index === 2) {
      waiting = false;
      let resumed = false;
      const resume = () => {
        if (resumed) return;
        resumed = true;
        heldStreams.delete(resume);
        next();
      };
      heldStreams.add(resume);
      setTimeout(resume, 15000).unref();
      return;
    }
    if (index < events.length) {
      res.write(`data: ${JSON.stringify(events[index])}\n\n`);
      index += 1;
      setTimeout(next, delayMs);
      return;
    }
    res.end('data: [DONE]\n\n');
  };
  next();
}
async function startStubServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'smoke-model', context_window: 100000, max_output_tokens: 512,
        pricing: { input_per_million: 1, output_per_million: 2, currency: 'USD' },
        capabilities: { chat: true, tools: true },
      }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const lastContent = String(body?.messages?.[body.messages.length - 1]?.content || '');
        // "hold stream" in the newest message: two pieces, then the stream waits until a request
        // saying "release" is answered, so two replies overlap however fast or slow the machine is.
        const message = { ...stubReply(body), ...(lastContent.includes('hold stream') ? { hold: true } : {}) };
        if (body?.stream === true) {
          // A "slow stream" or "hold stream" request (anywhere in the conversation) takes a
          // moment per piece, so two replies overlap and the window can be looked at meanwhile.
          const slow = (body.messages || []).some((item) => typeof item?.content === 'string'
            && (item.content.includes('slow stream') || item.content.includes('hold stream')));
          streamReply(res, message, slow ? 110 : 0);
          if (lastContent.includes('release')) releaseHeld();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const { failAfter, hold, ...whole } = message;
        res.end(JSON.stringify({ model: 'smoke-model', choices: [{ message: whole }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

// Chromium can write a few files into the throwaway profile while the app shuts
// down, after the run removed it. Each run clears profiles left by earlier,
// no-longer-running smoke processes.
function removeStaleProfiles() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const name of names) {
    const match = /^scalemax-smoke-(\d+)$/.exec(name);
    if (!match || Number(match[1]) === process.pid) continue;
    try {
      process.kill(Number(match[1]), 0);
      continue; // that smoke run is still alive
    } catch { /* not running: its profile is stale */ }
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function run(win) {
  removeStaleProfiles();
  // A window behind others counts as hidden: Chromium would slow its timers to one per second
  // and pause animation frames, and the timed checks below would race the streams.
  win.webContents.setBackgroundThrottling(false);
  const errors = [];
  const logs = [];
  const { server, port } = await startStubServer();

  win.webContents.on('console-message', (...args) => {
    const event = args[0];
    const fromEvent = event && typeof event === 'object' && 'message' in event;
    const message = fromEvent ? event.message : args[2];
    const level = fromEvent ? event.level : args[1];
    logs.push({ level, message });
    if (level === 'error' || level === 3) errors.push(message);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    errors.push(`preload-error ${preloadPath}: ${error.message}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    errors.push(`did-fail-load ${code} ${description} ${url}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`render-process-gone ${JSON.stringify(details)}`);
  });

  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  // Wait for the renderer to finish init rather than guessing a fixed delay.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ready = await win.webContents
      .executeJavaScript(`document.body.dataset.appReady === 'true'`)
      .catch(() => false);
    if (ready) break;
    await wait(100);
  }
  await wait(200);

  let probe = null;
  try {
    probe = await win.webContents.executeJavaScript(`(async () => {
      const api = window.scalemaxAPI || {};
      const providerResult = await (api.provider && api.provider.get ? api.provider.get() : Promise.resolve(null));
      const cancelResult = await (api.provider && api.provider.cancel ? api.provider.cancel('smoke') : Promise.resolve(null));
      const reservedKeys = ['provider', 'providerProfiles', 'connectors', 'connectorOAuthClients', 'mcpServers', 'workspaceFolders', 'user'];
      const reserved = {};
      for (const key of reservedKeys) reserved[key] = 'bridge-missing';
      if (api.store && api.store.get) {
        for (const key of reservedKeys) {
          reserved[key] = await api.store.get(key);
        }
      }
      const input = document.querySelector('#chat-input');
      if (input) { input.value = 'hello'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      return {
        hasBridge: Boolean(api.store && api.provider && api.connectors && api.mcp),
        reservedHidden: Object.values(reserved).every((value) => value === undefined),
        providerMethods: ['get','save','test','discover','send','cancel','compact','clear','setModel','refreshModels','onProgress','profiles','addProfile','selectProfile','renameProfile','removeProfile'].filter((m) => typeof api.provider?.[m] === 'function'),
        workspaceMethods: ['select','current','list','read','write','gitStatus','gitDiff','run','cancel'].filter((m) => typeof api.workspace?.[m] === 'function'),
        dialogMethods: ['openFolder','openFile'].filter((m) => typeof api.dialog?.[m] === 'function'),
        connectorMethods: ['list','save','remove','test','fetch','saveOAuthConfig','getOAuthConfig','startOAuth','oauthStatus','disconnectOAuth','cliAvailable','cliConnect','cliWait','cliStatus','cliCancel'].filter((m) => typeof api.connectors?.[m] === 'function'),
        mediaMethods: ['generate','cancel','info','pickImage','save','onProgress'].filter((m) => typeof api.media?.[m] === 'function'),
        approvalMethods: ['onRequest','onClosed','respond'].filter((m) => typeof api.approvals?.[m] === 'function'),
        checkpointMethods: ['get','diff','undo','keep','remove'].filter((m) => typeof api.checkpoints?.[m] === 'function'),
        jobMethods: ['info','list','output','input','stop','onChanged'].filter((m) => typeof api.jobs?.[m] === 'function'),
        commandSettings: ['#sandbox-toggle', '#sandbox-network-toggle', '#jobs-bar[hidden]', '#jobs-dialog'].every((selector) => Boolean(document.querySelector(selector))),
        specMethods: ['list','read','setTask'].filter((m) => typeof api.specs?.[m] === 'function'),
        // The specs chip stays hidden until a folder is open; Plan is the first permission offered.
        specsControls: ['#specs-dialog', '#specs-open[hidden]', '#specs-list', '#specs-tabs', '#specs-doc', '#specs-new', '#specs-work',
          '#permission-menu [data-permission="plan"]'].every((selector) => Boolean(document.querySelector(selector))),
        conversationSettings: document.querySelector('#auto-compact-toggle')?.getAttribute('aria-checked') === 'true',
        composerControls: ['#attach-btn svg', '#compact-btn', '#permission-button', '#model-button', '#model-menu[popover]', '#permission-menu[popover]', '#bypass-dialog', '#tool-approval-dialog']
          .every((selector) => Boolean(document.querySelector(selector))),
        attachIsIcon: (document.querySelector('#attach-btn')?.textContent || '').trim() === '' && document.querySelector('#attach-btn')?.getAttribute('aria-label') === 'Attach file',
        permissionLabel: document.querySelector('#permission-label')?.textContent || '',
        mcpMethods: ['list','save','remove','test','tools','signIn','cancelSignIn'].filter((m) => typeof api.mcp?.[m] === 'function'),
        providerGetOk: providerResult && providerResult.ok === true,
        providerConfigured: providerResult && providerResult.data && providerResult.data.configured === false,
        cancelOk: cancelResult && cancelResult.ok === true,
        taskCount: document.querySelector('#task-count')?.textContent,
        version: document.querySelector('#about-version')?.textContent,
        appStatus: document.querySelector('#app-status')?.textContent,
        providerStatus: document.querySelector('#provider-status')?.textContent,
        chatInputDisabled: Boolean(document.querySelector('#chat-input')?.disabled),
        sendDisabledAfterTyping: Boolean(document.querySelector('#send-btn')?.disabled),
        folderPickerShown: Boolean(document.querySelector('#folder-picker') && !document.querySelector('#folder-picker').hidden),
        viewCount: document.querySelectorAll('.view').length,
        communityCards: document.querySelectorAll('#community-list .expert-card').length,
        catalogCategories: document.querySelectorAll('#catalog-category option').length,
        schedulerStatus: document.querySelector('#scheduler-status')?.textContent || '',
        theme: document.documentElement.dataset.theme || '',
      };
    })()`);
  } catch (error) {
    errors.push(`executeJavaScript failed: ${error.message}`);
  }

  let e2e = null;
  const wsToolsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-ws-tools-'));
  fs.writeFileSync(path.join(wsToolsDir, 'smoke-note.txt'), 'note');
  // Two more folders for replies that run at the same time.
  const parDirA = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-par-a-'));
  const parDirB = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-par-b-'));
  fs.writeFileSync(path.join(parDirB, 'b-note.txt'), 'line one\nline two\n');
  // A folder for background commands and the sandbox.
  const jobsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-jobs-'));
  // A folder for feature specs, and an untouched one for Plan permission.
  const specsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-specs-'));
  const planDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-plan-'));
  try {
    e2e = await win.webContents.executeJavaScript(`(async () => {
      const api = window.scalemaxAPI;
      const setValue = (selector, value) => {
        const node = document.querySelector(selector);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const { default: app } = await import('./app.js');
      const kindSelect = document.querySelector('#provider-kind');
      kindSelect.value = 'custom';
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setValue('#provider-base-url', 'http://127.0.0.1:${port}/v1');
      setValue('#provider-model', 'smoke-model');
      document.querySelector('#provider-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterSave = await api.provider.get();
      // The settings form verifies connectivity but a custom provider catalog is loaded explicitly;
      // cost/context metadata is persisted with this model snapshot for Phase 4.
      const smokeCatalog = await api.provider.discover({ kind: 'custom', baseUrl: 'http://127.0.0.1:${port}/v1' });
      const catalogSaved = smokeCatalog && smokeCatalog.ok
        ? await api.provider.save({ kind: 'custom', baseUrl: 'http://127.0.0.1:${port}/v1', model: 'smoke-model', models: smokeCatalog.data.models }) : smokeCatalog;
      await app.loadProvider();
      const testResult = await api.provider.test();
      const sendResult = await api.provider.send({ requestId: 'smoke-e2e', messages: [{ role: 'user', content: 'ping' }] });
      // Built-in workspace tools: none without a folder, and the instructions say so.
      const noFolder = await api.provider.send({ requestId: 'smoke-ws-none', messages: [{ role: 'user', content: 'which folder am I in?' }] });
      // A chat cannot start without a folder: Send stays off until one is open.
      const input = document.querySelector('#chat-input');
      input.value = 'ping';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const uiSendBlockedNoFolder = Boolean(document.querySelector('#send-btn')?.disabled);
      await app.openWorkspaceAt(${JSON.stringify(wsToolsDir)});
      const wsToolsSelected = await api.workspace.current();
      input.value = 'ping';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#send-btn').click();
      // Wait for the reply bubble (up to 15 s: the first message in a folder writes its notes and
      // reads Git, and the first git start of a run can take seconds) instead of a fixed delay.
      const answered = () => [...document.querySelectorAll('#chat-messages .chat-bubble.assistant .msg-text')].some((node) => node.textContent === 'pong');
      for (let i = 0; i < 150 && !answered(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const replies = [...document.querySelectorAll('#chat-messages .chat-bubble.assistant .msg-text')].map((node) => node.textContent);
      // The first message binds the task to the folder: notes created, chip locked, task listed under the folder.
      const uiNotice = [...document.querySelectorAll('#chat-messages .msg-notice')].map((node) => node.textContent).join(' ');
      const uiTask = app.tasks.find((task) => task.id === app.currentTaskId);
      const uiTaskFolder = uiTask && uiTask.folder ? uiTask.folder.path : null;
      const uiChipLocked = Boolean(document.querySelector('#folder-chip')?.classList.contains('is-locked'));
      const uiGroupHasTask = [...document.querySelectorAll('#tasks-list .task-group')].some((group) => group.dataset.folderPath === ${JSON.stringify(wsToolsDir)}
        && Boolean(group.querySelector('.task-item[data-task-id="' + (uiTask ? uiTask.id : '') + '"]')));

      // MCP: a real stdio server (the test fixture run by this Electron binary as Node).
      const mcpSaved = await api.mcp.save({
        name: 'Smoke tools', transport: 'stdio', command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(FAKE_MCP_SERVER)}], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true,
      });
      const mcpTested = mcpSaved.ok ? await api.mcp.test({ id: mcpSaved.data.id }) : mcpSaved;
      const mcpListed = await api.mcp.list();
      const toolChat = await api.provider.send({ requestId: 'smoke-tools', messages: [{ role: 'user', content: 'Please use echo.' }] });
      // Manual mode: the tool call waits for the approval prompt in this window; Allow runs it.
      const settingsBefore = await api.store.get('settings');
      await api.store.set('settings', { ...(settingsBefore || {}), permission: 'manual' });
      const approvalPending = api.provider.send({ requestId: 'smoke-approve', messages: [{ role: 'user', content: 'Please use echo.' }] });
      let approvalShown = false;
      for (let i = 0; i < 100 && !approvalShown; i += 1) {
        approvalShown = Boolean(document.querySelector('#tool-approval-dialog')?.open);
        if (!approvalShown) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const approvalTitle = document.querySelector('#approval-title')?.textContent || '';
      document.querySelector('#approval-once')?.click();
      const approved = await approvalPending;
      // Deny: the tool never runs and the model is told.
      const denyPending = api.provider.send({ requestId: 'smoke-deny', messages: [{ role: 'user', content: 'Please use echo.' }] });
      for (let i = 0; i < 100 && !document.querySelector('#tool-approval-dialog')?.open; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      document.querySelector('#approval-deny')?.click();
      const denied = await denyPending;
      await api.store.set('settings', settingsBefore || {});
      if (mcpSaved.ok) await api.mcp.remove({ id: mcpSaved.data.id });
      // Built-in workspace tools: none without a folder; with one, the model is told its name and
      // can list it (read-only, so Basic runs it without asking).
      const folderReply = await api.provider.send({ requestId: 'smoke-ws-folder', messages: [{ role: 'user', content: 'which folder am I in?' }] });
      const wsToolChat = await api.provider.send({ requestId: 'smoke-ws-list', messages: [{ role: 'user', content: 'Please use workspace list.' }] });
      // A later model round fails after a billed tool-producing completion. Main must return the
      // partial metrics rather than silently losing that provider charge.
      const failedUsage = await api.provider.send({ requestId: 'smoke-failed-usage', folder: ${JSON.stringify(wsToolsDir)}, messages: [{ role: 'user', content: 'Please fail after tool.' }] });
      // A task's messages only run in its own folder.
      // Working and Coding offer different tools (lib/modes.cjs); an unknown mode falls back to Working.
      const modeTools = {};
      for (const mode of ['working', 'coding', 'nonsense']) {
        const reply = await api.provider.send({ requestId: 'smoke-mode-' + mode, mode, messages: [{ role: 'user', content: 'Please name your tools.' }] });
        modeTools[mode] = reply && reply.ok ? reply.data.text : (reply && reply.error ? reply.error.message : null);
      }
      const mismatch = await api.provider.send({ requestId: 'smoke-ws-mismatch', folder: '/private/tmp/scalemax-folder-not-open', messages: [{ role: 'user', content: 'ping' }] });
      const matched = await api.provider.send({ requestId: 'smoke-ws-match', folder: ${JSON.stringify(wsToolsDir)}, messages: [{ role: 'user', content: 'ping' }] });
      // The remembered folder, before the checks below open other folders.
      const wsCurrent = await api.workspace.current();
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (test, ms) => {
        for (let waited = 0; waited < ms && !test(); waited += 50) await sleep(50);
        return Boolean(test());
      };
      // Streaming: the reply reaches the window in pieces while it is written.
      const streamEvents = [];
      const offStream = api.provider.onProgress((event) => { if (event && event.requestId === 'smoke-stream') streamEvents.push(event); });
      const streamed = await api.provider.send({ requestId: 'smoke-stream', folder: ${JSON.stringify(wsToolsDir)}, messages: [{ role: 'user', content: 'slow stream please' }] });
      offStream();
      const streamText = streamEvents.filter((event) => event.phase === 'delta' && event.kind === 'text').map((event) => event.text).join('');
      const streamPieces = streamEvents.filter((event) => event.phase === 'delta').length;
      // Two replies at once, each in its own folder (both opened in the window first).
      await app.openWorkspaceAt(${JSON.stringify(parDirA)});
      await app.openWorkspaceAt(${JSON.stringify(parDirB)});
      const finished = {};
      const parA = api.provider.send({ requestId: 'smoke-par-a', folder: ${JSON.stringify(parDirA)}, messages: [{ role: 'user', content: 'slow stream please: which folder am I in?' }] })
        .then((value) => { finished.a = Date.now(); return value; });
      const parB = api.provider.send({ requestId: 'smoke-par-b', folder: ${JSON.stringify(parDirB)}, messages: [{ role: 'user', content: 'which folder am I in?' }] })
        .then((value) => { finished.b = Date.now(); return value; });
      const parResults = await Promise.all([parA, parB]);
      const parTexts = parResults.map((reply) => (reply && reply.ok ? reply.data.text : (reply && reply.error ? reply.error.code : null)));
      const parOrder = finished.b < finished.a;
      // The same in the window: a slow reply in one task keeps going while another task, in
      // another folder, is asked and answers.
      const send = async (text) => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send-btn').click();
      };
      const lastText = (taskId) => {
        const task = app.tasks.find((item) => item.id === taskId);
        const last = task && task.messages[task.messages.length - 1];
        return last && last.role === 'assistant' ? last.text : '';
      };
      await app.openWorkspaceAt(${JSON.stringify(parDirA)});
      const uiTaskA = app.currentTaskId;
      await send('hold stream please');
      const uiLiveText = await until(() => {
        const node = document.querySelector('#chat-messages .live-reply .live-text');
        return node && node.textContent.length > 0 && node.textContent.length < ${JSON.stringify(SLOW_TEXT.length)};
      }, 3000);
      const uiSpinner = Boolean(document.querySelector('.task-item[data-task-id="' + uiTaskA + '"] .task-status.is-running'));
      await app.openWorkspaceAt(${JSON.stringify(parDirB)});
      const uiTaskB = app.currentTaskId;
      await send('which folder am I in? release');
      await until(() => lastText(uiTaskB).startsWith('folder: '), 4000);
      const uiTaskBText = lastText(uiTaskB);
      const uiARunningMeanwhile = app.replies.has(uiTaskA);
      await until(() => !app.replies.has(uiTaskA), 6000);
      const uiTaskAText = lastText(uiTaskA);
      const uiUnreadDot = Boolean(document.querySelector('.task-item[data-task-id="' + uiTaskA + '"] .task-status.is-unread'));
      const uiTaskAFolder = (app.tasks.find((item) => item.id === uiTaskA) || {}).folder;
      // Steps: a command's output shows while it runs, and the answer keeps its steps.
      await send('Please use workspace run.');
      await until(() => Boolean(document.querySelector('#tool-approval-dialog')?.open), 4000);
      const uiApprovalSummary = document.querySelector('#approval-summary') ? document.querySelector('#approval-summary').textContent : '';
      document.querySelector('#approval-once')?.click();
      const uiLiveOutput = await until(() => {
        const step = document.querySelector('#chat-messages .live-reply .reply-step[data-state="running"]');
        const output = step && step.querySelector('.reply-step-output');
        return Boolean(output && output.textContent.includes('smoke-run-a') && !output.textContent.includes('smoke-run-b'));
      }, 4000);
      await until(() => lastText(uiTaskB).startsWith('tool said:'), 6000);
      const uiRunText = lastText(uiTaskB);
      const bubbles = [...document.querySelectorAll('#chat-messages .chat-bubble.assistant')];
      const lastBubble = bubbles[bubbles.length - 1];
      const uiStepsSummary = lastBubble && lastBubble.querySelector('.msg-steps-summary') ? lastBubble.querySelector('.msg-steps-summary').textContent : '';
      const uiStepOutput = lastBubble && lastBubble.querySelector('.msg-steps .reply-step-output') ? lastBubble.querySelector('.msg-steps .reply-step-output').textContent : '';
      // Changes: the reply creates a file and edits another; the card under it offers review,
      // undo and keep, and undo never overwrites later work.
      await send('Please make changes.');
      await until(() => Boolean(document.querySelector('#tool-approval-dialog')?.open), 4000);
      document.querySelector('#approval-all')?.click();
      await until(() => lastText(uiTaskB).startsWith('tool said:'), 6000);
      const changesCard = () => {
        const cards = document.querySelectorAll('#chat-messages .changes-card');
        return cards.length ? cards[cards.length - 1] : null;
      };
      const changesRow = (file) => (changesCard() ? changesCard().querySelector('.changes-row[data-path="' + file + '"]') : null);
      const rowButton = (file, label) => [...(changesRow(file) ? changesRow(file).querySelectorAll('.changes-action') : [])].find((node) => node.textContent === label);
      const cardSummary = changesCard() ? changesCard().querySelector('.changes-summary').textContent : '';
      const cardRows = changesCard() ? [...changesCard().querySelectorAll('.changes-row')].map((row) => row.dataset.path + ':' + row.querySelector('.changes-kind').textContent) : [];
      if (changesRow('b-note.txt')) changesRow('b-note.txt').querySelector('.changes-file').click();
      await until(() => Boolean(document.querySelector('#changes-dialog')?.open) && document.querySelectorAll('#changes-diff .diff-line').length > 0
        && !document.querySelector('#changes-undo').disabled, 4000);
      const reviewLines = [...document.querySelectorAll('#changes-diff .diff-line')]
        .map((row) => row.querySelector('.diff-sign').textContent + row.querySelector('.diff-text').textContent.replace(/^(Added|Removed): /, ''));
      document.querySelector('#changes-undo').click();
      await until(() => Boolean(changesRow('b-note.txt') && changesRow('b-note.txt').dataset.status === 'undone'), 4000);
      const reviewStateAfterUndo = await until(() => (document.querySelector('#changes-state')?.textContent || '') === 'Undone.', 3000);
      const afterUndo = await api.workspace.read('b-note.txt');
      document.querySelector('#changes-close').click();
      // The new file is changed by hand: its undo is refused and the hand edit stays.
      const fresh = await api.workspace.read('made/new.md');
      await api.workspace.write({ path: 'made/new.md', content: 'edited by hand\\n', revision: fresh.data.revision });
      if (rowButton('made/new.md', 'Undo')) rowButton('made/new.md', 'Undo').click();
      await until(() => /changed since this reply/.test(document.querySelector('#toast')?.textContent || ''), 4000);
      const refusedToast = document.querySelector('#toast')?.textContent || '';
      const newAfterRefusal = await api.workspace.read('made/new.md');
      if (rowButton('made/new.md', 'Keep')) rowButton('made/new.md', 'Keep').click();
      await until(() => Boolean(changesRow('made/new.md') && changesRow('made/new.md').dataset.status === 'kept'), 4000);
      const storedChanges = (() => {
        const task = app.tasks.find((item) => item.id === uiTaskB);
        const message = task ? task.messages.filter((item) => item.changes).pop() : null;
        return message ? message.changes.files.map((file) => file.path + ':' + file.status).join(',') : '';
      })();
      // Stop keeps what was written so far.
      await send('hold stream please');
      await until(() => {
        const node = document.querySelector('#chat-messages .live-reply .live-text');
        return node && node.textContent.length > 6;
      }, 3000);
      // While a reply works in this folder, undo waits (it could change files the reply uses).
      const changesId = (() => {
        const task = app.tasks.find((item) => item.id === uiTaskB);
        const message = task ? task.messages.filter((item) => item.changes).pop() : null;
        return message ? message.changes.id : 'none';
      })();
      const busyUndo = await api.checkpoints.undo({ id: changesId, paths: ['b-note.txt'] });
      document.querySelector('#cancel-btn')?.click();
      await until(() => !app.replies.has(uiTaskB), 4000);
      const stoppedTask = app.tasks.find((item) => item.id === uiTaskB);
      const stopped = stoppedTask ? stoppedTask.messages[stoppedTask.messages.length - 1] : null;
      // The stopped reply reaches the model as what it wrote, followed by a note from ScaleMax.
      await send('show history');
      await until(() => lastText(uiTaskB).startsWith('history: '), 8000);
      const historyText = lastText(uiTaskB);
      // A reply that fails part way keeps what it wrote, with the reason under it.
      const lastMessage = (taskId) => {
        const task = app.tasks.find((item) => item.id === taskId);
        return task ? task.messages[task.messages.length - 1] : null;
      };
      await send('fail midway please');
      await until(() => Boolean(lastMessage(uiTaskB) && lastMessage(uiTaskB).interrupted === 'failed'), 8000);
      const failed = lastMessage(uiTaskB) || {};
      // Stop that reaches main before the tool loop started still stops the reply.
      const early = api.provider.send({ requestId: 'smoke-early-stop', folder: ${JSON.stringify(parDirA)}, messages: [{ role: 'user', content: 'ping' }] });
      const earlyCancel = await api.provider.cancel('smoke-early-stop');
      const earlyResult = await early;
      // Deleting a task that is working stops its reply, and nothing is posted afterwards.
      await send('hold stream please');
      await until(() => app.replies.has(uiTaskB), 2000);
      const deletedRequest = app.replies.get(uiTaskB) ? app.replies.get(uiTaskB).requestId : 'none';
      const confirmBefore = window.confirm;
      window.confirm = () => true;
      document.querySelector('#delete-task-btn').click();
      window.confirm = confirmBefore;
      const deletedGone = app.tasks.every((item) => item.id !== uiTaskB) && !app.replies.has(uiTaskB);
      // Main ends the request (a Stop during preparation waits for it, Git included); left alone
      // the held stream would run for 15 s more.
      let deletedStillInMain = null;
      for (let waited = 0; waited < 8000; waited += 200) {
        await sleep(200);
        deletedStillInMain = await api.provider.cancel(deletedRequest);
        if (deletedStillInMain && deletedStillInMain.ok && deletedStillInMain.data === false) break;
      }
      const toastAfterDelete = document.querySelector('#toast') ? document.querySelector('#toast').textContent : '';

      // Background commands: the model starts one; it keeps running after the reply, the window
      // shows it above the message box and in the dialog with its output, typing reaches it and
      // Stop ends it.
      await app.openWorkspaceAt(${JSON.stringify(jobsDir)});
      const jobPending = api.provider.send({ requestId: 'smoke-job', folder: ${JSON.stringify(jobsDir)}, messages: [{ role: 'user', content: 'Please start a job.' }] });
      await until(() => Boolean(document.querySelector('#tool-approval-dialog')?.open), 8000);
      const jobApproval = document.querySelector('#approval-summary')?.textContent || '';
      document.querySelector('#approval-once')?.click();
      const jobReply = await jobPending;
      const jobText = jobReply && jobReply.ok ? jobReply.data.text : (jobReply && jobReply.error ? jobReply.error.message : '');
      const jobListed = await api.jobs.list();
      const jobBar = await until(() => !document.querySelector('#jobs-bar').hidden
        && (document.querySelector('#jobs-bar-text')?.textContent || '').includes('echo job-ready'), 3000);
      document.querySelector('#jobs-bar-show').click();
      const jobDialogOutput = await until(() => Boolean(document.querySelector('#jobs-dialog')?.open)
        && (document.querySelector('#jobs-output')?.textContent || '').includes('job-ready'), 3000);
      const jobWhere = document.querySelector('#jobs-where')?.textContent || '';
      document.querySelector('#jobs-input').value = 'hello-job';
      document.querySelector('#jobs-input-form').requestSubmit();
      const jobTyped = await until(() => (document.querySelector('#jobs-output')?.textContent || '').includes('job got hello-job'), 3000);
      document.querySelector('#jobs-stop').click();
      const jobStopped = await until(() => {
        const item = document.querySelector('#jobs-list .jobs-item.is-selected');
        return Boolean(item && item.dataset.status === 'stopped');
      }, 5000);
      const jobStateText = document.querySelector('#jobs-state')?.textContent || '';
      const jobInputOff = Boolean(document.querySelector('#jobs-input')?.disabled);
      document.querySelector('#jobs-close').click();
      const jobBarGone = await until(() => Boolean(document.querySelector('#jobs-bar').hidden), 3000);
      // The sandbox: even in Bypass, a command cannot read ScaleMax's data, and the model is told
      // what the sandbox allows; leaving it asks every time, one call at a time.
      const jobSettings = await api.store.get('settings');
      await api.store.set('settings', { ...(jobSettings || {}), permission: 'bypass', bypassConsent: true });
      const refusal = await api.provider.send({ requestId: 'smoke-refused', folder: ${JSON.stringify(jobsDir)}, messages: [{ role: 'user', content: 'Please read app data.' }] });
      const refusalText = refusal && refusal.ok ? refusal.data.text : (refusal && refusal.error ? refusal.error.message : '');
      const outsidePending = api.provider.send({ requestId: 'smoke-outside', folder: ${JSON.stringify(jobsDir)}, messages: [{ role: 'user', content: 'Please leave the sandbox.' }] });
      const outsideAsked = await until(() => Boolean(document.querySelector('#tool-approval-dialog')?.open), 4000);
      const outsideTitle = document.querySelector('#approval-title')?.textContent || '';
      const outsideSummary = document.querySelector('#approval-summary')?.textContent || '';
      const outsideAllHidden = Boolean(document.querySelector('#approval-all')?.hidden);
      document.querySelector('#approval-once')?.click();
      const outside = await outsidePending;
      const outsideText = outside && outside.ok ? outside.data.text : (outside && outside.error ? outside.error.message : '');
      await api.store.set('settings', jobSettings || {});

      // Usage/cost and compaction: the exact slash command is handled by the app, never saved as a user turn.
      // then a narrow model context triggers automatic compaction before the normal request.
      await app.openWorkspaceAt(${JSON.stringify(jobsDir)});
      app.newTask({ folder: app.rootFolder() });
      const manualCompactTask = app.currentTask();
      manualCompactTask.messages = Array.from({ length: 10 }, (_item, index) => ({
        role: index % 2 ? 'assistant' : 'user', text: 'old-' + index + ' ' + 'x'.repeat(120), time: Date.now() + index,
      }));
      manualCompactTask.updatedAt = Date.now();
      setValue('#chat-input', '/compact');
      document.querySelector('#send-btn').click();
      const manualCompacted = await until(() => Boolean(manualCompactTask.compaction && manualCompactTask.compaction.summary), 5000);
      const slashNotSaved = !manualCompactTask.messages.some((message) => message.text === '/compact');
      const manualSummary = manualCompactTask.compaction ? manualCompactTask.compaction.summary : '';
      const manualMetric = manualCompactTask.compaction ? manualCompactTask.compaction.metrics || null : null;
      // New task: enough old text for the advertised tiny window. Sending a normal message first
      // compacts old turns, then the stub confirms it got the summary but not old-0.
      app.newTask({ folder: app.rootFolder() });
      const automaticCompactTask = app.currentTask();
      automaticCompactTask.messages = Array.from({ length: 12 }, (_item, index) => ({
        role: index % 2 ? 'assistant' : 'user', text: 'old-' + index + ' ' + 'x'.repeat(3000), time: Date.now() + index,
      }));
      app.providerCatalog = app.providerCatalog.map((model) => model.id === 'smoke-model'
        ? { ...model, contextWindow: 8000, maxOutputTokens: 256 } : model);
      setValue('#chat-input', 'check compact context');
      document.querySelector('#send-btn').click();
      await until(() => {
        const last = automaticCompactTask.messages[automaticCompactTask.messages.length - 1];
        return last && last.role === 'assistant' && last.text === 'compact context: true:false';
      }, 8000);
      const automaticCompacted = Boolean(automaticCompactTask.compaction && automaticCompactTask.compaction.summary);
      const automaticText = automaticCompactTask.messages[automaticCompactTask.messages.length - 1]?.text || '';
      const replyMetric = automaticCompactTask.messages[automaticCompactTask.messages.length - 1]?.metrics || null;
      const metricsUi = document.querySelector('#chat-messages .msg-metrics')?.textContent || '';
      const crumbMetrics = document.querySelector('#chat-crumb .chat-crumb-metrics')?.textContent || '';
      const compactContextPill = document.querySelector('#chat-crumb .chat-crumb-context')?.textContent || '';
      // A context that cannot fit even after a summary must leave the exact typed draft alone;
      // the user must never have an unsent instruction silently persisted for a later request.
      app.newTask({ folder: app.rootFolder() });
      const impossibleCompactTask = app.currentTask();
      impossibleCompactTask.messages = Array.from({ length: 12 }, (_item, index) => ({
        role: index % 2 ? 'assistant' : 'user', text: 'too-old-' + index + ' ' + 'x'.repeat(3000), time: Date.now() + index,
      }));
      app.providerCatalog = app.providerCatalog.map((model) => model.id === 'smoke-model'
        ? { ...model, contextWindow: 3000, maxOutputTokens: 256 } : model);
      const unsentDraft = 'keep this exact draft unsent';
      setValue('#chat-input', unsentDraft);
      document.querySelector('#send-btn').click();
      await sleep(100);
      const failedAutoDraftKept = document.querySelector('#chat-input').value === unsentDraft
        && !impossibleCompactTask.messages.some((message) => message.text === unsentDraft);

      // Feature specs: the model writes the three documents as ordinary project files, so they
      // land in the reply's changes; the window lists them and the user ticks one off.
      // The catalog goes back to the published limits the compaction checks above shrank.
      await app.loadProvider();
      await app.openWorkspaceAt(${JSON.stringify(specsDir)});
      app.newTask({ folder: app.rootFolder() });
      const specChipShown = await until(() => Boolean(document.querySelector('#specs-open')) && !document.querySelector('#specs-open').hidden, 4000);
      const specSettings = await api.store.get('settings');
      await api.store.set('settings', { ...(specSettings || {}), permission: 'bypass', bypassConsent: true });
      const specChatTask = app.currentTask();
      setValue('#chat-input', 'Please write the offline sync spec.');
      document.querySelector('#send-btn').click();
      const specAnswered = await until(() => {
        const last = specChatTask.messages[specChatTask.messages.length - 1];
        return Boolean(last && last.role === 'assistant' && last.text === 'The spec is written and the first task is done.');
      }, 25000);
      const specReply = specChatTask.messages[specChatTask.messages.length - 1] || {};
      const specToolCalls = (specReply.tools || []).map((call) => call.tool + ':' + (call.ok ? 'ok' : 'failed')).join(',');
      const specReplyChanges = ((specReply.changes || {}).files || []).map((file) => file.path).sort().join(',');
      // The chip counts the tasks still open in this folder.
      await until(() => (document.querySelector('#specs-open-label')?.textContent || '').indexOf('open') > 0, 5000);
      const specChipLabel = document.querySelector('#specs-open-label')?.textContent || '';
      document.querySelector('#specs-open').click();
      const specDialogOpen = await until(() => Boolean(document.querySelector('#specs-dialog')?.open)
        && document.querySelectorAll('#specs-list .specs-item').length > 0, 5000);
      const specListed = Array.from(document.querySelectorAll('#specs-list .specs-item-name')).map((node) => node.textContent).join(',');
      const specTabLabels = Array.from(document.querySelectorAll('#specs-tabs .specs-tab')).map((node) => node.textContent).join(',');
      const specTabsMissing = document.querySelectorAll('#specs-tabs .specs-tab.is-missing').length;
      const specProgressBefore = document.querySelector('#specs-progress')?.textContent || '';
      const specRequirementsShown = (document.querySelector('#specs-doc .specs-markdown')?.textContent || '').includes('I can work offline');
      // The task list has real checkboxes, one already ticked by the model; the user ticks another.
      Array.from(document.querySelectorAll('#specs-tabs .specs-tab')).find((tab) => tab.dataset.doc === 'tasks')?.click();
      const specTaskRows = await until(() => document.querySelectorAll('#specs-doc .specs-task').length === 3, 4000)
        ? Array.from(document.querySelectorAll('#specs-doc .specs-task')).map((row) =>
          (row.querySelector('input').checked ? 'x' : '-') + row.querySelector('.specs-task-text').textContent).join('|')
        : 'unexpected task rows';
      document.querySelectorAll('#specs-doc .specs-task input')[1].click();
      const specProgressAfter = await until(() => (document.querySelector('#specs-progress')?.textContent || '') === '2/3 tasks done', 6000)
        ? '2/3 tasks done' : (document.querySelector('#specs-progress')?.textContent || '');
      // "Work on the open tasks" seeds the message box instead of acting behind the model's back,
      // and never over something the user is in the middle of typing.
      setValue('#chat-input', 'half-typed thought');
      document.querySelector('#specs-work').click();
      const specDraftKept = document.querySelector('#chat-input').value === 'half-typed thought';
      setValue('#chat-input', '');
      await (await import('./specs-ui.js')).openSpecs(app);
      const specReopened = await until(() => Boolean(document.querySelector('#specs-dialog')?.open)
        && document.querySelectorAll('#specs-list .specs-item').length > 0 && !document.querySelector('#specs-work').disabled, 5000);
      const specReopenState = 'open=' + Boolean(document.querySelector('#specs-dialog')?.open)
        + ' items=' + document.querySelectorAll('#specs-list .specs-item').length
        + ' disabled=' + document.querySelector('#specs-work').disabled;
      document.querySelector('#specs-work').click();
      const specWorkDraft = document.querySelector('#chat-input').value;
      const specDialogClosed = !document.querySelector('#specs-dialog').open;
      setValue('#chat-input', '');

      // Plan permission: read-only. A changing tool is refused outright, never offered for
      // approval, and the reply carries the card that runs the plan. An untouched folder shows
      // that a plan leaves the project completely alone, project notes included.
      document.querySelector('#permission-button').click();
      document.querySelector('#permission-menu [data-permission="plan"]').click();
      const planLabel = await until(() => (document.querySelector('#permission-label')?.textContent || '') === 'Plan', 4000)
        ? 'Plan' : (document.querySelector('#permission-label')?.textContent || '');
      const planStored = await api.store.get('settings');
      await app.openWorkspaceAt(${JSON.stringify(planDir)});
      app.newTask({ folder: app.rootFolder() });
      const planTask = app.currentTask();
      let planEverAsked = false;
      const planWatch = window.setInterval(() => {
        if (document.querySelector('#tool-approval-dialog')?.open) planEverAsked = true;
      }, 40);
      setValue('#chat-input', 'Please plan a change for me.');
      document.querySelector('#send-btn').click();
      const planAnswered = await until(() => {
        const last = planTask.messages[planTask.messages.length - 1];
        return Boolean(last && last.role === 'assistant' && last.text.startsWith('Plan: create planned.md'));
      }, 25000);
      window.clearInterval(planWatch);
      const planReply = planTask.messages[planTask.messages.length - 1] || {};
      const planFlag = planReply.plan === true;
      const planReplyChanged = Boolean(planReply.changes);
      const planToolCalls = (planReply.tools || []).map((call) => call.tool + ':' + (call.ok ? 'ok' : 'failed')).join(',');
      const planFileBefore = await api.workspace.read('planned.md');
      const planNotesBefore = await api.workspace.read('.scalemax/SCALEMAX.md');
      const planNoticeAfterPlan = planReply.notice || '';
      const planCardTitle = document.querySelector('#chat-messages .plan-card .plan-title')?.textContent || '';
      // "Run this plan": the permission goes back to what it was before planning, so Basic asks
      // before the write; approving it once carries the plan out.
      document.querySelector('#chat-messages .plan-card button.primary').click();
      const planRunAsked = await until(() => Boolean(document.querySelector('#tool-approval-dialog')?.open), 12000);
      const planRunPermission = document.querySelector('#permission-label')?.textContent || '';
      document.querySelector('#approval-once')?.click();
      const planRan = await until(() => {
        const last = planTask.messages[planTask.messages.length - 1];
        return Boolean(last && last.role === 'assistant' && last.text === 'Done: planned.md is written.');
      }, 25000);
      const planFileAfter = await api.workspace.read('planned.md');
      const planNotesAfter = await api.workspace.read('.scalemax/SCALEMAX.md');
      await api.store.set('settings', specSettings || {});
      await api.provider.clear();

      // OAuth app settings: the secret is write-only and HTTPS-only providers refuse loopback sign-in.
      const oauthBefore = await api.connectors.getOAuthConfig({ id: 'github' });
      const oauthSaved = await api.connectors.saveOAuthConfig({ id: 'github', clientId: 'Iv1.smoke', clientSecret: 'smoke-secret-value' });
      const oauthNoLoopback = await api.connectors.startOAuth({ id: 'intercom' });
      const oauthForgot = await api.connectors.disconnectOAuth({ id: 'github', forgetClient: true });
      const savedConnector = await api.connectors.save({ id: 'github', token: 'ghp_smoke_token_1234567890' });
      const connectorList = await api.connectors.list();
      const github = connectorList && connectorList.ok ? connectorList.data.github : null;
      const removedConnector = await api.connectors.remove({ id: 'github' });
      const listAfterRemove = await api.connectors.list();
      return {
        saveConfigured: Boolean(afterSave && afterSave.ok && afterSave.data.configured),
        testOk: Boolean(testResult && testResult.ok),
        testModels: testResult && testResult.data ? testResult.data.models : null,
        sendText: sendResult && sendResult.ok ? sendResult.data.text : null,
        uiReplies: replies,
        connectorSaved: Boolean(savedConnector && savedConnector.ok && savedConnector.data
          && savedConnector.data.connected === true),
        connectorListed: Boolean(github && github.connected === true),
        connectorHintSafe: Boolean(github && typeof github.hint === 'string'
          && !github.hint.includes('ghp_smoke_token_1234567890')),
        connectorRemoved: Boolean(removedConnector && removedConnector.ok && removedConnector.data
          && removedConnector.data.removed === true
          && (!listAfterRemove || !listAfterRemove.ok || !listAfterRemove.data.github
            || listAfterRemove.data.github.connected === false)),
        mcpTools: mcpTested && mcpTested.ok ? mcpTested.data.tools.map((tool) => tool.name) : (mcpTested?.error?.message || null),
        mcpSecretHidden: Boolean(mcpListed && mcpListed.ok && !JSON.stringify(mcpListed.data).includes('ELECTRON_RUN_AS_NODE":"1')
          && mcpListed.data.some((server) => (server.envKeys || []).includes('ELECTRON_RUN_AS_NODE'))),
        toolChatText: toolChat && toolChat.ok ? toolChat.data.text : (toolChat?.error?.message || null),
        toolChatCalls: toolChat && toolChat.ok ? toolChat.data.toolCalls : null,
        wsNoFolderText: noFolder && noFolder.ok ? noFolder.data.text : (noFolder?.error?.message || null),
        wsSelected: Boolean(wsToolsSelected && wsToolsSelected.ok && wsToolsSelected.data.root === ${JSON.stringify(wsToolsDir)}),
        uiSendBlockedNoFolder,
        uiNotice,
        uiTaskFolder,
        uiChipLocked,
        uiGroupHasTask,
        mismatchCode: mismatch && !mismatch.ok ? mismatch.error.code : null,
        streamText,
        streamPieces,
        streamedText: streamed && streamed.ok ? streamed.data.text : (streamed && streamed.error ? streamed.error.message : null),
        parTexts,
        parOrder,
        uiLiveText,
        uiSpinner,
        uiTaskBText,
        uiARunningMeanwhile,
        uiTaskAText,
        uiUnreadDot,
        uiTaskAFolder: uiTaskAFolder ? uiTaskAFolder.path : null,
        uiLiveOutput,
        uiApprovalSummary,
        cardSummary,
        cardRows,
        reviewLines,
        reviewStateAfterUndo,
        afterUndo: afterUndo && afterUndo.ok ? afterUndo.data.content : (afterUndo && afterUndo.error ? afterUndo.error.message : null),
        refusedToast,
        newAfterRefusal: newAfterRefusal && newAfterRefusal.ok ? newAfterRefusal.data.content : null,
        storedChanges,
        busyUndoCode: busyUndo && !busyUndo.ok ? busyUndo.error.code : (busyUndo && busyUndo.ok ? 'undone' : null),
        uiRunText,
        uiStepsSummary,
        uiStepOutput,
        stoppedText: stopped ? stopped.text : null,
        stoppedNotice: stopped ? stopped.notice || '' : null,
        stoppedInterrupted: stopped ? stopped.interrupted || '' : null,
        historyText,
        failedText: failed.text,
        failedNotice: failed.notice || '',
        earlyCancel,
        earlyCode: earlyResult && !earlyResult.ok ? earlyResult.error.code : (earlyResult && earlyResult.ok ? 'answered' : null),
        deletedGone,
        deletedStillInMain,
        toastAfterDelete,
        jobApproval,
        jobText,
        jobListedCount: jobListed && jobListed.ok ? jobListed.data.length : null,
        jobBar,
        jobDialogOutput,
        jobWhere,
        jobTyped,
        jobStopped,
        jobStateText,
        jobInputOff,
        jobBarGone,
        refusalText,
        outsideAsked,
        outsideTitle,
        outsideSummary,
        outsideAllHidden,
        outsideText,
        manualCompacted,
        slashNotSaved,
        manualSummary,
        manualMetric,
        automaticCompacted,
        automaticText,
        replyMetric,
        metricsUi,
        crumbMetrics,
        compactContextPill,
        failedAutoDraftKept,
        specChipShown,
        specAnswered,
        specToolCalls,
        specReplyChanges,
        specChipLabel,
        specDialogOpen,
        specListed,
        specTabLabels,
        specTabsMissing,
        specProgressBefore,
        specRequirementsShown,
        specTaskRows,
        specProgressAfter,
        specDraftKept,
        specReopened,
        specReopenState,
        specWorkDraft,
        specDialogClosed,
        planLabel,
        planStoredPermission: planStored && typeof planStored === 'object' ? String(planStored.permission || '') : '',
        planAnswered,
        planEverAsked,
        planFlag,
        planReplyChanged,
        planToolCalls,
        planFileMissingBefore: Boolean(planFileBefore && planFileBefore.ok === false),
        planNoNotesWhilePlanning: Boolean(planNotesBefore && planNotesBefore.ok === false),
        planNoticeAfterPlan,
        planCardTitle,
        planRunAsked,
        planRunPermission,
        planRan,
        planFileAfter: planFileAfter && planFileAfter.ok ? planFileAfter.data.content : null,
        planNotesAfterRun: Boolean(planNotesAfter && planNotesAfter.ok === true),
        modeTools,
        matchedText: matched && matched.ok ? matched.data.text : (matched?.error?.message || null),
        wsFolderText: folderReply && folderReply.ok ? folderReply.data.text : (folderReply?.error?.message || null),
        wsToolText: wsToolChat && wsToolChat.ok ? wsToolChat.data.text : (wsToolChat?.error?.message || null),
        wsToolCalls: wsToolChat && wsToolChat.ok ? wsToolChat.data.toolCalls : null,
        failedUsage: failedUsage && !failedUsage.ok ? failedUsage.error.metrics || null : null,
        wsNotesFirst: folderReply && folderReply.ok ? folderReply.data.projectNotes || null : null,
        wsNotesSecond: wsToolChat && wsToolChat.ok ? wsToolChat.data.projectNotes || null : null,
        wsCurrent,
        approvalShown,
        approvalTitle,
        approvedCalls: approved && approved.ok ? approved.data.toolCalls : (approved?.error?.message || null),
        approvedText: approved && approved.ok ? approved.data.text : null,
        deniedCalls: denied && denied.ok ? denied.data.toolCalls : (denied?.error?.message || null),
        approvalClosed: !document.querySelector('#tool-approval-dialog')?.open,
        oauthSupported: Boolean(oauthBefore && oauthBefore.ok && oauthBefore.data.supported === true
          && oauthBefore.data.redirectUri === 'http://127.0.0.1:53682/callback'),
        oauthSecretHidden: Boolean(oauthSaved && oauthSaved.ok && oauthSaved.data.hasSecret === true
          && !JSON.stringify(oauthSaved.data).includes('smoke-secret-value')),
        oauthNoLoopbackRefused: Boolean(oauthNoLoopback && !oauthNoLoopback.ok && /HTTPS redirects/.test(oauthNoLoopback.error.message)),
        oauthForgotten: Boolean(oauthForgot && oauthForgot.ok && oauthForgot.data.clientForgotten === true),
      };
    })()`);
  } catch (error) {
    errors.push(`e2e failed: ${error.message}`);
  }
  const wsNotesOnDisk = (() => {
    try { return fs.readFileSync(path.join(wsToolsDir, '.scalemax', 'SCALEMAX.md'), 'utf8'); } catch { return null; }
  })();
  // Read before the folder goes: the spec documents the model wrote are ordinary project files.
  const specTasksOnDisk = (() => {
    try { return fs.readFileSync(path.join(specsDir, '.scalemax', 'specs', 'offline-sync', 'tasks.md'), 'utf8'); } catch { return null; }
  })();
  const specDocsOnDisk = (() => {
    try { return fs.readdirSync(path.join(specsDir, '.scalemax', 'specs', 'offline-sync')).sort().join(','); } catch { return null; }
  })();
  const plannedOnDisk = fs.existsSync(path.join(planDir, 'planned.md'));
  for (const dir of [wsToolsDir, parDirA, parDirB, jobsDir, specsDir, planDir]) fs.rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));

  // Automation creation must capture the weekday/month inputs and schedule a next run.
  let automation = null;
  try {
    automation = await win.webContents.executeJavaScript(`(async () => {
      const api = window.scalemaxAPI;
      const setValue = (selector, value) => {
        const node = document.querySelector(selector);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('#automation-name', 'Smoke schedule');
      setValue('#automation-prompt', 'Reply with exactly: OK');
      const schedule = document.querySelector('#automation-schedule');
      schedule.value = 'weekly';
      schedule.dispatchEvent(new Event('change', { bubbles: true }));
      setValue('#automation-time', '09:00');
      setValue('#automation-weekday', '3');
      document.querySelector('#automation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stored = await api.store.get('automations');
      const last = Array.isArray(stored) ? stored[stored.length - 1] : null;
      return {
        count: Array.isArray(stored) ? stored.length : 0,
        name: last ? last.name : null,
        schedule: last ? last.schedule : null,
        dayOfWeek: last ? last.dayOfWeek : null,
        schemaVersion: last ? last.schemaVersion : null,
        hasNextRun: Boolean(last && Number.isFinite(last.nextRun) && last.nextRun > Date.now()),
        rendered: document.querySelectorAll('#automation-list .automation-item').length,
      };
    })()`);
  } catch (error) {
    errors.push(`automation check failed: ${error.message}`);
  }

  // Workspace round-trip against a throwaway folder.
  let workspace = null;
  const wsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scalemax-ws-'));
  fs.writeFileSync(path.join(wsDir, 'hello.txt'), 'hello world');
  try {
    workspace = await win.webContents.executeJavaScript(`(async () => {
      const api = window.scalemaxAPI;
      const selected = await api.workspace.select(${JSON.stringify(wsDir)});
      if (!selected || !selected.ok) return { error: selected?.error?.message || 'select failed' };
      const listed = await api.workspace.list();
      const read = await api.workspace.read('hello.txt');
      if (!read || !read.ok) return { error: read?.error?.message || 'read failed' };
      const written = await api.workspace.write({ path: 'hello.txt', content: 'updated content', revision: read.data.revision });
      const after = await api.workspace.read('hello.txt');
      const git = await api.workspace.gitStatus();
      const terminal = await api.workspace.run({ command: 'printf terminal-ok' });
      const { default: app } = await import('./app.js');
      await app.openWorkspaceAt(${JSON.stringify(wsDir)});
      await app.openFile('hello.txt');
      const tabs = document.querySelectorAll('#editor-tabs .ws-tab').length;
      const title = document.querySelector('#editor-title')?.textContent;
      return {
        uiTabs: tabs,
        uiTitle: title,
        root: selected.data.root,
        names: (listed.data.files || []).map((f) => f.name),
        before: read.data.content,
        wrote: Boolean(written && written.ok),
        after: after && after.ok ? after.data.content : null,
        gitOk: Boolean(git && git.ok),
        terminalOk: Boolean(terminal && terminal.ok && terminal.data && String(terminal.data.stdout).includes('terminal-ok')),
        terminalExit: terminal && terminal.ok ? terminal.data.exitCode : null,
      };
    })()`);
  } catch (error) {
    errors.push(`workspace check failed: ${error.message}`);
  }
  fs.rmSync(wsDir, { recursive: true, force: true });

  // Opt-in live check against the real ScaleMax API. The key is supplied by the
  // environment and never stored in the repository.
  let live = null;
  const liveKey = process.env.SCALEMAX_LIVE_KEY;
  if (liveKey) {
    try {
      live = await win.webContents.executeJavaScript(`(async () => {
        const api = window.scalemaxAPI;
        const key = ${JSON.stringify(liveKey)};
        const preferred = ${JSON.stringify(process.env.SCALEMAX_LIVE_MODEL || '')};
        const found = await api.provider.discover({ kind: 'scalemax', apiKey: key });
        if (!found || !found.ok) return { error: found?.error?.message || 'discover failed' };
        const models = found.data.models || [];
        const wanted = preferred ? models.find((model) => model.id === preferred) : null;
        const flash = models.find((model) => model.available !== false && /deepseek.*flash/i.test(model.id));
        const first = wanted || flash || models.find((model) => model.available !== false) || models[0];
        if (!first) return { error: 'no models returned' };
        const saved = await api.provider.save({
          kind: 'scalemax',
          baseUrl: found.data.baseUrl,
          model: first.id,
          enabledModels: models.map((model) => model.id).slice(0, 3),
          models,
          apiKey: key,
        });
        if (!saved || !saved.ok) return { error: saved?.error?.message || 'save failed' };
        const sent = await api.provider.send({
          requestId: 'live-' + Date.now(),
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        });
        // The real API streams: a longer answer arrives in many pieces. The prompt is new every
        // run: the API answers a prompt it has seen before from a cache, in one piece.
        const countId = 'live-count-' + Date.now();
        const phases = [];
        const offCount = api.provider.onProgress((event) => { if (event && event.requestId === countId) phases.push(event.phase); });
        const approvalsSeen = [];
        const offApprovals = api.approvals.onRequest((request) => approvalsSeen.push(request.toolName));
        const permissionNow = (await api.store.get('settings') || {}).permission || '(none)';
        // Coding mode has no computer tools, and the prompt asks for no tools: the check must
        // never touch the clipboard or the web of the machine it runs on.
        const counted = await api.provider.send({
          requestId: countId,
          mode: 'coding',
          messages: [{ role: 'user', content: 'Without using any tools, write the answer directly in your reply: count from 1 to 80 in words (one, two, ...), separated by commas, then write the code '
            + countId + '. Nothing else.' }],
        });
        offCount();
        offApprovals();
        await api.provider.clear();
        const meta = await api.provider.get();
        return {
          baseUrl: found.data.baseUrl,
          modelCount: models.length,
          chosen: first.id,
          configured: saved.data.configured,
          enabledCount: saved.data.enabledModels ? saved.data.enabledModels.length : 0,
          reply: sent && sent.ok ? sent.data.text : null,
          countText: counted && counted.ok ? counted.data.text.slice(-160) : (counted && counted.error ? counted.error.message : null),
          countTools: counted && counted.ok ? (counted.data.toolCalls || []).map((call) => call.server + '.' + call.tool + ':' + call.ok + ':' + String(call.preview).slice(0, 80)) : null,
          countHasEighty: Boolean(counted && counted.ok && /eighty/i.test(counted.data.text)),
          approvalsSeen,
          permissionNow,
          countDeltas: phases.filter((phase) => phase === 'delta' || phase === 'text-set').length,
          sendError: sent && !sent.ok ? sent.error.message : null,
          cleared: meta && meta.ok ? meta.data.configured : null,
        };
      })()`);
    } catch (error) {
      errors.push(`live check failed: ${error.message}`);
    }
  }

  const checks = probe ? {
    hasBridge: probe.hasBridge,
    reservedKeysHidden: probe.reservedHidden,
    providerMethods: probe.providerMethods.length === 16,
    mediaApi: probe.mediaMethods.length === 6,
    approvalApi: probe.approvalMethods.length === 3,
    checkpointApi: probe.checkpointMethods.length === 5,
    jobsApi: probe.jobMethods.length === 6 && probe.commandSettings === true,
    conversationSettings: probe.conversationSettings === true,
    composerControls: probe.composerControls === true && probe.attachIsIcon === true,
    permissionDefaultBasic: probe.permissionLabel === 'Basic',
    workspaceApi: probe.workspaceMethods.length === 9,
    dialogApi: probe.dialogMethods.length === 2,
    connectorApi: probe.connectorMethods.length === 15,
    mcpApi: probe.mcpMethods.length === 7,
    providerGetOk: probe.providerGetOk,
    providerConfiguredFalse: probe.providerConfigured,
    cancelOk: probe.cancelOk,
    // The seeded task is empty and has no folder yet, so the task list starts empty.
    taskListStartsEmpty: probe.taskCount === '0',
    versionLoaded: probe.version === '1.0.0',
    chatInputEnabled: probe.chatInputDisabled === false,
    // No chat without a folder: Send stays off and the folder picker is shown.
    sendNeedsFolder: probe.sendDisabledAfterTyping === true && probe.folderPickerShown === true,
    views: probe.viewCount === 6,
    communityCards: probe.communityCards === 7,
    catalogCategories: probe.catalogCategories > 1,
    schedulerStatusText: typeof probe.schedulerStatus === 'string' && probe.schedulerStatus.length > 0,
    themeApplied: probe.theme === 'light' || probe.theme === 'dark',
    e2eSaveConfigured: Boolean(e2e && e2e.saveConfigured),
    e2eTestModels: Boolean(e2e && e2e.testOk && Array.isArray(e2e.testModels) && e2e.testModels.includes('smoke-model')),
    e2eSendText: Boolean(e2e && e2e.sendText === 'pong'),
    e2eUiReply: Boolean(e2e && Array.isArray(e2e.uiReplies) && e2e.uiReplies.includes('pong')),
    connectorSaved: Boolean(e2e && e2e.connectorSaved),
    connectorListed: Boolean(e2e && e2e.connectorListed),
    connectorHintSafe: Boolean(e2e && e2e.connectorHintSafe),
    connectorRemoved: Boolean(e2e && e2e.connectorRemoved),
    mcpStdioTools: Boolean(e2e && Array.isArray(e2e.mcpTools) && e2e.mcpTools.includes('echo') && e2e.mcpTools.includes('add')),
    mcpSecretHidden: Boolean(e2e && e2e.mcpSecretHidden),
    toolLoopReply: Boolean(e2e && e2e.toolChatText === 'tool said: smoke-echo'
      && Array.isArray(e2e.toolChatCalls) && e2e.toolChatCalls.length === 1 && e2e.toolChatCalls[0].ok === true),
    manualApprovalAllow: Boolean(e2e && e2e.approvalShown && /Smoke tools · echo/.test(e2e.approvalTitle)
      && Array.isArray(e2e.approvedCalls) && e2e.approvedCalls.length === 1 && e2e.approvedCalls[0].ok === true
      && e2e.approvedText === 'tool said: smoke-echo'),
    workspaceFolderPrompt: Boolean(e2e && e2e.wsNoFolderText === 'folder: none' && e2e.wsSelected
      && e2e.wsFolderText === `folder: ${path.basename(wsToolsDir)}`),
    workspaceToolLoop: Boolean(e2e && typeof e2e.wsToolText === 'string' && e2e.wsToolText.startsWith('tool said: ')
      && e2e.wsToolText.includes('smoke-note.txt') && Array.isArray(e2e.wsToolCalls) && e2e.wsToolCalls.length === 1
      && e2e.wsToolCalls[0].server === 'Workspace' && e2e.wsToolCalls[0].tool === 'list_files' && e2e.wsToolCalls[0].ok === true),
    failedToolUsageRetained: Boolean(e2e && e2e.failedUsage && e2e.failedUsage.costStatus === 'incomplete'
      && e2e.failedUsage.usage && e2e.failedUsage.usage.totalTokens === 18 && e2e.failedUsage.costMicroUsd === 24),
    // The first message in the folder (sent from the window) created the notes; later ones do not.
    projectNotesCreated: Boolean(e2e && typeof e2e.uiNotice === 'string' && e2e.uiNotice.includes('Created .scalemax/SCALEMAX.md')
      && e2e.wsNotesFirst === null && e2e.wsNotesSecond === null
      && typeof wsNotesOnDisk === 'string' && wsNotesOnDisk.startsWith(`# ${path.basename(wsToolsDir)}\n`)),
    uiNeedsFolder: Boolean(e2e && e2e.uiSendBlockedNoFolder === true),
    taskFolderLocked: Boolean(e2e && e2e.uiTaskFolder === wsToolsDir && e2e.uiChipLocked === true && e2e.uiGroupHasTask === true),
    folderNotOpenedRefused: Boolean(e2e && e2e.mismatchCode === 'FOLDER_NOT_OPENED' && e2e.matchedText === 'pong'),
    // The reply streams: many pieces, together the whole answer.
    streamingDeltas: Boolean(e2e && e2e.streamPieces >= 5 && e2e.streamText === SLOW_TEXT && e2e.streamedText === SLOW_TEXT),
    // Two requests in two folders at once: each answers from its own folder, the fast one first.
    parallelFolders: Boolean(e2e && Array.isArray(e2e.parTexts) && e2e.parTexts[0] === `folder: ${path.basename(parDirA)}`
      && e2e.parTexts[1] === `folder: ${path.basename(parDirB)}` && e2e.parOrder === true),
    // In the window: task A streams (spinner in the sidebar) while task B in another folder answers.
    parallelTasksUi: Boolean(e2e && e2e.uiLiveText && e2e.uiSpinner && e2e.uiTaskBText === `folder: ${path.basename(parDirB)}`
      && e2e.uiARunningMeanwhile === true && e2e.uiTaskAText === SLOW_TEXT && e2e.uiUnreadDot && e2e.uiTaskAFolder === parDirA),
    // A command's output shows while it runs; the answer keeps its steps and the output.
    liveToolSteps: Boolean(e2e && e2e.uiLiveOutput && typeof e2e.uiRunText === 'string' && e2e.uiRunText.includes('smoke-run-asmoke-run-b')
      && e2e.uiApprovalSummary.includes(`the folder "${path.basename(parDirB)}"`)
      && e2e.uiStepsSummary.startsWith('1 step · Ran a command') && e2e.uiStepOutput.includes('smoke-run-b')),
    // Stop keeps the text written so far, marked as stopped.
    stopKeepsPartial: Boolean(e2e && typeof e2e.stoppedText === 'string' && e2e.stoppedText.length > 0
      && e2e.stoppedText.length < SLOW_TEXT.length && SLOW_TEXT.startsWith(e2e.stoppedText) && /Stopped/.test(e2e.stoppedNotice)
      && e2e.stoppedInterrupted === 'stopped'),
    // The next request carries the stopped reply's text and a note from ScaleMax after it.
    // The next request carries notes after the reply whose file was undone and the stopped one.
    stoppedHistoryNote: Boolean(e2e && e2e.historyText === 'history: user,assistant,user,assistant,user,assistant,user(note),user,assistant,user(note),user'),
    // A reply's changes: a card lists them, the review shows the diff, undo puts a file back,
    // an undo after a hand edit is refused, and keep ends the choice; all kept with the task.
    changesCard: Boolean(e2e && e2e.cardSummary === '2 files changed · +2 \u22121'
      && Array.isArray(e2e.cardRows) && e2e.cardRows.join(',') === 'made/new.md:New,b-note.txt:Edited'),
    changesReview: Boolean(e2e && Array.isArray(e2e.reviewLines) && e2e.reviewLines.includes('line one')
      && e2e.reviewLines.includes('\u2212line two') && e2e.reviewLines.includes('+line 2')),
    changesUndo: Boolean(e2e && e2e.afterUndo === 'line one\nline two\n' && e2e.reviewStateAfterUndo === true),
    changesUndoRefused: Boolean(e2e && /changed since this reply/.test(e2e.refusedToast || '') && e2e.newAfterRefusal === 'edited by hand\n'),
    changesKept: Boolean(e2e && e2e.storedChanges === 'made/new.md:kept,b-note.txt:undone'),
    undoWaitsForReplies: Boolean(e2e && e2e.busyUndoCode === 'FOLDER_BUSY'),
    // A reply that fails part way keeps its text, with the provider's reason under it.
    failedKeepsPartial: Boolean(e2e && e2e.failedText === 'Partial answer before the failure.' && /stub overloaded/.test(e2e.failedNotice)),
    // Stop that reaches main before the tool loop started still stops the reply.
    earlyStop: Boolean(e2e && e2e.earlyCancel && e2e.earlyCancel.ok && e2e.earlyCancel.data === true && e2e.earlyCode === 'CANCELLED'),
    // Deleting a working task stops its reply in main and posts nothing afterwards.
    deleteStopsReply: Boolean(e2e && e2e.deletedGone && e2e.deletedStillInMain && e2e.deletedStillInMain.ok
      && e2e.deletedStillInMain.data === false && !/no longer exists/.test(e2e.toastAfterDelete || '')),
    // A background command: started by the model (in the sandbox, after the prompt said so), it
    // outlives the reply; the window shows it, its output and what is typed into it, and stops it.
    backgroundJob: Boolean(e2e && /Background command j\d+: echo job-ready/.test(e2e.jobText) && /running for/.test(e2e.jobText)
      && /in the sandbox/.test(e2e.jobText) && /job-ready/.test(e2e.jobText) && e2e.jobListedCount >= 1
      && /keeps running in the background/.test(e2e.jobApproval) && /It runs in the sandbox/.test(e2e.jobApproval)),
    jobsWindow: Boolean(e2e && e2e.jobBar && e2e.jobDialogOutput && /in the sandbox/.test(e2e.jobWhere) && e2e.jobTyped
      && e2e.jobStopped && /^Stopped/.test(e2e.jobStateText) && e2e.jobInputOff && e2e.jobBarGone),
    // In the sandbox a command cannot read ScaleMax's data, and the model hears what it allows.
    sandboxRefusal: Boolean(e2e && /operation not permitted/i.test(e2e.refusalText) && /sandbox: false/.test(e2e.refusalText)),
    // Leaving the sandbox asks even in Bypass, one call at a time, and then works.
    unsandboxedAsks: Boolean(e2e && e2e.outsideAsked && e2e.outsideTitle === 'Run this command outside the sandbox?'
      && /outside the sandbox/.test(e2e.outsideSummary) && e2e.outsideAllHidden && /outside-ok/.test(e2e.outsideText)),
    // Usage/provider cost persist on a reply; exact /compact never becomes a user/model prompt,
    // and automatic compaction uses the published context limit before a normal send.
    usageAndCompaction: Boolean(e2e && e2e.manualCompacted && e2e.slashNotSaved && /^Stub summary:/.test(e2e.manualSummary)
      && e2e.manualMetric && e2e.manualMetric.costStatus === 'priced' && e2e.automaticCompacted
      && e2e.automaticText === 'compact context: true:false' && e2e.replyMetric && e2e.replyMetric.costStatus === 'priced'
      && /12 in · 6 out · \$0\.000024/.test(e2e.metricsUi) && /tokens · \$/.test(e2e.crumbMetrics)
      && e2e.compactContextPill === 'Context compacted' && e2e.failedAutoDraftKept === true),
    specApi: probe.specMethods.length === 3 && probe.specsControls === true,
    // The model writes requirements, design and tasks as project files and ticks a task off; the
    // documents land in the reply's changes like any other edit.
    specWriting: Boolean(e2e && e2e.specAnswered && e2e.specToolCalls === 'spec_write:ok,spec_write:ok,spec_write:ok,spec_task:ok'
      && e2e.specReplyChanges === '.scalemax/specs/offline-sync/design.md,.scalemax/specs/offline-sync/requirements.md,.scalemax/specs/offline-sync/tasks.md'
      && typeof specDocsOnDisk === 'string' && specDocsOnDisk === 'design.md,requirements.md,tasks.md'
      && typeof specTasksOnDisk === 'string' && specTasksOnDisk.includes('- [x] Add the queue')),
    // The window: a chip that counts the open tasks, the three documents, and a task the user
    // ticks off themselves (which is a change to their own file).
    specsWindow: Boolean(e2e && e2e.specChipShown && e2e.specDialogOpen && e2e.specListed === 'offline-sync'
      && e2e.specChipLabel === 'Specs · 1 · 2 open' && e2e.specTabLabels === 'Requirements,Design,Tasks'
      && e2e.specTabsMissing === 0 && e2e.specProgressBefore === '1/3 tasks done' && e2e.specRequirementsShown
      && e2e.specTaskRows === 'xAdd the queue|-Flush it on reconnect|-Retry once'
      && e2e.specProgressAfter === '2/3 tasks done' && typeof specTasksOnDisk === 'string'
      && specTasksOnDisk.includes('- [x] Flush it on reconnect')
      && e2e.specDialogClosed && e2e.specDraftKept === true && e2e.specReopened === true
      && /Work through the open tasks of the "offline-sync" spec/.test(e2e.specWorkDraft)),
    // Plan permission changes nothing and never asks: the write is refused outright, not offered.
    planRefusesChanges: Boolean(e2e && e2e.planLabel === 'Plan' && e2e.planStoredPermission === 'plan'
      && e2e.planAnswered && e2e.planEverAsked === false && e2e.planToolCalls === 'write_file:failed'
      && e2e.planReplyChanged === false && e2e.planFileMissingBefore === true && e2e.planFlag === true
      && /Plan only/.test(e2e.planCardTitle)),
    // A plan leaves the folder completely alone: not even the project notes are written, and the
    // first request that may change something writes them.
    planWritesNoNotes: Boolean(e2e && e2e.planNoNotesWhilePlanning === true && e2e.planNoticeAfterPlan === ''
      && e2e.planNotesAfterRun === true),
    // "Run this plan" puts the permission back where it was before planning, so Basic asks once,
    // and then the plan is really carried out.
    planRunsAfterwards: Boolean(e2e && e2e.planRunAsked && e2e.planRunPermission === 'Basic' && e2e.planRan
      && e2e.planFileAfter === 'planned line\n' && plannedOnDisk === true),
    modeToolSets: (() => {
      const sets = (e2e && e2e.modeTools) || {};
      const names = (value) => (typeof value === 'string' && value.startsWith('tools: ') ? value.slice(7).split(',') : []);
      const working = names(sets.working);
      const coding = names(sets.coding);
      const fallback = names(sets.nonsense);
      return working.includes('web_search') && working.includes('web_open') && working.includes('computer_clipboard_read')
        && working.includes('workspace_read') && coding.includes('web_search') && coding.includes('workspace_edit')
        && !coding.some((name) => name.startsWith('computer_')) && fallback.join(',') === working.join(',');
    })(),
    workspaceRemembered: Boolean(e2e && e2e.wsCurrent && e2e.wsCurrent.ok && e2e.wsCurrent.data.root === wsToolsDir
      && e2e.wsCurrent.data.recent.some((item) => item.path === wsToolsDir)),
    manualApprovalDeny: Boolean(e2e && Array.isArray(e2e.deniedCalls) && e2e.deniedCalls.length === 1
      && e2e.deniedCalls[0].ok === false && /denied/.test(e2e.deniedCalls[0].preview) && e2e.approvalClosed),
    oauthSupported: Boolean(e2e && e2e.oauthSupported),
    oauthSecretHidden: Boolean(e2e && e2e.oauthSecretHidden),
    oauthNoLoopbackRefused: Boolean(e2e && e2e.oauthNoLoopbackRefused),
    oauthForgotten: Boolean(e2e && e2e.oauthForgotten),
    automationCreated: Boolean(automation && automation.count >= 1 && automation.schedule === 'weekly'
      && automation.dayOfWeek === 3 && automation.schemaVersion === 2 && automation.hasNextRun && automation.rendered >= 1),
    noConsoleErrors: errors.length === 0,
    workspaceRoot: Boolean(workspace && workspace.root),
    workspaceListsFile: Boolean(workspace && Array.isArray(workspace.names) && workspace.names.includes('hello.txt')),
    workspaceRead: Boolean(workspace && workspace.before === 'hello world'),
    workspaceWrite: Boolean(workspace && workspace.wrote && workspace.after === 'updated content'),
    workspaceTerminal: Boolean(workspace && workspace.terminalOk && workspace.terminalExit === 0),
    workspaceEditorTab: Boolean(workspace && workspace.uiTabs === 1 && workspace.uiTitle === 'hello.txt'),
    ...(liveKey ? {
      // Discover picks whichever official endpoint authenticates the key.
      liveDiscoverBase: Boolean(live && ['https://api.scalemax.pro/v1', 'https://api.scalemax.pro/token/v1'].includes(live.baseUrl)),
      liveModelCount: Boolean(live && live.modelCount > 0),
      liveConfigured: Boolean(live && live.configured),
      liveChatReply: Boolean(live && live.reply),
      liveStreaming: Boolean(live && live.countDeltas >= 3 && live.countHasEighty),
      liveCleared: Boolean(live && live.cleared === false),
    } : {}),
  } : { probeFailed: false };

  const ok = probe !== null && Object.values(checks).every(Boolean);
  console.log('SMOKE_RESULT ' + JSON.stringify({ ok, checks, probe, e2e, automation, workspace, live, errors, logs }, null, 2));
  // The smoke run owns its throwaway userData directory; never leave it behind.
  try {
    fs.rmSync(path.join(os.tmpdir(), 'scalemax-smoke-' + process.pid), { recursive: true, force: true });
  } catch (error) {
    console.error('SMOKE_CLEANUP_FAILED ' + error.message);
  }
  return ok ? 0 : 1;
}

module.exports = { run };
