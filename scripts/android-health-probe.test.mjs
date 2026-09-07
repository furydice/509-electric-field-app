import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('../', import.meta.url);
const yamlPath = new URL('codemagic.yaml', repoRoot);
const HEALTH_URL = 'https://automation.509electric.com/api/ping';
const VALID_BODY = '{"ok":true,"t":1700000000000,"uptime":1.25}';
const CF_ID = 'synthetic-health-client-id';
const CF_SECRET = 'synthetic-health-client-secret';

function yamlSource() { return readFileSync(yamlPath, 'utf8'); }

function extractWorkflowScript(yaml, pattern) {
  const lines = yaml.split(/\r?\n/);
  const nameIndex = lines.findIndex((line) => pattern.test(line.trim()));
  assert.notEqual(nameIndex, -1, 'requested workflow step is missing');
  const scriptIndex = lines.findIndex((line, index) => index > nameIndex && /^\s+script:\s*\|\s*$/.test(line));
  assert.notEqual(scriptIndex, -1, 'workflow script is missing');
  const indent = lines[scriptIndex].match(/^\s*/)[0].length;
  const body = [];
  for (let i = scriptIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.slice(Math.min(line.length, indent + 2)));
  }
  return body.join('\n') + '\n';
}

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(existsSync(gitBash), true, 'Git Bash is required for the extracted shell test');
  return gitBash;
}

function posixPath(value) {
  if (process.platform !== 'win32') return value;
  const quoted = value.replaceAll("'", "'\\''");
  const result = spawnSync(bashExecutable(), ['-c', "cygpath -u '" + quoted + "'"], {
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      PATH: '/usr/bin:/bin',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fakeCurlScript() {
  const dollar = '$';
  return [
    '#!/usr/bin/env bash',
    'set -eu',
    'headers_file=""',
    'body_file=""',
    'args_file="' + dollar + '{FAKE_CURL_ARGS_FILE:-}"',
    'marker_file="' + dollar + '{FAKE_CURL_MARKER:-}"',
    '[ -z "$marker_file" ] || : > "$marker_file"',
    '[ -z "$args_file" ] || printf "%s\\n" "$@" > "$args_file"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -D|--dump-header|--header-file) headers_file="$2"; shift 2 ;;',
    '    -o|--output) body_file="$2"; shift 2 ;;',
    '-H|--header|-w|--write-out|-X|--request) shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'case "' + dollar + '{FAKE_CURL_MODE:-valid}" in',
    '  valid) status=200; headers="Content-Type: application/json"; body=' + "'" + VALID_BODY + "'" + ' ;;',
    '  server-error) status=500; headers="Content-Type: application/json"; body="HTTP_500_BODY_SENTINEL" ;;',
    '  login-wall) status=200; headers="Location: https://tenant.cloudflareaccess.com/cdn-cgi/access/login"; body="LOGIN_WALL_BODY_SENTINEL" ;;',
    '  non-json) status=200; headers="Content-Type: text/html"; body="NON_JSON_BODY_SENTINEL" ;;',
    '  invalid-shape) status=200; headers="Content-Type: application/json"; body="{\\"ok\\":true,\\"t\\":0,\\"uptime\\":-1}" ;;',
    '  transport) exit 7 ;;',
    '  *) status=599; headers=""; body="UNKNOWN_FAKE_MODE_SENTINEL" ;;',
    'esac',
    '[ -z "$headers_file" ] || printf "%s\\n" "$headers" > "$headers_file"',
    '[ -z "$body_file" ] || printf "%s" "$body" > "$body_file"',
    'printf "%s" "$status"',
    '',
  ].join('\n');
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'field-app-health-probe-'));
  writeFileSync(join(dir, 'curl'), fakeCurlScript(), 'utf8');
  chmodSync(join(dir, 'curl'), 0o755);
  return { dir, marker: join(dir, 'curl-called'), args: join(dir, 'curl-args') };
}

function cleanup(f) {
  const root = resolve(tmpdir());
  const dir = resolve(f.dir);
  assert.ok(dir.startsWith(root + sep), 'fixture cleanup must stay inside the temporary root');
  rmSync(dir, { recursive: true, force: true });
}

function runScript(script, f, variables = {}) {
  const scriptPath = join(f.dir, 'step.sh');
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  const prefix = posixPath(f.dir);
  const nodePrefix = posixPath(dirname(process.execPath));
  const expectedCurl = prefix + '/curl';
  const wrapperPath = join(f.dir, 'run.sh');
  const wrapper = [
    '#!/usr/bin/env bash',
    'set -eu',
    "export PATH='" + prefix + ":/usr/bin:/bin:" + nodePrefix + "'",
    'resolved="$(command -v curl || true)"',
    "if [ \"$resolved\" != '" + expectedCurl + "' ]; then echo 'fixture curl was not resolved first'; exit 97; fi",
    "source '" + posixPath(scriptPath) + "'",
    '',
  ].join('\n');
  writeFileSync(wrapperPath, wrapper, 'utf8');
  chmodSync(wrapperPath, 0o755);
  const result = spawnSync(bashExecutable(), [wrapperPath], {
    cwd: f.dir,
    env: {
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      TMP: prefix,
      TEMP: prefix,
      PATH: prefix + ':/usr/bin:/bin:' + nodePrefix,
      FAKE_CURL_MARKER: posixPath(f.marker),
      FAKE_CURL_ARGS_FILE: posixPath(f.args),
      ...variables,
    },
    encoding: 'utf8',
  });
  return {
    ...result,
    output: (result.stdout || '') + (result.stderr || ''),
    called: existsSync(f.marker),
    args: existsSync(f.args) ? readFileSync(f.args, 'utf8') : '',
  };
}

function healthScript() {
  return extractWorkflowScript(yamlSource(), /^- name:\s+Optional live MC reachability probe$/);
}

test('reachability probe source uses explicit opt-in and the fixed public MC endpoint', () => {
  const script = healthScript();
  assert.match(script, /MC_HEALTH_PROBE/);
  assert.match(script, new RegExp(HEALTH_URL.replaceAll('.', '\\.'), 'i'));
  assert.match(script, /CF_CLIENT_ID/);
  assert.match(script, /CF_CLIENT_SECRET/);
});

test('reachability probe defaults to a clear skip before curl or credential use', () => {
  const f = fixture();
  try {
    const result = runScript(healthScript(), f, { CF_CLIENT_ID: '', CF_CLIENT_SECRET: '' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /(?:skip|disabled).*MC_HEALTH_PROBE|MC_HEALTH_PROBE.*(?:skip|disabled)/i);
    assert.equal(result.called, false);
    assert.doesNotMatch(result.output, /synthetic-health-client-(?:id|secret)/);
  } finally { cleanup(f); }
});

test('reachability probe accepts opted-in 200 with the exact MC payload', () => {
  const f = fixture();
  try {
    const result = runScript(healthScript(), f, {
      MC_HEALTH_PROBE: '1', CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: CF_SECRET, FAKE_CURL_MODE: 'valid',
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.called, true);
    assert.match(result.args, /CF-Access-Client-Id:/);
    assert.match(result.args, /CF-Access-Client-Secret:/);
    assert.match(result.args, new RegExp(HEALTH_URL.replaceAll('.', '\\.'), 'i'));
    assert.match(result.output, /200|reachability probe passed|validated/i);
    assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
  } finally { cleanup(f); }
});

for (const [mode, label] of [
  ['server-error', 'HTTP 500'],
  ['login-wall', 'Cloudflare login wall'],
  ['non-json', 'non-JSON body'],
  ['invalid-shape', 'invalid JSON shape'],
  ['transport', 'curl transport failure'],
]) {
  test('reachability probe fails closed for ' + label + ' without echoing response data', () => {
    const f = fixture();
    try {
      const result = runScript(healthScript(), f, {
        MC_HEALTH_PROBE: '1', CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: CF_SECRET, FAKE_CURL_MODE: mode,
      });
      assert.notEqual(result.status, 0, result.output);
      assert.equal(result.called, true);
      assert.doesNotMatch(result.output, /HTTP_500_BODY_SENTINEL|LOGIN_WALL_BODY_SENTINEL|NON_JSON_BODY_SENTINEL/);
      assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
    } finally { cleanup(f); }
  });
}

test('opt-in reachability probe rejects missing credentials before curl', () => {
  for (const variables of [
    { MC_HEALTH_PROBE: '1', CF_CLIENT_ID: '', CF_CLIENT_SECRET: CF_SECRET },
    { MC_HEALTH_PROBE: '1', CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: '' },
  ]) {
    const f = fixture();
    try {
      const result = runScript(healthScript(), f, variables);
      assert.notEqual(result.status, 0, result.output);
      assert.equal(result.called, false);
      assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
    } finally { cleanup(f); }
  }
});

test('reachability probe rejects invalid opt-in values before curl', () => {
  const f = fixture();
  try {
    const result = runScript(healthScript(), f, {
      MC_HEALTH_PROBE: 'yes', CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: CF_SECRET, FAKE_CURL_MODE: 'valid',
    });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.called, false);
    assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
  } finally { cleanup(f); }
});

test('always-run build settings validation rejects missing credentials without exposing values', () => {
  const script = extractWorkflowScript(yamlSource(), /^- name:\s+Validate CF Access build settings$/);
  for (const variables of [
    { CF_CLIENT_ID: '', CF_CLIENT_SECRET: CF_SECRET },
    { CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: '' },
  ]) {
    const f = fixture();
    try {
      const result = runScript(script, f, variables);
      assert.notEqual(result.status, 0, result.output);
      assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
    } finally { cleanup(f); }
  }
  const f = fixture();
  try {
    const result = runScript(script, f, { CF_CLIENT_ID: CF_ID, CF_CLIENT_SECRET: CF_SECRET });
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, new RegExp(CF_ID + '|' + CF_SECRET));
  } finally { cleanup(f); }
});
