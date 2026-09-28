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
  if (typeof last.content === 'string' && last.content.includes('name your tools')) {
    return { role: 'assistant', content: `tools: ${tools.map((tool) => tool.function.name).join(',')}` };
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
      res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
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
        res.end(JSON.stringify({ model: 'smoke-model', choices: [{ message: whole }] }));
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
        providerMethods: ['get','save','test','discover','send','cancel','clear','setModel','refreshModels','onProgress','profiles','addProfile','selectProfile','renameProfile','removeProfile'].filter((m) => typeof api.provider?.[m] === 'function'),
        workspaceMethods: ['select','current','list','read','write','gitStatus','gitDiff','run','cancel'].filter((m) => typeof api.workspace?.[m] === 'function'),
        dialogMethods: ['openFolder','openFile'].filter((m) => typeof api.dialog?.[m] === 'function'),
        connectorMethods: ['list','save','remove','test','fetch','saveOAuthConfig','getOAuthConfig','startOAuth','oauthStatus','disconnectOAuth','cliAvailable','cliConnect','cliWait','cliStatus','cliCancel'].filter((m) => typeof api.connectors?.[m] === 'function'),
        mediaMethods: ['generate','cancel','info','pickImage','save','onProgress'].filter((m) => typeof api.media?.[m] === 'function'),
        approvalMethods: ['onRequest','onClosed','respond'].filter((m) => typeof api.approvals?.[m] === 'function'),
        composerControls: ['#attach-btn svg', '#permission-button', '#model-button', '#model-menu[popover]', '#permission-menu[popover]', '#bypass-dialog', '#tool-approval-dialog']
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
  try {
    e2e = await win.webContents.executeJavaScript(`(async () => {
      const api = window.scalemaxAPI;
      const setValue = (selector, value) => {
        const node = document.querySelector(selector);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const kindSelect = document.querySelector('#provider-kind');
      kindSelect.value = 'custom';
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setValue('#provider-base-url', 'http://127.0.0.1:${port}/v1');
      setValue('#provider-model', 'smoke-model');
      document.querySelector('#provider-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterSave = await api.provider.get();
      const testResult = await api.provider.test();
      const sendResult = await api.provider.send({ requestId: 'smoke-e2e', messages: [{ role: 'user', content: 'ping' }] });
      // Built-in workspace tools: none without a folder, and the instructions say so.
      const noFolder = await api.provider.send({ requestId: 'smoke-ws-none', messages: [{ role: 'user', content: 'which folder am I in?' }] });
      // A chat cannot start without a folder: Send stays off until one is open.
      const input = document.querySelector('#chat-input');
      input.value = 'ping';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const uiSendBlockedNoFolder = Boolean(document.querySelector('#send-btn')?.disabled);
      const { default: app } = await import('./app.js');
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
      // Stop keeps what was written so far.
      await send('hold stream please');
      await until(() => {
        const node = document.querySelector('#chat-messages .live-reply .live-text');
        return node && node.textContent.length > 6;
      }, 3000);
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
        modeTools,
        matchedText: matched && matched.ok ? matched.data.text : (matched?.error?.message || null),
        wsFolderText: folderReply && folderReply.ok ? folderReply.data.text : (folderReply?.error?.message || null),
        wsToolText: wsToolChat && wsToolChat.ok ? wsToolChat.data.text : (wsToolChat?.error?.message || null),
        wsToolCalls: wsToolChat && wsToolChat.ok ? wsToolChat.data.toolCalls : null,
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
  for (const dir of [wsToolsDir, parDirA, parDirB]) fs.rmSync(dir, { recursive: true, force: true });
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
        const counted = await api.provider.send({
          requestId: countId,
          messages: [{ role: 'user', content: 'Count from 1 to 80 in words (one, two, ...), separated by commas, then write the code '
            + countId + '. Nothing else.' }],
        });
        offCount();
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
    providerMethods: probe.providerMethods.length === 15,
    mediaApi: probe.mediaMethods.length === 6,
    approvalApi: probe.approvalMethods.length === 3,
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
    stoppedHistoryNote: Boolean(e2e && e2e.historyText === 'history: user,assistant,user,assistant,user,assistant,user(note),user'),
    // A reply that fails part way keeps its text, with the provider's reason under it.
    failedKeepsPartial: Boolean(e2e && e2e.failedText === 'Partial answer before the failure.' && /stub overloaded/.test(e2e.failedNotice)),
    // Stop that reaches main before the tool loop started still stops the reply.
    earlyStop: Boolean(e2e && e2e.earlyCancel && e2e.earlyCancel.ok && e2e.earlyCancel.data === true && e2e.earlyCode === 'CANCELLED'),
    // Deleting a working task stops its reply in main and posts nothing afterwards.
    deleteStopsReply: Boolean(e2e && e2e.deletedGone && e2e.deletedStillInMain && e2e.deletedStillInMain.ok
      && e2e.deletedStillInMain.data === false && !/no longer exists/.test(e2e.toastAfterDelete || '')),
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
      liveStreaming: Boolean(live && live.countDeltas >= 3 && /eighty/i.test(live.countText || '')),
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
