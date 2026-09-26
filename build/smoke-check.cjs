'use strict';

// Development-only boot check driven by SCALEMAX_SMOKE=1 (see main.js).
// Verifies the renderer ES-module graph links and the provider IPC bridge works.
// Excluded from packaged builds (electron-builder `files` omits test/).

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal OpenAI-compatible stub on loopback, reachable from the provider.
async function startStubServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'smoke-model', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
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
      const reserved = { provider: 'bridge-missing', connectors: 'bridge-missing', user: 'bridge-missing' };
      if (api.store && api.store.get) {
        for (const key of ['provider', 'connectors', 'user']) {
          reserved[key] = await api.store.get(key);
        }
      }
      const input = document.querySelector('#chat-input');
      if (input) { input.value = 'hello'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      return {
        hasBridge: Boolean(api.store && api.provider && api.connectors),
        reservedHidden: reserved.provider === undefined && reserved.connectors === undefined && reserved.user === undefined,
        providerMethods: ['get','save','test','discover','send','cancel','clear'].filter((m) => typeof api.provider?.[m] === 'function'),
        workspaceMethods: ['select','list','read','write','gitStatus','gitDiff','run','cancel'].filter((m) => typeof api.workspace?.[m] === 'function'),
        dialogMethods: ['openFolder','openFile'].filter((m) => typeof api.dialog?.[m] === 'function'),
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
      await api.provider.clear();
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
      return {
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
    automationCreated: Boolean(automation && automation.count >= 1 && automation.schedule === 'weekly'
      && automation.dayOfWeek === 3 && automation.schemaVersion === 2 && automation.hasNextRun && automation.rendered >= 1),
    noConsoleErrors: errors.length === 0,
    workspaceRoot: Boolean(workspace && workspace.root),
    workspaceListsFile: Boolean(workspace && Array.isArray(workspace.names) && workspace.names.includes('hello.txt')),
    workspaceRead: Boolean(workspace && workspace.before === 'hello world'),
    workspaceWrite: Boolean(workspace && workspace.wrote && workspace.after === 'updated content'),
    workspaceTerminal: Boolean(workspace && workspace.terminalOk && workspace.terminalExit === 0),
    ...(liveKey ? {
      liveDiscoverBase: Boolean(live && live.baseUrl === 'https://api.scalemax.pro/token/v1'),
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
