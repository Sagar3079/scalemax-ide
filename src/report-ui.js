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
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ');
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
    case 'INVALID': return 'Write at least 10 characters, and at most 2,000.';
    default: return "The report wasn't sent. Check your connection and try again.";
  }
}

/** "macOS 15.1, arm64" from main's "macOS 15.1 (arm64)", for the card's sentence. */
export function systemText(osLabel) {
  return String(osLabel || '').replace(' (', ', ').replace(/\)$/, '');
}
