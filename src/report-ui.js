// Bug reports (lib/bug-report.cjs through the bridge's `report`): the Report a bug card in
// Preferences & about, its dialog, /bug in the message box (src/slash-ui.js) and the Report a bug
// entry in search (src/domain.mjs searchItems). A report is the person's message; main adds the
// app's version and the system and sends nothing else. DOM by createElement / textContent only.

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 2000;

/** The search entry: src/app.js renderSearch passes it to searchItems while reports are on. */
export const REPORT_ACTION = Object.freeze({
  id: 'report-bug',
  title: 'Report a bug',
  description: 'Tell the developer about a problem',
  keywords: Object.freeze(['bug', 'report', 'feedback', 'problem']),
});

/** True when the text, trimmed, has 10–2,000 characters. */
export function canSend(text) {
  const length = String(text ?? '').trim().length;
  return length >= MIN_LENGTH && length <= MAX_LENGTH;
}

/** "after 3:40 PM", or "tomorrow after 8:05 AM" when that isn't today (local time). */
export function laterText(resetAt, now = new Date(), locale = undefined) {
  const at = new Date(resetAt);
  // ICU puts a narrow no-break space before AM/PM; the sentence reads the same with a space.
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');
  return at.toDateString() === now.toDateString() ? `after ${time}` : `tomorrow after ${time}`;
}

/** What the person is told after report.send() answered: the toast when sent, else the dialog's line. */
export function outcomeText(outcome, now = new Date(), locale = undefined) {
  if (outcome?.sent) {
    const left = Number(outcome.remaining) || 0;
    return left > 0 ? `Report sent. Thank you. You can send ${left} more today.` : 'Report sent. Thank you. That was your last one for today.';
  }
  const until = (lead) => (typeof outcome?.resetAt === 'string' && Number.isFinite(Date.parse(outcome.resetAt))
    ? `${lead} You can send another ${laterText(outcome.resetAt, now, locale)}.`
    : `${lead} Please try again tomorrow.`);
  switch (outcome?.code) {
    case 'LIMIT': return until("You've sent 3 reports today.");
    case 'NETWORK_LIMIT': return until('Too many reports came from your network today.');
    case 'BUSY': return 'Reports are paused for today. Please try again tomorrow.';
    case 'UNAVAILABLE': return "Bug reports aren't available in this version.";
    case 'REPORT_ERROR': return 'The report could not be sent.';
    case 'INVALID': return 'Write at least 10 characters, and at most 2,000.';
    default: return "The report wasn't sent. Check your connection and try again.";
  }
}

/**
 * What report.send() answered, as an outcome for outcomeText: main's data when it sent or refused,
 * REPORT_ERROR when main itself failed (it could not read or keep the install ID: not a connection
 * problem, and its message, which can hold a file path, is never shown), else no connection.
 */
export function outcomeFromResult(result) {
  if (result?.ok === true && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) return result.data;
  if (result?.ok === false) return { sent: false, code: 'REPORT_ERROR' };
  return { sent: false, code: 'NETWORK' };
}

/** "macOS 15.1, arm64" from main's "macOS 15.1 (arm64)", for the card's sentence. */
export function systemText(osLabel) {
  return String(osLabel || '').replace(' (', ', ').replace(/\)$/, '');
}

const $ = (selector) => document.querySelector(selector);
const state = { app: null, info: { available: false, osLabel: '' }, bound: false, sending: false };

/** Whether this build sends reports (main's REPORT_URL is set). */
export function reportAvailable() {
  return state.info.available === true;
}

function setError(text) {
  const node = $('#report-error');
  if (!node) return;
  node.textContent = text;
  node.hidden = !text;
}

function renderForm() {
  const input = $('#report-message');
  const count = $('#report-count');
  if (count) count.textContent = `${(input?.value.length || 0).toLocaleString('en-US')} / 2,000`;
  const send = $('#report-send');
  if (send) {
    send.disabled = state.sending || !canSend(input?.value);
    send.textContent = state.sending ? 'Sending…' : 'Send report';
  }
  if (input) input.disabled = state.sending;
  // Cancel would not stop the request: the answer belongs in the dialog the person is looking at.
  const cancel = $('#report-cancel');
  if (cancel) cancel.disabled = state.sending;
}

function renderCard() {
  const card = $('#report-card');
  if (card) card.hidden = !reportAvailable();
  const description = $('#report-desc');
  if (description && state.info.osLabel) {
    description.textContent = `Something not working? Tell the developer. ScaleMax sends your message, the app's version and your system (${systemText(state.info.osLabel)}), nothing else: no files, chats or keys. Up to 3 reports a day.`;
  }
}

/**
 * Opens the dialog. `text` (/bug some words) replaces what is in the box; without it the box keeps
 * what the person had typed. Reports off: says so instead.
 */
export function openReportDialog(text = '') {
  if (!reportAvailable()) {
    state.app?.showToast?.(outcomeText({ sent: false, code: 'UNAVAILABLE' }));
    return;
  }
  const dialog = $('#report-dialog');
  const input = $('#report-message');
  if (!dialog || !input) return;
  if (typeof text === 'string' && text && !state.sending) input.value = text.slice(0, MAX_LENGTH);
  setError('');
  renderForm();
  if (!dialog.open) dialog.showModal();
  input.focus();
}

async function send() {
  const input = $('#report-message');
  if (!input || state.sending || !canSend(input.value)) return;
  state.sending = true;
  setError('');
  renderForm();
  let outcome;
  try {
    outcome = outcomeFromResult(await window.scalemaxAPI?.report?.send?.(input.value));
  } catch {
    outcome = { sent: false, code: 'NETWORK' };
  }
  state.sending = false;
  renderForm();
  if (outcome.sent) {
    input.value = '';
    $('#report-dialog')?.close();
    state.app?.showToast?.(outcomeText(outcome));
    return;
  }
  // The text stays in the box, so nothing typed is lost.
  setError(outcomeText(outcome));
  input.focus();
}

export function bindReportUi(app) {
  state.app = app;
  if (state.bound) return;
  state.bound = true;
  $('#report-open')?.addEventListener('click', () => openReportDialog());
  $('#report-message')?.addEventListener('input', () => renderForm());
  $('#report-send')?.addEventListener('click', () => send());
  $('#report-cancel')?.addEventListener('click', () => $('#report-dialog')?.close());
  // Escape while a report is sent would close the dialog on an answer nobody sees: wait for it.
  $('#report-dialog')?.addEventListener('cancel', (event) => { if (state.sending) event.preventDefault(); });
  renderCard();
  window.scalemaxAPI?.report?.get?.().then((result) => {
    if (!result?.ok) return;
    state.info = { available: result.data?.available === true, osLabel: String(result.data?.osLabel || '') };
    renderCard();
  }).catch(() => {});
}
