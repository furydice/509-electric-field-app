import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);

function extractWorkflowScript(yaml, stepNamePattern) {
  const lines = yaml.split(/\r?\n/);
  const nameIndex = lines.findIndex((line) => stepNamePattern.test(line.trim()));
  assert.notEqual(nameIndex, -1, 'Android SDK workflow step is missing');

  const scriptIndex = lines.findIndex(
    (line, index) => index > nameIndex && /^\s+script:\s*\|\s*$/.test(line),
  );
  assert.notEqual(scriptIndex, -1, 'Android SDK workflow script is missing');

  const scriptIndent = lines[scriptIndex].match(/^\s*/)[0].length;
  const scriptLines = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length <= scriptIndent) break;
    scriptLines.push(line.slice(Math.min(line.length, scriptIndent + 2)));
  }
  return `${scriptLines.join('\n')}\n`;
}

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(existsSync(gitBash), true, `Git Bash not found at ${gitBash}`);
  return gitBash;
}

test('Android workflow generates an API 36 build configuration', () => {
  const yaml = readFileSync(new URL('codemagic.yaml', repoRoot), 'utf8');
  const script = extractWorkflowScript(
    yaml,
    /^- name: Set compile\/target SDK to \d+ and wire release signing$/,
  );
  const workDir = mkdtempSync(join(tmpdir(), 'field-app-android-workflow-'));

  try {
    const scriptPath = join(workDir, 'configure-android.sh');
    writeFileSync(scriptPath, script, 'utf8');
    writeFileSync(join(workDir, 'placeholder'), '', 'utf8');
    const mkdir = spawnSync(bashExecutable(), ['-lc', 'mkdir -p android/app'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(mkdir.status, 0, mkdir.stderr || mkdir.stdout);

    const result = spawnSync(bashExecutable(), [scriptPath], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const variables = readFileSync(join(workDir, 'android', 'variables.gradle'), 'utf8');
    assert.match(variables, /^\s*compileSdkVersion = 36\s*$/m);
    assert.match(variables, /^\s*targetSdkVersion = 36\s*$/m);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
