import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyDebuggerBashCommand,
  type DebuggerWorkspace,
} from './debugger-sandbox.ts';

function workspace(): { root: string; workspace: DebuggerWorkspace } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-debugger-policy-'));
  const projectDir = path.join(root, 'project');
  const artRepoDir = path.join(root, 'art');
  const artDir = path.join(projectDir, '__art__');
  const debuggerDir = path.join(artDir, '.debugger');
  fs.mkdirSync(path.join(artDir, '.state', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(artRepoDir, 'app', 'server'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'PIPELINE.json'), '{}\n');
  fs.writeFileSync(path.join(artRepoDir, 'README.md'), '# ART\n');

  return {
    root,
    workspace: {
      projectDir,
      artRepoDir,
      artDir,
      debuggerDir,
      claudeConfigDir: path.join(debuggerDir, 'claude-config'),
      tmpDir: path.join(debuggerDir, 'tmp'),
      debugLogsDir: path.join(debuggerDir, 'logs'),
      artRuntimeDir: path.join(debuggerDir, 'art-runtime'),
      runtimeGroupsDir: path.join(debuggerDir, 'art-runtime', 'groups'),
      memoryPath: path.join(debuggerDir, 'MEMORY.md'),
      permissionsPath: path.join(debuggerDir, 'permissions.json'),
    },
  };
}

function decide(command: string, opts?: { remembered?: boolean }) {
  const fixture = workspace();
  try {
    return classifyDebuggerBashCommand(
      fixture.workspace,
      { command },
      {
        isRememberedAllowed: opts?.remembered ? () => true : undefined,
      },
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('auto-allows loaded-project art run and forces background execution', () => {
  const fixture = workspace();
  try {
    const direct = classifyDebuggerBashCommand(fixture.workspace, {
      command: 'art run "$AER_ART_PROJECT_DIR"',
    });
    assert.equal(direct.kind, 'allow');
    assert.equal(direct.reason, 'auto-art-run');
    assert.equal(direct.updatedInput.run_in_background, true);
    assert.match(String(direct.updatedInput.command), /AER_ART_DEBUGGER_ART_REPO_DIR=/);
    assert.match(String(direct.updatedInput.command), /AER_ART_DEBUGGER_RUNTIME_GROUPS_DIR=/);
    assert.match(String(direct.updatedInput.command), /NODE_OPTIONS='--import=file:\/\//);
    assert.match(String(direct.updatedInput.command), /\bart run \.$/);

    const cdForm = classifyDebuggerBashCommand(fixture.workspace, {
      command: 'cd "$AER_ART_PROJECT_DIR" && art run .',
      run_in_background: false,
    });
    assert.equal(cdForm.kind, 'allow');
    assert.equal(cdForm.reason, 'auto-art-run');
    assert.equal(cdForm.updatedInput.run_in_background, true);

    const wrapped = classifyDebuggerBashCommand(fixture.workspace, {
      command: String(cdForm.updatedInput.command),
      run_in_background: false,
    });
    assert.equal(wrapped.kind, 'allow');
    assert.equal(wrapped.reason, 'auto-art-run');
    assert.equal(wrapped.updatedInput.run_in_background, true);
    assert.equal(wrapped.updatedInput.command, cdForm.updatedInput.command);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('denies art run for a different target', () => {
  const result = decide('art run /tmp/other-project');
  assert.equal(result.kind, 'deny');
  assert.equal(result.reason, 'other-art-run-target');
});

test('auto-allows conservative read-only inspection in project and ART repo', () => {
  const fixture = workspace();
  try {
    for (const command of [
      'pwd',
      'ls __art__',
      'cat __art__/PIPELINE.json',
      'tail -200 "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json"',
      `rg --files ${fixture.workspace.artRepoDir}/app`,
      'ls "$AER_ART_PROJECT_DIR/__art__/.state/" 2>/dev/null && cat "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json" 2>/dev/null || echo "No state directory or state file"',
      'ls -t "$AER_ART_PROJECT_DIR/__art__/.state/logs/" | head -10',
      'sleep 10 && cat "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json" 2>/dev/null || echo "State file not yet created"',
      'kill -0 161 2>&1 || echo "PID 161 not running"',
      'wc -l "$AER_ART_PROJECT_DIR/__art__/plan/PLAN.md" 2>/dev/null; echo "---"; head -20 "$AER_ART_PROJECT_DIR/__art__/plan/PLAN.md" 2>/dev/null',
      'ls -t "$AER_ART_PROJECT_DIR/__art__/.state/logs/pipeline-"*.log 2>/dev/null | head -1 | xargs tail -30 2>/dev/null',
      'cat ~/.config/aer-art/mount-allowlist.json 2>/dev/null || echo "No mount allowlist found"',
      'git status 2>&1 || true',
      'git status --short',
      `find ${fixture.workspace.artRepoDir}/app -type f -name "*.ts" | grep -v node_modules | sort`,
    ]) {
      const result = classifyDebuggerBashCommand(fixture.workspace, { command });
      assert.equal(result.kind, 'allow', command);
      assert.equal(result.reason, 'auto-read-only', command);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('auto-allows conservative volatile writes under selected project __art__', () => {
  for (const command of [
    'rm -rf "$AER_ART_PROJECT_DIR/__art__/.state"',
    'mkdir -p "$AER_ART_PROJECT_DIR/__art__/.state/logs"',
    'touch "$AER_ART_PROJECT_DIR/__art__/.debugger/MEMORY.md"',
  ]) {
    const result = decide(command);
    assert.equal(result.kind, 'allow', command);
    assert.equal(result.reason, 'auto-art-write', command);
  }
});

test('does not auto-allow read-only inspection outside project or ART repo', () => {
  const result = decide('cat /etc/passwd');
  assert.equal(result.kind, 'ask');
  assert.equal(result.reason, 'needs-user-approval');
});

test('does not auto-allow unsafe shell-control or write forms', () => {
  for (const command of [
    'ls __art__; rm -f "$AER_ART_PROJECT_DIR/__art__/PIPELINE.json"',
    'find __art__ -type f -exec cat {} \\;',
    'cat /etc/passwd | head',
    'cat ~/.config/aer-art/token',
    'cat __art__/PIPELINE.json | tee __art__/copy.txt',
    'git clean -fd',
    'git -c alias.status=!sh status',
    'echo /etc/passwd | xargs tail -30',
    'ls __art__ | xargs rm -f',
    'echo hi > __art__/written-by-bash.txt',
    'echo hi > /tmp/out',
    'sleep 600 && cat __art__/PIPELINE.json',
    'kill -9 161',
    'rm -rf "$AER_ART_PROJECT_DIR/__art__"',
    'rm -f "$AER_ART_PROJECT_DIR/__art__/PIPELINE.json"',
    'touch "$AER_ART_PROJECT_DIR/src/out.txt"',
  ]) {
    const result = decide(command);
    assert.equal(result.kind, 'ask', command);
  }
});

test('denies long-running shell polling loops', () => {
  const result = decide('until grep -q "success" "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json" 2>/dev/null; do sleep 5; done && cat "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json"');
  assert.equal(result.kind, 'deny');
  assert.equal(result.reason, 'unsafe-shell-form');
});

test('denies ad hoc scripting runtimes instead of prompting', () => {
  for (const command of [
    'python3 -c "print(1)"',
    'wc -l "$AER_ART_PROJECT_DIR/__art__/.state/logs/pipeline.log" && cat "$AER_ART_PROJECT_DIR/__art__/.state/PIPELINE_STATE.json" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin))"',
    'node -e "console.log(1)"',
  ]) {
    const result = decide(command);
    assert.equal(result.kind, 'deny', command);
    assert.equal(result.reason, 'unsafe-shell-form', command);
  }
});

test('denies direct container/runtime control and localhost API calls', () => {
  for (const command of [
    'docker ps',
    'podman ps',
    'udocker version',
    'echo ok && docker ps',
    'curl http://localhost:4000/api/current',
    'wget 127.0.0.1:4000/api/current',
    'echo ok && curl http://localhost:4000/api/current',
  ]) {
    const result = decide(command);
    assert.equal(result.kind, 'deny', command);
  }
});

test('remembered project commands are allowed after hard denies are checked', () => {
  assert.equal(decide('echo inspect', { remembered: true }).kind, 'allow');
  assert.equal(decide('docker ps', { remembered: true }).kind, 'deny');
});
