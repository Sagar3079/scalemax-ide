'use strict';
// Forwards what a chat reply is doing (the progress events of lib/tool-loop.cjs) to the window.
// A streamed reply arrives in many small pieces; they are gathered and sent at most every 40 ms,
// so a fast model does not flood the window with messages. Text is repaired before it is shown
// (lib/reply-names.cjs); when a repair changes text the window already has, the whole text of
// the round is sent again (`text-set`) instead of the new piece. Command output is gathered the
// same way, per tool call.
//
// Events sent: every tool-loop event unchanged, except
//   { phase: 'delta', kind, text }     new text for the current round ('text' or 'reasoning')
//   { phase: 'text-set', kind, text }  the whole text of the current round, replacing what was sent
//   { phase: 'tool-output', callId, text }  output gathered since the last send
const DEFAULT_INTERVAL_MS = 40;
// Mirrors the provider's limit on one reply.
const MAX_ROUND_TEXT_BYTES = 4 * 1024 * 1024;
// Output kept between two sends for one call (the end, where errors and summaries are).
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024;
const KINDS = ['reasoning', 'text'];

function tailBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/**
 * @param {object} options
 * @param {(event: object) => void} options.send delivers one event to the window
 * @param {(text: string) => string} [options.restore] repairs reply text before it is shown
 * @param {number} [options.intervalMs] how long pieces are gathered (40 ms)
 */
function createProgressForwarder({ send, restore = null, intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required.');
  let requestId;
  let timer = null;
  let closed = false;
  let preparing = '';
  // raw: the round's text as the model wrote it; sent: what the window has; doneRaw / doneFixed:
  // the finished lines, repaired once.
  const fresh = () => ({ raw: '', bytes: 0, sent: '', dirty: false, doneRaw: 0, doneFixed: '' });
  const rounds = { text: fresh(), reasoning: fresh() };
  const outputs = new Map();
  const emit = (event) => {
    try { send(event); } catch { /* the window may be gone */ }
  };
  const repair = (text) => {
    if (typeof restore !== 'function' || !text) return text;
    try {
      const fixed = restore(text);
      return typeof fixed === 'string' ? fixed : text;
    } catch {
      return text;
    }
  };
  // Names and the model names the API puts in their place never contain a line break, so a
  // finished line never changes again: only the line being written is repaired on every send.
  const repairRound = (round) => {
    if (typeof restore !== 'function') return round.raw;
    const cut = round.raw.lastIndexOf('\n') + 1;
    if (cut > round.doneRaw) {
      round.doneFixed += repair(round.raw.slice(round.doneRaw, cut));
      round.doneRaw = cut;
    }
    return round.doneFixed + repair(round.raw.slice(round.doneRaw));
  };
  function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    for (const kind of KINDS) {
      const round = rounds[kind];
      if (!round.dirty) continue;
      round.dirty = false;
      const shown = repairRound(round);
      if (shown === round.sent) continue;
      if (shown.startsWith(round.sent)) emit({ requestId, phase: 'delta', kind, text: shown.slice(round.sent.length) });
      else emit({ requestId, phase: 'text-set', kind, text: shown });
      round.sent = shown;
    }
    for (const [callId, text] of outputs) emit({ requestId, phase: 'tool-output', callId, text });
    outputs.clear();
  }
  function schedule() {
    if (timer !== null || closed) return;
    timer = setTimer(flush, intervalMs);
    timer?.unref?.();
  }
  /** Takes one tool-loop progress event. */
  function push(event) {
    if (closed || !event || typeof event !== 'object') return;
    if (typeof event.requestId === 'string') requestId = event.requestId;
    if (event.phase === 'delta') {
      const round = rounds[event.kind];
      if (!round || typeof event.text !== 'string' || !event.text) return;
      const bytes = Buffer.byteLength(event.text);
      if (round.bytes + bytes > MAX_ROUND_TEXT_BYTES) return;
      round.raw += event.text;
      round.bytes += bytes;
      round.dirty = true;
      schedule();
      return;
    }
    if (event.phase === 'tool-output') {
      if (typeof event.callId !== 'string' || typeof event.text !== 'string' || !event.text) return;
      outputs.set(event.callId, tailBytes((outputs.get(event.callId) || '') + event.text, MAX_PENDING_OUTPUT_BYTES));
      schedule();
      return;
    }
    // The model writes a tool call in many pieces; saying so once is enough.
    if (event.phase === 'preparing') {
      const key = `${event.serverId}\u0000${event.toolName}`;
      if (key === preparing) return;
      preparing = key;
    }
    // Everything else keeps its place after the text and output before it.
    flush();
    // The provider failed part way and the round is asked again: what it showed so far is
    // replaced by nothing (text-set ''), and the new attempt streams into the same block.
    if (event.phase === 'retry') {
      for (const kind of KINDS) {
        const round = rounds[kind];
        const shown = round.sent;
        rounds[kind] = fresh();
        if (shown) emit({ requestId, phase: 'text-set', kind, text: '' });
      }
      preparing = '';
      emit(event);
      return;
    }
    if (event.phase === 'thinking') {
      rounds.text = fresh();
      rounds.reasoning = fresh();
      preparing = '';
    }
    emit(event);
  }
  /** Sends what is still gathered; later events are dropped. */
  function close() {
    if (closed) return;
    flush();
    closed = true;
  }
  return { push, flush, close };
}

module.exports = { createProgressForwarder, DEFAULT_INTERVAL_MS };
