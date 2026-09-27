'use strict';

// The ScaleMax API rewrites the whole word "kiro" (any case; letters and digits end a word,
// "-", ".", "/" and "_" do not) in reply text into the model's name, so a folder called
// "kiro-scalemax-ide" came back as "DeepSeek V4 Flash-scalemax-ide". Requests and tool-call
// arguments are not changed, so the model knows the real names; only what it writes back is.
// This puts back names the model was actually given in this request (folder name, paths in tool
// results, words in the user's messages). A name that is only the bare word stays as the API
// wrote it, because it cannot be told apart from the model naming itself.

const REWRITTEN_WORD = /(?<![A-Za-z0-9])kiro(?![A-Za-z0-9])/gi;
const TOKEN_SPLIT = /[\s"'`()<>[\]{},;|*:!?]+/;
const MAX_NAME_CHARS = 256;
const MAX_NAMES = 2000;
const MAX_SCAN_CHARS = 2 * 1024 * 1024;

function rewritable(text) {
  REWRITTEN_WORD.lastIndex = 0;
  const found = REWRITTEN_WORD.test(text);
  REWRITTEN_WORD.lastIndex = 0;
  return found;
}

/** Names from the texts sent to the model that the API would rewrite in a reply. */
function collectNames(texts, extraNames = []) {
  const names = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const name = value.trim().replace(/[.]+$/, '');
    // The bare word alone is indistinguishable from the model naming itself.
    if (/^kiro$/i.test(name)) return;
    if (name && name.length <= MAX_NAME_CHARS && names.size < MAX_NAMES && rewritable(name)) names.add(name);
  };
  for (const name of extraNames) add(name);
  let scanned = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || !rewritable(text)) continue;
    const slice = text.slice(0, Math.max(0, MAX_SCAN_CHARS - scanned));
    scanned += slice.length;
    for (const token of slice.split(TOKEN_SPLIT)) {
      add(token);
      // "kiro-app/src/index.js" also restores "kiro-app" and "kiro-app/src" on their own.
      const parts = token.split('/');
      for (let i = 1; i < parts.length; i += 1) add(parts.slice(0, i).join('/'));
      for (const part of parts) add(part);
    }
    if (scanned >= MAX_SCAN_CHARS) break;
  }
  return [...names];
}

/** Puts the given names back into text where the API replaced their "kiro" with a model name. */
function restoreNames(text, { names = [], replacements = [] } = {}) {
  if (typeof text !== 'string' || !text || !names.length) return text;
  const substitutes = [...new Set(replacements.filter((value) => typeof value === 'string' && value.trim()))];
  if (!substitutes.length) return text;
  let result = text;
  // Longest first, so "kiro-app/src" is restored before "kiro-app".
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    for (const substitute of substitutes) {
      const rewritten = name.replace(REWRITTEN_WORD, () => substitute);
      REWRITTEN_WORD.lastIndex = 0;
      if (rewritten === name || rewritten === substitute) continue;
      if (result.includes(rewritten)) result = result.split(rewritten).join(name);
    }
  }
  return result;
}

/** The names a reply may use in place of "kiro": display name, id, and id without "[...]". */
function modelNames({ modelId, displayName, responseModel } = {}) {
  const values = [displayName, modelId, responseModel];
  for (const id of [modelId, responseModel]) {
    if (typeof id === 'string') values.push(id.replace(/\[[^\]]*\]$/, ''));
  }
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

module.exports = { collectNames, restoreNames, modelNames, rewritable };
