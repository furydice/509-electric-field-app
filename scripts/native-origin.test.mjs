import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const IOS_SOURCE_PATH = path.join(ROOT, 'scripts', 'prepare-ios-local.sh');
const ANDROID_SOURCE_PATH = path.join(ROOT, 'codemagic.yaml');
const CF_ID = 'synthetic-cf-id';
const CF_SECRET = 'synthetic-cf-secret';
const GATED_HOST = 'automation.509electric.com';
const ID_HEADER = 'CF-Access-Client-Id';
const SECRET_HEADER = 'CF-Access-Client-Secret';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function sourceHash(file) {
  return crypto.createHash('sha256').update(read(file)).digest('hex');
}

function extractIosShim() {
  const source = read(IOS_SOURCE_PATH);
  const match = source.match(/let js = #?"""\s*([\s\S]*?)\s*"""#?/);
  assert.ok(match, 'the iOS preparation script must contain the canonical JS triple-quoted shim');
  return match[1]
    .replace(/\\#?\(self\.cfId\)/g, CF_ID)
    .replace(/\\#?\(self\.cfSec\)/g, CF_SECRET);
}

function extractIosCodemagicShim() {
  const source = read(ANDROID_SOURCE_PATH);
  const match = source.match(/let js = #?"""\s*([\s\S]*?)\s*"""#?/);
  assert.ok(match, 'codemagic must contain the canonical iOS JS triple-quoted shim');
  return match[1]
    .replace(/\\#?\(self\.cfId\)/g, CF_ID)
    .replace(/\\#?\(self\.cfSec\)/g, CF_SECRET);
}

function extractAndroidShim() {
  const source = read(ANDROID_SOURCE_PATH);
  const buildStart = source.indexOf('static String build(String clientId, String clientSecret, String gatedHost)');
  assert.notEqual(buildStart, -1, 'codemagic must contain the canonical Android Java shim builder');
  const blockEnd = source.indexOf('private static String escape', buildStart);
  assert.notEqual(blockEnd, -1, 'Android shim builder must remain adjacent to its escaping helper');
  const block = source.slice(buildStart, blockEnd);
  const returnStart = block.indexOf('return ');
  const expressionEnd = block.lastIndexOf('";');
  assert.ok(returnStart >= 0 && expressionEnd > returnStart, 'Android builder return expression must be extractable');
  const expression = block.slice(returnStart + 'return '.length, expressionEnd + 1);
  // Java string literals and concatenation are intentionally evaluated as a
  // tiny synthetic expression. No generated native code or credentials are read.
  const escape = (value) => String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return new Function('clientId', 'clientSecret', 'gatedHost', 'escape', `return ${expression}`)(
    CF_ID,
    CF_SECRET,
    GATED_HOST,
    escape,
  );
}

const SHIMS = [
  ['iOS preparation canonical triple-quoted shim', extractIosShim],
  ['iOS Codemagic canonical triple-quoted shim', extractIosCodemagicShim],
  ['Android canonical Java-concatenated shim', extractAndroidShim],
];

function normalizeHeaders(value) {
  if (!value) return {};
  if (value instanceof Headers || typeof value.entries === 'function') return Object.fromEntries(value.entries());
  if (Array.isArray(value)) return Object.fromEntries(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), String(item)]));
}

function headerValue(headers, name) {
  return normalizeHeaders(headers)[name.toLowerCase()];
}

function imageContext(shimSource) {
  const calls = [];
  const originalSet = function (value) {
    this._src = value;
  };
  const originalGet = function () {
    return this._src || '';
  };
  class Element {
    setAttribute(name, value) {
      this._attributes ??= {};
      this._attributes[name] = String(value);
    }
  }
  class HTMLImageElement extends Element {
    addEventListener() {}
  }
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: originalGet,
    set: originalSet,
  });
  class URLShim extends URL {}
  let blobNumber = 0;
  URLShim.createObjectURL = () => `blob:synthetic-${++blobNumber}`;
  URLShim.revokeObjectURL = () => {};
  const BlobShim = class BlobShim {
    constructor(parts) { this.parts = parts; }
  };
  const window = {
    fetch(input, options) {
      const effectiveHeaders = options?.headers === undefined ? {} : normalizeHeaders(options.headers);
      calls.push({ input, options, effectiveHeaders });
      return Promise.resolve({ blob: async () => new BlobShim(['synthetic']) });
    },
  };
  vm.runInNewContext(shimSource, {
    window,
    Element,
    HTMLImageElement,
    Headers,
    URL: URLShim,
    Blob: BlobShim,
    document: { baseURI: `https://${GATED_HOST}/app/` },
    Promise,
    RegExp,
  }, { filename: 'extracted-native-origin-shim.js' });
  return { calls, HTMLImageElement };
}

function fetchContext(shimSource, baseURI = `https://${GATED_HOST}/app/`) {
  const calls = [];
  const baseFetch = async (input, options = {}) => {
    const request = input instanceof Request ? input : null;
    const effectiveHeaders = options.headers === undefined
      ? normalizeHeaders(request?.headers)
      : normalizeHeaders(options.headers);
    calls.push({ input, options, effectiveHeaders });
    return { blob: async () => new Blob(['synthetic']) };
  };
  const window = { fetch: baseFetch };
  vm.runInNewContext(shimSource, {
    window,
    Headers,
    Request,
    URL,
    document: { baseURI },
    Blob,
    Element: class Element {},
    HTMLImageElement: class HTMLImageElement {},
    Promise,
    RegExp,
  }, { filename: 'extracted-native-origin-shim.js' });
  return { fetch: window.fetch, calls };
}

function assertStamped(call, expected) {
  assert.equal(headerValue(call.effectiveHeaders, ID_HEADER), expected ? CF_ID : undefined);
  assert.equal(headerValue(call.effectiveHeaders, SECRET_HEADER), expected ? CF_SECRET : undefined);
}

for (const [label, extract] of SHIMS) {
  test(`${label} is executable from the checked-in canonical source`, () => {
    const shim = extract();
    assert.match(shim, /automation\.509electric\.com/);
    assert.match(shim, /window\.fetch/);
    assert.match(shim, /HTMLImageElement/);
  });

  test(`${label} gates exact HTTPS origin, default 443, and relative paths`, async () => {
    const context = fetchContext(extract());
    const cases = [
      [`https://${GATED_HOST}/api/jobs`, true],
      [`https://${GATED_HOST}:443/api/jobs`, true],
      [new URL(`https://${GATED_HOST}/api/url-object`), true],
      ['/api/jobs', true],
      ['../api/jobs', true],
      ['?query=1', true],
      [`HTTPS://${GATED_HOST.toUpperCase()}/api/jobs`, true],
      [`https://${GATED_HOST}:8443/api/jobs`, false],
      [`http://${GATED_HOST}/api/jobs`, false],
      [`//${GATED_HOST}/api/jobs`, true],
      ['//evil.test/api/jobs', false],
      ['https://evilautomation.509electric.com/api/jobs', false],
      ['https://automation.509electric.com.evil.test/api/jobs', false],
      ['https://evil.test/path/automation.509electric.com/api/jobs', false],
      ['https://evil.test/?next=https%3A%2F%2Fautomation.509electric.com%2Fapi', false],
      [`https://user@${GATED_HOST}/api/jobs`, false],
      [`https://@${GATED_HOST}/api/jobs`, false],
      [`https://${GATED_HOST}/bad path`, false],
      [`https://${GATED_HOST}/bad\\path`, false],
      [`https://${GATED_HOST}/%ZZ`, false],
      [`https://${GATED_HOST}/bad\u0001path`, false],
      ['data:text/plain,automation.509electric.com', false],
      ['blob:https://automation.509electric.com/decoy', false],
    ];
    for (const [url, expected] of cases) {
      await context.fetch(url);
      assertStamped(context.calls.at(-1), expected);
    }
    const hostileBase = fetchContext(extract(), 'https://evil.test/app/');
    await hostileBase.fetch('/api/jobs');
    assertStamped(hostileBase.calls.at(-1), false);
    await hostileBase.fetch('?query=1');
    assertStamped(hostileBase.calls.at(-1), false);
    await hostileBase.fetch(`https://${GATED_HOST}/api/jobs`);
    assertStamped(hostileBase.calls.at(-1), true);
  });

  test(`${label} preserves option and Request headers, body, and caller inputs`, async () => {
    const context = fetchContext(extract());
    const plain = { 'X-Trace': 'plain', 'Content-Type': 'application/json' };
    const plainSnapshot = { ...plain };
    const plainOptions = { method: 'POST', headers: plain, body: '{"ok":true}' };
    await context.fetch('/api/plain', plainOptions);
    let call = context.calls.at(-1);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.body, '{"ok":true}');
    assert.equal(headerValue(call.effectiveHeaders, 'x-trace'), 'plain');
    assert.equal(headerValue(call.effectiveHeaders, 'content-type'), 'application/json');
    assertStamped(call, true);
    assert.deepEqual(plain, plainSnapshot);
    assert.equal(plainOptions.headers, plain);
    assert.deepEqual(plainOptions, { method: 'POST', headers: plain, body: '{"ok":true}' });

    const headerObject = new Headers([['X-Trace', 'headers'], ['Content-Type', 'text/plain']]);
    const headersSnapshot = [...headerObject.entries()];
    await context.fetch('/api/headers', { method: 'POST', headers: headerObject, body: 'headers' });
    call = context.calls.at(-1);
    assert.equal(headerValue(call.effectiveHeaders, 'x-trace'), 'headers');
    assert.equal(headerValue(call.effectiveHeaders, 'content-type'), 'text/plain');
    assertStamped(call, true);
    assert.deepEqual([...headerObject.entries()], headersSnapshot);

    const tuples = [['X-Trace', 'tuples'], ['Content-Type', 'text/plain']];
    const tuplesSnapshot = tuples.map((entry) => [...entry]);
    await context.fetch('/api/tuples', { method: 'POST', headers: tuples, body: 'tuples' });
    call = context.calls.at(-1);
    assert.equal(headerValue(call.effectiveHeaders, 'x-trace'), 'tuples');
    assertStamped(call, true);
    assert.deepEqual(tuples, tuplesSnapshot);

    const request = new Request(`https://${GATED_HOST}/api/request`, {
      method: 'PUT',
      headers: { 'X-Trace': 'request', 'Content-Type': 'text/plain' },
      body: 'request-body',
    });
    const requestHeadersSnapshot = [...request.headers.entries()];
    await context.fetch(request, { credentials: 'same-origin' });
    call = context.calls.at(-1);
    assert.equal(call.input, request);
    assert.equal(call.input.method, 'PUT');
    assert.equal(headerValue(call.effectiveHeaders, 'x-trace'), 'request');
    assert.equal(headerValue(call.effectiveHeaders, 'content-type'), 'text/plain');
    assertStamped(call, true);
    assert.deepEqual([...request.headers.entries()], requestHeadersSnapshot);

    const requestOverride = new Request(`https://${GATED_HOST}/api/request-override`, {
      method: 'POST',
      headers: { 'X-Trace': 'request-original' },
      body: 'request-original-body',
    });
    await context.fetch(requestOverride, {
      method: 'PATCH',
      headers: { 'X-Trace': 'options-override', 'X-Option': 'kept' },
      body: 'options-body',
    });
    call = context.calls.at(-1);
    assert.equal(call.options.method, 'PATCH');
    assert.equal(call.options.body, 'options-body');
    assert.equal(headerValue(call.effectiveHeaders, 'x-trace'), 'options-override');
    assert.equal(headerValue(call.effectiveHeaders, 'x-option'), 'kept');
    assert.notEqual(headerValue(call.effectiveHeaders, 'x-trace'), 'request-original', 'explicit options headers must replace inherited Request headers');
    assertStamped(call, true);
  });

  test(`${label} prevents stamped credentials from following redirects`, async () => {
    const context = fetchContext(extract());
    for (const [redirect, expected] of [[undefined, 'error'], ['follow', 'error'], ['manual', 'manual'], ['error', 'error']]) {
      const options = redirect === undefined ? {} : { redirect };
      const optionsSnapshot = { ...options };
      await context.fetch('/api/redirect', options);
      const call = context.calls.at(-1);
      assert.equal(call.options.redirect, expected);
      assertStamped(call, true);
      assert.deepEqual(options, optionsSnapshot);
    }
  });

  test(`${label} applies the same origin policy to image fetches and preserves _k/blob/data gates`, async () => {
    const context = imageContext(extract());
    const image = new context.HTMLImageElement();
    image.src = `https://${GATED_HOST}/image.png`;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].input, `https://${GATED_HOST}/image.png`);
    assertStamped(context.calls[0], true);

    const noFetch = [
      `https://${GATED_HOST}/image.png?_k=already-stamped`,
      `https://evilautomation.509electric.com/image.png`,
      `https://evil.test/image.png?next=${GATED_HOST}`,
      '//evil.test/image.png',
      'blob:synthetic-image',
      'data:image/png;base64,synthetic',
    ];
    for (const url of noFetch) {
      image.src = url;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.calls.length, 1, `image decoy unexpectedly fetched: ${image.src}`);

    image.setAttribute('src', '/relative-image.png');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.calls.length, 2);
    assert.equal(context.calls[1].input, `https://${GATED_HOST}/relative-image.png`);
    assertStamped(context.calls[1], true);
  });
}

test('native navigation guards are source-faithful exact HTTPS predicates (static native check)', () => {
  const swift = read(IOS_SOURCE_PATH);
  const java = read(ANDROID_SOURCE_PATH);
  const swiftNavigationStart = swift.indexOf('func webView(_ webView:WKWebView');
  const swiftNavigationEnd = swift.indexOf('\nSWIFT', swiftNavigationStart);
  const swiftNavigation = swift.slice(swiftNavigationStart, swiftNavigationEnd);
  assert.doesNotMatch(swiftNavigation, /host\?\.contains\("509electric\.com"\)/);
  const swiftOriginHelper = swift.slice(swift.indexOf('private func isGatedOrigin'), swiftNavigationStart);
  assert.match(swiftOriginHelper, /automation\.509electric\.com/);
  assert.match(swiftOriginHelper, /https/i);
  assert.match(swiftOriginHelper, /parts\.user==nil/);
  assert.match(swiftOriginHelper, /parts\.password==nil/);
  assert.match(swiftOriginHelper, /parts\.port==nil.*parts\.port==443/s);
  assert.match(swiftNavigation, /isGatedOrigin\(/);
  const androidNavigation = java.slice(java.indexOf('public boolean shouldOverrideUrlLoading'));
  assert.doesNotMatch(androidNavigation, /contains\("509electric\.com"\)/);
  const androidOriginHelper = java.slice(java.indexOf('private boolean isGatedOrigin'), java.indexOf('private boolean isAccessLogin'));
  assert.match(androidOriginHelper, /automation\.509electric\.com/);
  assert.match(androidOriginHelper, /getScheme/);
  assert.match(androidOriginHelper, /getRawUserInfo|getUserInfo/);
  assert.match(androidOriginHelper, /getPort/);
  assert.match(androidNavigation, /isAccessLogin\(|isGatedOrigin\(/);
  assert.match(java, /setInstanceFollowRedirects\(false\)/);
  assert.match(java, /if \(!isGatedOrigin\(uri\)\) throw/);
  assert.match(java, /redirects\s*>\s*5/);
  assert.match(java, /Cross-origin protected redirect rejected/);
  assert.match(java, /request\.getRequestHeaders\(\)/);
});

test('canonical source provenance is local and secret-free', () => {
  const relative = (file) => path.relative(ROOT, file).replaceAll('\\', '/');
  assert.equal(relative(IOS_SOURCE_PATH), 'scripts/prepare-ios-local.sh');
  assert.equal(relative(ANDROID_SOURCE_PATH), 'codemagic.yaml');
  assert.match(sourceHash(IOS_SOURCE_PATH), /^[a-f0-9]{64}$/);
  assert.match(sourceHash(ANDROID_SOURCE_PATH), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(read(IOS_SOURCE_PATH), /CF_ACCESS_CLIENT_SECRET\s*=\s*[^$\s]/i);
});
