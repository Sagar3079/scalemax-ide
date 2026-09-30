'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebTools, LIMITS, pageText, pageLinks, pageTitle, parseResults, publicUrl, privateAddress, decodeEntities } = require('../lib/web-tools.cjs');

const RESULT_PAGE = `<!doctype html><html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs%2Flatest%2Fapi%2Fsafe%2Dstorage&amp;rut=abc">safeStorage | <b>Electron</b></a>
  <a class="result__snippet">Encrypt and decrypt <b>strings</b> for storage on this machine.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://example.com/plain">Plain result</a>
  <a class="result__snippet">Second snippet &amp; more.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs%2Flatest%2Fapi%2Fsafe%2Dstorage">A duplicate address</a>
</div>
<div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
</body></html>`;

// A page with everything that must not reach the model as markup.
const ARTICLE = `<!doctype html><html><head><title>  Cache &amp; storage  </title>
<style>body{color:red}</style><script>alert('x')</script></head>
<body><nav><a href="/">Home</a></nav>
<h1>Keychain notes</h1><p>First paragraph with <b>bold</b> and <code>code</code>.</p>
<ul><li>One</li><li>Two</li></ul>
<p>Line one<br>line two</p>
<!-- a comment -->
<p>See <a href="/docs/api">the API docs</a> and <a href="https://other.example/x#frag">another site</a>.</p>
<a href="mailto:me@example.com">mail</a><a href="https://other.example/x">another site</a>
<script>var a = 1;</script></body></html>`;

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method, headers: options?.headers, redirect: options?.redirect });
      const route = typeof routes === 'function' ? routes(url, calls.length) : routes[url];
      if (!route) throw new Error(`no route for ${url}`);
      if (route.throws) throw Object.assign(new Error(route.throws), route.name ? { name: route.name } : {});
      return {
        ok: (route.status ?? 200) < 400,
        status: route.status ?? 200,
        url,
        headers: { get: (name) => (route.headers || {})[name.toLowerCase()] ?? (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
        text: async () => route.body ?? '',
      };
    },
  };
}

const tools = (routes) => {
  const fake = fakeFetch(routes);
  return { fake, web: createWebTools({ fetchImpl: fake.fetchImpl, lookup: async () => [{ address: '93.184.216.34' }] }) };
};

test('two read-only tools are always offered', () => {
  const { web } = tools({});
  assert.deepEqual(web.definitions().map((definition) => definition.function.name), ['web_search', 'web_open']);
  assert.equal(web.family, 'web');
  assert.deepEqual(web.resolve('web_search'), { serverId: 'Web', toolName: 'search', readOnly: true });
  const { egressUrl, ...opened } = web.resolve('web_open');
  assert.deepEqual(opened, { serverId: 'Web', toolName: 'open_page', readOnly: true });
  assert.equal(typeof egressUrl, 'function');
  assert.equal(web.resolve('workspace_read'), null);
  for (const definition of web.definitions()) {
    assert.match(definition.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(definition.function.parameters.type, 'object');
    assert.ok(definition.function.description.length <= 1024);
  }
});

test('search results are parsed, unwrapped and deduplicated', () => {
  const results = parseResults(RESULT_PAGE);
  assert.deepEqual(results, [
    { title: 'safeStorage | Electron', url: 'https://www.electronjs.org/docs/latest/api/safe-storage', snippet: 'Encrypt and decrypt strings for storage on this machine.' },
    { title: 'Plain result', url: 'https://example.com/plain', snippet: 'Second snippet & more.' },
  ]);
});

test('search returns a numbered list and asks for the query', async () => {
  const { fake, web } = tools({ [`https://html.duckduckgo.com/html/?q=${encodeURIComponent('safeStorage keychain')}`]: { body: RESULT_PAGE } });
  const { text } = await web.call('search', { query: '  safeStorage keychain  ' });
  assert.match(text, /^Search results for "safeStorage keychain":/);
  assert.match(text, /1\. safeStorage \| Electron\n {3}https:\/\/www\.electronjs\.org\/docs\/latest\/api\/safe-storage\n {3}Encrypt and decrypt strings/);
  assert.match(text, /2\. Plain result/);
  assert.match(text, /Open the useful ones with web_open/);
  assert.match(fake.calls[0].headers['user-agent'], /Mozilla/);
  await assert.rejects(web.call('search', { query: '   ' }), /"query" must say what to search for/);
  await assert.rejects(web.call('search', { query: 'x'.repeat(401) }), /at most 400 characters/);
});

test('search falls back to the plain endpoint, then says there was nothing', async () => {
  const query = encodeURIComponent('quiet');
  const { web } = tools({
    [`https://html.duckduckgo.com/html/?q=${query}`]: { body: '<html><body>anomaly</body></html>' },
    [`https://lite.duckduckgo.com/lite/?q=${query}`]: { body: '<a class="result-link" href="https://example.com/lite">Lite result</a><td class="result-snippet">From lite</td>' },
  });
  assert.match((await web.call('search', { query: 'quiet' })).text, /1\. Lite result\n {3}https:\/\/example\.com\/lite\n {3}From lite/);
  const { web: empty } = tools(() => ({ body: '<html><body>nothing here</body></html>' }));
  await assert.rejects(empty.call('search', { query: 'quiet' }), { code: 'NO_RESULTS' });
});

test('a page is read as text with its title, its links and no markup', async () => {
  const { web } = tools({ 'https://docs.example.com/notes': { body: ARTICLE } });
  const { text } = await web.call('open_page', { url: 'https://docs.example.com/notes' });
  assert.match(text, /^Cache & storage\nhttps:\/\/docs\.example\.com\/notes\n\n/);
  assert.match(text, /# Keychain notes/);
  assert.match(text, /First paragraph with bold and code\./);
  assert.match(text, /- One\n- Two/);
  assert.match(text, /Line one\nline two/);
  assert.ok(!/<[a-z]/i.test(text), 'no tags reach the model');
  assert.ok(!text.includes('alert(') && !text.includes('color:red') && !text.includes('a comment'));
  assert.match(text, /Links on this page:\n- Home: https:\/\/docs\.example\.com\/\n- the API docs: https:\/\/docs\.example\.com\/docs\/api\n- another site: https:\/\/other\.example\/x/);
  assert.match(text, /mail another site/, 'neighbouring link texts keep a space');
  assert.ok(!text.includes('mailto:'), 'only web links are listed');
  assert.equal(text.match(/another site: https/g).length, 1, 'links are deduplicated');
});

test('long pages come in parts', async () => {
  const body = `<html><title>Long</title><body><p>${'word '.repeat(20000)}</p></body></html>`;
  const { web } = tools({ 'https://example.com/long': { body } });
  const first = (await web.call('open_page', { url: 'https://example.com/long' })).text;
  assert.match(first, /Part 1 of 3/);
  assert.match(first, /\[more: call web_open with part 2\]/);
  const second = (await web.call('open_page', { url: 'https://example.com/long', part: 2 })).text;
  assert.match(second, /Part 2 of 3/);
  assert.ok(!second.includes('Links on this page'), 'links are listed once');
  assert.match((await web.call('open_page', { url: 'https://example.com/long', part: 9 })).text, /has only 3 parts/);
});

test('JSON answers are passed through as they are', async () => {
  const { web } = tools({ 'https://api.example.com/v1/items': { body: '{"items":[1,2,3]}', headers: { 'content-type': 'application/json' } } });
  const { text } = await web.call('open_page', { url: 'https://api.example.com/v1/items' });
  assert.match(text, /https:\/\/api\.example\.com\/v1\/items\n\n\{"items":\[1,2,3\]\}$/);
});

test('redirects are followed by hand and re-checked', async () => {
  const { fake, web } = tools({
    'https://example.com/a': { status: 301, headers: { location: '/b' } },
    'https://example.com/b': { status: 302, headers: { location: 'https://final.example/c' } },
    'https://final.example/c': { body: '<title>Final</title><p>Arrived.</p>' },
  });
  const { text } = await web.call('open_page', { url: 'https://example.com/a' });
  assert.match(text, /Final\nhttps:\/\/final\.example\/c/);
  assert.match(text, /Arrived\./);
  assert.deepEqual(fake.calls.map((call) => call.redirect), ['manual', 'manual', 'manual']);
  const loop = tools((url) => ({ status: 302, headers: { location: `${url}x` } }));
  await assert.rejects(loop.web.call('open_page', { url: 'https://example.com/loop' }), { code: 'TOO_MANY_REDIRECTS' });
});

test('private, local and non-web addresses are refused', async () => {
  const { web, fake } = tools({});
  for (const [url, code] of [
    ['file:///etc/passwd', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['https://user:pass@example.com/', 'INVALID_URL'],
    ['http://localhost:3000/', 'PRIVATE_ADDRESS'],
    ['http://printer.local/', 'PRIVATE_ADDRESS'],
    ['http://127.0.0.1/', 'PRIVATE_ADDRESS'],
    ['http://10.0.0.5/admin', 'PRIVATE_ADDRESS'],
    ['http://169.254.169.254/latest/meta-data/', 'PRIVATE_ADDRESS'],
    ['http://[::1]/', 'PRIVATE_ADDRESS'],
  ]) {
    await assert.rejects(web.call('open_page', { url }), (error) => {
      assert.equal(error.code, code, url);
      return true;
    });
  }
  assert.equal(fake.calls.length, 0, 'nothing is fetched');
  // A name that resolves into the private range is refused too.
  const sneaky = createWebTools({ fetchImpl: fakeFetch({}).fetchImpl, lookup: async () => [{ address: '192.168.1.1' }] });
  await assert.rejects(sneaky.call('open_page', { url: 'https://sneaky.example/' }), { code: 'PRIVATE_ADDRESS' });
  // A redirect into the private range is refused as well.
  const redirect = tools({ 'https://example.com/r': { status: 302, headers: { location: 'http://127.0.0.1:8080/' } } });
  await assert.rejects(redirect.web.call('open_page', { url: 'https://example.com/r' }), { code: 'PRIVATE_ADDRESS' });
});

test('privateAddress knows the reserved ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(privateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(privateAddress(address), false, address);
  }
});

test('privateAddress compares bytes, so no other spelling of a private address gets through', () => {
  // The URL parser writes [::ffff:127.0.0.1] as ::ffff:7f00:1: the same machine, and the cloud
  // metadata address the same way. Every form the review found open, and the rest of the reserved space.
  const hidden = [
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001', '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:0101::1', '2001::1', '2001:db8::1', 'fec0::1', 'ff02::1', '100::1', '::',
    '198.18.0.1', '198.19.255.255', '192.0.0.8', '192.0.2.1', '198.51.100.1', '203.0.113.9', '192.88.99.1', '240.0.0.1', '255.255.255.255',
    'fe80::1%en0', 'not-an-address',
  ];
  for (const address of hidden) assert.equal(privateAddress(address), true, address);
  // Public space stays public, including public IPv4 behind NAT64 and 6to4.
  for (const address of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:0808:0808::1', '2a00:1450:4001::200e', '1.1.1.1']) {
    assert.equal(privateAddress(address), false, address);
  }
});

test('the parsed forms of hidden local addresses are refused before anything is fetched', async () => {
  const { fake, web } = tools({});
  for (const url of ['http://[::ffff:127.0.0.1]:8080/', 'http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[fec0::1]/', 'http://198.18.0.1/', 'http://2130706433/', 'http://0177.0.0.1/']) {
    await assert.rejects(web.call('open_page', { url }), { code: 'PRIVATE_ADDRESS' }, url);
  }
  assert.equal(fake.calls.length, 0);
});

test('the connection uses the address the guard checked (no second lookup to rebind)', async () => {
  const { guardedLookup, pinnedFetch } = require('../lib/web-tools.cjs');
  // Both calling styles of net: one address, or all of them.
  const lookup = guardedLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  const one = await new Promise((resolve, reject) => lookup('example.com', { family: 0 }, (error, address, family) => (error ? reject(error) : resolve([address, family]))));
  assert.deepEqual(one, ['93.184.216.34', 4]);
  const all = await new Promise((resolve, reject) => lookup('example.com', { all: true }, (error, list) => (error ? reject(error) : resolve(list))));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
  // A name whose answer (any of them) is private fails inside the connection itself.
  const rebound = guardedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(new Promise((resolve, reject) => rebound('rebind.example', {}, (error) => (error ? reject(error) : resolve()))), { code: 'PRIVATE_ADDRESS' });

  const http = require('node:http');
  const zlib = require('node:zlib');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(zlib.gzipSync('<title>Local</title><p>compressed page</p>'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // A name that resolves to this machine: refused by the lookup the connection makes.
    await assert.rejects(pinnedFetch(`http://rebind.example:${port}/`, {}, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), { code: 'PRIVATE_ADDRESS' });
    // An address literal skips the lookup, and the socket it lands on is checked instead.
    await assert.rejects(pinnedFetch(`http://127.0.0.1:${port}/`), { code: 'PRIVATE_ADDRESS' });
    // With the check switched off (tests only), the page arrives decompressed.
    const response = await pinnedFetch(`http://local.test:${port}/`, {}, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], isPrivate: () => false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.match(Buffer.concat(chunks).toString('utf8'), /compressed page/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a compressed page that is abandoned part way closes its connection', async () => {
  const { pinnedFetch } = require('../lib/web-tools.cjs');
  const http = require('node:http');
  const zlib = require('node:zlib');
  let closed = false;
  const server = http.createServer((request, response) => {
    request.socket.on('close', () => { closed = true; });
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    const gzip = zlib.createGzip();
    gzip.pipe(response);
    // Keeps sending until the client goes away.
    const timer = setInterval(() => gzip.write('x'.repeat(64 * 1024)), 5);
    request.socket.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await pinnedFetch(`http://local.test:${port}/`, {}, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], isPrivate: () => false });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    for (let waited = 0; waited < 2000 && !closed; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, true, 'the socket closed, not only the decoder');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('web_open names the address it will send to, and the search does not', () => {
  const { web } = tools({});
  assert.equal(web.resolve('web_open').egressUrl({ url: 'https://example.com/x' }), 'https://example.com/x');
  assert.equal(web.resolve('web_search').egressUrl, undefined);
});

test('failures explain themselves', async () => {
  const cases = [
    [{ status: 404 }, 'NOT_FOUND'],
    [{ status: 403 }, 'FORBIDDEN'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [{ status: 500 }, 'HTTP_ERROR'],
    [{ headers: { 'content-type': 'image/png' }, body: '' }, 'NOT_TEXT'],
    [{ throws: 'aborted', name: 'AbortError' }, 'FETCH_FAILED'],
    [{ throws: 'socket hang up' }, 'FETCH_FAILED'],
  ];
  for (const [route, code] of cases) {
    const { web } = tools({ 'https://example.com/x': route });
    await assert.rejects(web.call('open_page', { url: 'https://example.com/x' }), (error) => {
      assert.equal(error.code, code, JSON.stringify(route));
      assert.ok(!/undefined/.test(error.message), error.message);
      return true;
    });
  }
  const { web } = tools({});
  await assert.rejects(web.call('open_page', {}), /"url" must be a full web address/);
  await assert.rejects(web.call('nope', {}), /Unknown web tool/);
});

test('helpers: entities, titles and text', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;&unknown;'), 'a & b <c> A B  &unknown;');
  assert.equal(pageTitle('<title>  Hi &amp; bye  </title>'), 'Hi & bye');
  assert.equal(pageTitle('<html><body>no title</body></html>'), '');
  assert.equal(pageText('<p>a</p><p>b</p>'), 'a\nb');
  assert.deepEqual(pageLinks('<a href="/a">A</a><a href="">empty</a><a href="#x">hash</a>', 'https://e.com/dir/page'), [{ url: 'https://e.com/a', label: 'A' }]);
  assert.ok(LIMITS.pageChars >= 10000 && LIMITS.bytes >= 1024 * 1024);
});

test('publicUrl returns the parsed address', async () => {
  const url = await publicUrl('https://Example.com/Path?q=1#frag', { lookup: async () => [{ address: '1.2.3.4' }] });
  assert.equal(url.host, 'example.com');
  assert.equal(url.pathname, '/Path');
  await assert.rejects(publicUrl('https://nx.example/', { lookup: async () => { throw new Error('ENOTFOUND'); } }), { code: 'DNS' });
});
