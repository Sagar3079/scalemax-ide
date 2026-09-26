const $ = (selector) => document.querySelector(selector);

/**
 * Wires the Command console to the workspace bridge. Command output is always
 * written with textContent, never innerHTML, so results are never interpreted
 * as markup.
 * @param {{showToast: (message: string) => void}} app
 */
export function bindTerminal(app) {
  const form = $('#terminal-form');
  const input = $('#terminal-command');
  const runButton = $('#terminal-run');
  const cancelButton = $('#terminal-cancel');
  const output = $('#terminal-output');
  if (!form || !input || !runButton || !cancelButton || !output) return;

  let running = false;
  const bridge = () => window.scalemaxAPI?.workspace || null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const command = input.value.trim();
    if (!command || running) return;
    const workspace = bridge();
    if (!workspace?.run) { app.showToast('Commands require the desktop app'); return; }

    running = true;
    runButton.disabled = true;
    output.textContent = 'Running…';
    try {
      const result = await workspace.run({ command });
      if (!result?.ok) {
        const message = result?.error?.message || 'Command failed';
        output.textContent = message;
        app.showToast(message);
        return;
      }
      const data = result.data || {};
      const lines = [data.stdout || ''];
      if (data.stderr) lines.push(data.stderr);
      lines.push(`[exit code ${data.exitCode}]`);
      output.textContent = lines.filter((line) => line !== '').join('\n');
      input.value = '';
    } catch (error) {
      const message = error?.message || 'Command failed';
      output.textContent = message;
      app.showToast(message);
    } finally {
      running = false;
      runButton.disabled = false;
    }
  });

  cancelButton.addEventListener('click', async (event) => {
    event.preventDefault();
    const workspace = bridge();
    if (!workspace?.cancel) { app.showToast('Commands require the desktop app'); return; }
    const result = await workspace.cancel();
    if (!result?.ok) { app.showToast(result?.error?.message || 'Command could not be cancelled'); return; }
    app.showToast(result.data ? 'Command cancelled' : 'No command is running');
  });
}
