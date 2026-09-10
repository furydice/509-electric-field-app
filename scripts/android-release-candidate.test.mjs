import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);

function yamlSource() {
  return readFileSync(new URL('codemagic.yaml', repoRoot), 'utf8');
}

function androidWorkflow(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '  field-app-android:');
  assert.notEqual(start, -1, 'field-app-android workflow is missing');
  const next = lines.findIndex((line, index) => index > start && /^  [a-z0-9][a-z0-9-]*:$/.test(line));
  return lines.slice(start, next === -1 ? lines.length : next).join('\n');
}

function extractBuildScript(yaml) {
  const workflow = androidWorkflow(yaml);
  const lines = workflow.split(/\r?\n/);
  const nameIndex = lines.findIndex((line) => /^\s*- name: Build signed Android release candidate/.test(line));
  assert.notEqual(nameIndex, -1, 'signed Android release-candidate step is missing');
  const scriptIndex = lines.findIndex(
    (line, index) => index > nameIndex && /^\s+script:\s*\|\s*$/.test(line),
  );
  assert.notEqual(scriptIndex, -1, 'signed Android release-candidate script is missing');
  const indent = lines[scriptIndex].match(/^\s*/)[0].length;
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.slice(Math.min(line.length, indent + 2)));
  }
  return `${body.join('\n')}\n`;
}

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(existsSync(gitBash), true, `Git Bash not found at ${gitBash}`);
  return gitBash;
}

function posixPath(value) {
  if (process.platform !== 'win32') return value;
  const quoted = value.replaceAll("'", "'\\''");
  const result = spawnSync(bashExecutable(), ['-c', `cygpath -u '${quoted}'`], {
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

function fixture(signatureMode = 'signed') {
  const dir = mkdtempSync(join(tmpdir(), 'field-app-release-candidate-'));
  const androidDir = join(dir, 'android');
  const binDir = join(dir, 'bin');
  const mkdir = spawnSync(bashExecutable(), ['-lc', `mkdir -p '${posixPath(androidDir)}' '${posixPath(binDir)}'`], {
    encoding: 'utf8',
  });
  assert.equal(mkdir.status, 0, mkdir.stderr || mkdir.stdout);

  const gradleArgs = join(dir, 'gradle-args');
  const gradlew = join(androidDir, 'gradlew');
  writeFileSync(gradlew, [
    '#!/usr/bin/env bash',
    'set -eu',
    `printf '%s\\n' "$@" > '${posixPath(gradleArgs)}'`,
    'mkdir -p app/build/outputs/bundle/release app/build/outputs/apk/debug',
    "printf 'synthetic signed bundle' > app/build/outputs/bundle/release/app-release.aab",
    "printf 'synthetic debug apk' > app/build/outputs/apk/debug/app-debug.apk",
    '',
  ].join('\n'), 'utf8');
  chmodSync(gradlew, 0o755);

  const jarsigner = join(binDir, 'jarsigner');
  writeFileSync(jarsigner, [
    '#!/usr/bin/env bash',
    'set -eu',
    signatureMode === 'signed' ? "printf 'jar verified.\\n'" : "printf 'jar is unsigned.\\n'",
    '',
  ].join('\n'), 'utf8');
  chmodSync(jarsigner, 0o755);

  const keystore = join(dir, 'field-upload.keystore');
  writeFileSync(keystore, 'synthetic keystore fixture', 'utf8');
  return { dir, binDir, gradleArgs, keystore };
}

function cleanup(f) {
  const tempRoot = resolve(tmpdir());
  const fixtureRoot = resolve(f.dir);
  assert.ok(fixtureRoot.startsWith(`${tempRoot}${sep}`), 'fixture cleanup must stay inside the temporary root');
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function candidateEnvironment(f, overrides = {}) {
  return {
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    PATH: `${posixPath(f.binDir)}:/usr/bin:/bin`,
    BUILD_NUMBER: '4',
    CM_KEYSTORE_PATH: posixPath(f.keystore),
    CM_KEYSTORE_PASSWORD: 'synthetic-store-password',
    CM_KEY_ALIAS: 'synthetic-key-alias',
    CM_KEY_PASSWORD: 'synthetic-key-password',
    ...overrides,
  };
}

function runBuild(f, overrides = {}) {
  const scriptPath = join(f.dir, 'build-release-candidate.sh');
  writeFileSync(scriptPath, extractBuildScript(yamlSource()), 'utf8');
  chmodSync(scriptPath, 0o755);
  const result = spawnSync(bashExecutable(), [scriptPath], {
    cwd: f.dir,
    env: candidateEnvironment(f, overrides),
    encoding: 'utf8',
  });
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` };
}

test('Android workflow remains artifact-only and names the existing upload keystore', () => {
  const workflow = androidWorkflow(yamlSource());
  assert.match(workflow, /android_signing:\s*\r?\n\s*- field_upload_keystore/);
  assert.doesNotMatch(workflow, /^\s+publishing:/m);
  assert.match(workflow, /^\s+artifacts:/m);
});

test('release candidate rejects used, missing, and malformed version codes before Gradle', () => {
  for (const versionCode of ['3', '', 'four', '4.5']) {
    const f = fixture();
    try {
      const result = runBuild(f, { BUILD_NUMBER: versionCode });
      assert.notEqual(result.status, 0, `versionCode ${JSON.stringify(versionCode)} unexpectedly passed`);
      assert.equal(existsSync(f.gradleArgs), false, result.output);
      assert.match(result.output, /versionCode|BUILD_NUMBER/i);
    } finally {
      cleanup(f);
    }
  }
});

test('release candidate requires every Codemagic signing value and the keystore file before Gradle', () => {
  for (const missing of ['CM_KEYSTORE_PATH', 'CM_KEYSTORE_PASSWORD', 'CM_KEY_ALIAS', 'CM_KEY_PASSWORD']) {
    const f = fixture();
    try {
      const result = runBuild(f, { [missing]: '' });
      assert.notEqual(result.status, 0, `${missing} unexpectedly passed`);
      assert.equal(existsSync(f.gradleArgs), false, result.output);
      assert.doesNotMatch(result.output, /synthetic-(?:store-password|key-alias|key-password)/);
    } finally {
      cleanup(f);
    }
  }

  const f = fixture();
  try {
    const result = runBuild(f, { CM_KEYSTORE_PATH: `${posixPath(f.dir)}/missing.keystore` });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(existsSync(f.gradleArgs), false, result.output);
  } finally {
    cleanup(f);
  }
});

test('release candidate builds code 4 version 1.0 and verifies the generated AAB signature', () => {
  const f = fixture();
  try {
    const result = runBuild(f);
    assert.equal(result.status, 0, result.output);
    const args = readFileSync(f.gradleArgs, 'utf8');
    assert.match(args, /^bundleRelease$/m);
    assert.match(args, /^assembleDebug$/m);
    assert.match(args, /^-PversionCode=4$/m);
    assert.match(args, /^-PversionName=1\.0$/m);
    assert.match(result.output, /signed release AAB verified/i);
    assert.doesNotMatch(result.output, /synthetic-(?:store-password|key-alias|key-password)/);
  } finally {
    cleanup(f);
  }
});

test('release candidate fails when the generated AAB is not signed', () => {
  const f = fixture('unsigned');
  try {
    const result = runBuild(f);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /signature|signed/i);
    assert.doesNotMatch(result.output, /jar is unsigned/i);
  } finally {
    cleanup(f);
  }
});
