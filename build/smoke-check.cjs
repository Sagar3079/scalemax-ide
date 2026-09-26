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
function stubReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1] || {};
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const echo = tools.find((tool) => /_echo$/.test(tool?.function?.name || ''));
  if (last.role === 'tool') return { role: 'assistant', content: `tool said: ${last.content}` };
  if (echo && typeof last.content === 'string' && last.content.includes('use echo')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_smoke_1', type: 'function', function: { name: echo.function.name, arguments: JSON.stringify({ text: 'smoke-echo' }) } }],
    };
  }
  return { role: 'assistant', content: 'pong' };
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'smoke-model', choices: [{ message: stubReply(body) }] }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function run(win) {
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
      const reservedKeys = ['provider', 'connectors', 'connectorOAuthClients', 'mcpServers', 'user'];
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
        providerMethods: ['get','save','test','discover','send','cancel','clear'].filter((m) => typeof api.provider?.[m] === 'function'),
        workspaceMethods: ['select','list','read','write','gitStatus','gitDiff','run','cancel'].filter((m) => typeof api.workspace?.[m] === 'function'),
        dialogMethods: ['openFolder','openFile'].filter((m) => typeof api.dialog?.[m] === 'function'),
        connectorMethods: ['list','save','remove','test','fetch','saveOAuthConfig','getOAuthConfig','startOAuth','oauthStatus','disconnectOAuth'].filter((m) => typeof api.connectors?.[m] === 'function'),
        mcpMethods: ['list','save','remove','test','tools'].filter((m) => typeof api.mcp?.[m] === 'function'),
        providerGetOk: providerResult && providerResult.ok === true,
        providerConfigured: providerResult && providerResult.data && providerResult.data.configured === false,
        cancelOk: cancelResult && cancelResult.ok === true,
        taskCount: document.querySelector('#task-count')?.textContent,
        version: document.querySelector('#about-version')?.textContent,
        appStatus: document.querySelector('#app-status')?.textContent,
        providerStatus: document.querySelector('#provider-status')?.textContent,
        chatInputDisabled: Boolean(document.querySelector('#chat-input')?.disabled),
        sendDisabledAfterTyping: Boolean(document.querySelector('#send-btn')?.disabled),
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
      const input = document.querySelector('#chat-input');
      input.value = 'ping';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#send-btn').click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const replies = [...document.querySelectorAll('#chat-messages .chat-bubble.assistant .msg-text')].map((node) => node.textContent);

      // MCP: a real stdio server (the test fixture run by this Electron binary as Node).
      const mcpSaved = await api.mcp.save({
        name: 'Smoke tools', transport: 'stdio', command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(FAKE_MCP_SERVER)}], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true,
      });
      const mcpTested = mcpSaved.ok ? await api.mcp.test({ id: mcpSaved.data.id }) : mcpSaved;
      const mcpListed = await api.mcp.list();
      const toolChat = await api.provider.send({ requestId: 'smoke-tools', messages: [{ role: 'user', content: 'Please use echo.' }] });
      if (mcpSaved.ok) await api.mcp.remove({ id: mcpSaved.data.id });
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
      app.applyWorkspace(selected.data);
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
        await api.provider.clear();
        const meta = await api.provider.get();
        return {
          baseUrl: found.data.baseUrl,
          modelCount: models.length,
          chosen: first.id,
          configured: saved.data.configured,
          enabledCount: saved.data.enabledModels ? saved.data.enabledModels.length : 0,
          reply: sent && sent.ok ? sent.data.text : null,
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
    providerMethods: probe.providerMethods.length === 7,
    workspaceApi: probe.workspaceMethods.length === 8,
    dialogApi: probe.dialogMethods.length === 2,
    connectorApi: probe.connectorMethods.length === 10,
    mcpApi: probe.mcpMethods.length === 5,
    providerGetOk: probe.providerGetOk,
    providerConfiguredFalse: probe.providerConfigured,
    cancelOk: probe.cancelOk,
    taskSeeded: probe.taskCount === '1',
    versionLoaded: probe.version === '1.0.0',
    chatInputEnabled: probe.chatInputDisabled === false,
    sendEnabledAfterTyping: probe.sendDisabledAfterTyping === false,
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
