import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getRun,
  getStage,
  listRuns,
  readEvents,
  readPipelineSnap,
  readProvenance,
  readStageCommand,
  readStageDiff,
  readStageDiffSummary,
  readStageStream,
  readStageText,
  readStageTurns,
} from './run-reader.ts';

interface MakeRunOpts {
  sealed?: boolean;
  runJson?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
  pipelineSnap?: Record<string, unknown>;
  stages?: Record<
    string,
    {
      stage?: Record<string, unknown>;
      container?: Record<string, unknown>;
      substitutions?: Record<string, unknown>;
      prompt?: string;
      promptSource?: string;
      initial?: string;
      commandSh?: string;
      commandJson?: Record<string, unknown>;
      diffMounts?: Record<string, string>; // mount -> diff content
      diffSummary?: Record<string, unknown>;
      turns?: Array<Record<string, unknown>>;
      streams?: { agent?: string; stdout?: string; stderr?: string };
    }
  >;
}

function mkProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-reader-test-'));
  fs.mkdirSync(path.join(dir, '__art__', '.state', 'runs'), { recursive: true });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeRun(
  projectDir: string,
  runId: string,
  opts: MakeRunOpts,
  // nodeId default is 'root' so the stages map is structurally
  // identical to a non-stitched run.
  nodeId: string = 'root',
): void {
  const runDir = path.join(projectDir, '__art__', '.state', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startTime: '2026-01-01T00:00:00.000Z',
      provider: 'codex',
      args: ['run', '/tmp'],
      ...opts.runJson,
    }),
  );
  if (opts.sealed) fs.writeFileSync(path.join(runDir, 'sealed'), '');
  if (opts.summary) {
    fs.writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({ schemaVersion: 1, ...opts.summary }),
    );
  }
  if (opts.events) {
    fs.writeFileSync(
      path.join(runDir, 'events.jsonl'),
      opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  if (opts.provenance) {
    fs.writeFileSync(
      path.join(runDir, 'provenance.json'),
      JSON.stringify({ schemaVersion: 1, ...opts.provenance }),
    );
  }
  if (opts.pipelineSnap) {
    fs.writeFileSync(
      path.join(runDir, 'pipeline.snap.json'),
      JSON.stringify(opts.pipelineSnap),
    );
  }
  if (opts.stages) {
    for (const [stageName, s] of Object.entries(opts.stages)) {
      const sd = path.join(runDir, 'nodes', nodeId, 'stages', stageName);
      fs.mkdirSync(sd, { recursive: true });
      if (s.stage) {
        fs.writeFileSync(
          path.join(sd, 'stage.json'),
          JSON.stringify({
            schemaVersion: 1,
            stageName,
            nodeId,
            ...s.stage,
          }),
        );
      }
      if (s.container) {
        fs.writeFileSync(
          path.join(sd, 'container.json'),
          JSON.stringify({ schemaVersion: 1, stageName, ...s.container }),
        );
      }
      if (s.substitutions) {
        fs.writeFileSync(
          path.join(sd, 'substitutions.json'),
          JSON.stringify(s.substitutions),
        );
      }
      if (s.prompt !== undefined)
        fs.writeFileSync(path.join(sd, 'prompt.txt'), s.prompt);
      if (s.promptSource !== undefined)
        fs.writeFileSync(path.join(sd, 'prompt.source'), s.promptSource);
      if (s.initial !== undefined)
        fs.writeFileSync(path.join(sd, 'initial.txt'), s.initial);
      if (s.commandSh !== undefined)
        fs.writeFileSync(path.join(sd, 'command.sh'), s.commandSh);
      if (s.commandJson !== undefined)
        fs.writeFileSync(
          path.join(sd, 'command.json'),
          JSON.stringify(s.commandJson),
        );
      if (s.diffMounts || s.diffSummary) {
        const dd = path.join(sd, 'diff');
        fs.mkdirSync(dd, { recursive: true });
        if (s.diffSummary)
          fs.writeFileSync(
            path.join(dd, 'summary.json'),
            JSON.stringify(s.diffSummary),
          );
        if (s.diffMounts) {
          for (const [m, content] of Object.entries(s.diffMounts)) {
            fs.writeFileSync(path.join(dd, `${m}.diff`), content);
          }
        }
      }
      if (s.turns) {
        const td = path.join(sd, 'turns');
        fs.mkdirSync(td, { recursive: true });
        s.turns.forEach((t, i) => {
          fs.writeFileSync(
            path.join(td, `${String(i + 1).padStart(3, '0')}.json`),
            JSON.stringify(t),
          );
        });
      }
      if (s.streams) {
        if (s.streams.agent !== undefined)
          fs.writeFileSync(path.join(sd, 'agent.stream.log'), s.streams.agent);
        if (s.streams.stdout !== undefined)
          fs.writeFileSync(path.join(sd, 'stdout.log'), s.streams.stdout);
        if (s.streams.stderr !== undefined)
          fs.writeFileSync(path.join(sd, 'stderr.log'), s.streams.stderr);
      }
    }
  }
}

test('listRuns returns [] when runs dir missing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-empty-'));
  try {
    assert.deepEqual(listRuns(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('listRuns returns runs newest-first with summary merged', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-100-aaaaaa', {
      sealed: true,
      summary: {
        outcome: 'success',
        totalStages: 2,
        failedStages: 0,
        durationMs: 1234,
      },
    });
    makeRun(dir, 'run-200-bbbbbb', {
      sealed: true,
      summary: { outcome: 'error', totalStages: 3, failedStages: 2 },
    });
    const runs = listRuns(dir);
    assert.equal(runs.length, 2);
    // Newest first.
    assert.equal(runs[0].runId, 'run-200-bbbbbb');
    assert.equal(runs[0].state, 'sealed');
    assert.equal(runs[0].outcome, 'error');
    assert.equal(runs[0].totalStages, 3);
    assert.equal(runs[1].runId, 'run-100-aaaaaa');
    assert.equal(runs[1].outcome, 'success');
    assert.equal(runs[1].durationMs, 1234);
  } finally {
    cleanup();
  }
});

test('classification: sealed > live > crashed', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-sealed', { sealed: true });
    makeRun(dir, 'run-2-live', { runJson: { pid: process.pid } });
    makeRun(dir, 'run-3-dead', { runJson: { pid: 2 ** 22 + 1 } });
    const byId = new Map(listRuns(dir).map((r) => [r.runId, r]));
    assert.equal(byId.get('run-1-sealed')!.state, 'sealed');
    assert.equal(byId.get('run-2-live')!.state, 'live');
    assert.equal(byId.get('run-3-dead')!.state, 'crashed');
  } finally {
    cleanup();
  }
});

test('classification: missing run.json or pid -> crashed', () => {
  const { dir, cleanup } = mkProject();
  try {
    const runDir = path.join(dir, '__art__', '.state', 'runs', 'run-1-aaaaaa');
    fs.mkdirSync(runDir, { recursive: true });
    // No run.json
    assert.equal(listRuns(dir)[0]?.state, 'crashed');

    fs.writeFileSync(path.join(runDir, 'run.json'), '{not valid');
    assert.equal(listRuns(dir)[0]?.state, 'crashed');
  } finally {
    cleanup();
  }
});

test('getRun returns null for missing run', () => {
  const { dir, cleanup } = mkProject();
  try {
    assert.equal(getRun(dir, 'run-nope'), null);
  } finally {
    cleanup();
  }
});

test('getRun returns header + node tree + flags', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      summary: { outcome: 'success', totalStages: 1, failedStages: 0 },
      provenance: { agents: [], templates: [], env: {} },
      pipelineSnap: { stages: [] },
      stages: { build: { stage: { result: 'success' } } },
    });
    const detail = getRun(dir, 'run-1-aaaaaa');
    assert.ok(detail);
    assert.equal(detail!.state, 'sealed');
    assert.equal(detail!.outcome, 'success');
    assert.equal(detail!.hasProvenance, true);
    assert.equal(detail!.hasPipelineSnap, true);
    assert.equal(detail!.hasEvents, false); // no events emitted in test
    assert.deepEqual(detail!.nodes, [{ nodeId: 'root', stages: ['build'] }]);
  } finally {
    cleanup();
  }
});

test('getStage returns null for missing stage', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', { sealed: true });
    assert.equal(getStage(dir, 'run-1-aaaaaa', 'root', 'nope'), null);
  } finally {
    cleanup();
  }
});

test('getStage reports presence flags for prompt/initial/command/diff/turns/streams', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      stages: {
        build: {
          stage: { result: 'success', matchedMarker: 'STAGE_COMPLETE' },
          container: { image: 'art-agent:latest', mode: 'agent', mounts: [] },
          substitutions: { insertId: 'root', index: 0 },
          prompt: 'build this',
          promptSource: 'inline',
          initial: 'handoff',
          diffMounts: { src: '--- a/foo\n+++ b/foo\n' },
          diffSummary: { schemaVersion: 1, mounts: [{ mount: 'src', changed: true, bytes: 30 }] },
          turns: [{ provider: 'claude', tokensIn: 10 }, { provider: 'claude', tokensIn: 5 }],
          streams: { agent: 'a'.repeat(100) },
        },
      },
    });
    const s = getStage(dir, 'run-1-aaaaaa', 'root', 'build');
    assert.ok(s);
    assert.equal(s!.hasPrompt, true);
    assert.equal(s!.promptSource, 'inline');
    assert.equal(s!.hasInitial, true);
    assert.equal(s!.hasCommand, false);
    assert.equal(s!.hasDiff, true);
    assert.deepEqual(s!.diffMounts, ['src']);
    assert.equal(s!.turnCount, 2);
    assert.equal(s!.streamSizes.agent, 100);
    assert.equal(s!.streamSizes.stdout, 0);
    assert.equal(s!.substitutions?.insertId, 'root');
  } finally {
    cleanup();
  }
});

test('readEvents filters by type prefix and exact match', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      events: [
        { type: 'log.info', stageName: 'a' },
        { type: 'decision.marker', stageName: 'a' },
        { type: 'decision.barrier', stageName: 'a' },
        { type: 'stitch.invoked', stageName: 'a' },
      ],
    });
    assert.equal(readEvents(dir, 'run-1-aaaaaa').length, 4);
    assert.equal(
      readEvents(dir, 'run-1-aaaaaa', { type: 'decision.' }).length,
      2,
    );
    assert.equal(
      readEvents(dir, 'run-1-aaaaaa', { type: 'stitch.invoked' }).length,
      1,
    );
  } finally {
    cleanup();
  }
});

test('readEvents respects limit', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      events: Array.from({ length: 20 }, (_, i) => ({ type: 'x', i })),
    });
    assert.equal(readEvents(dir, 'run-1-aaaaaa', { limit: 5 }).length, 5);
  } finally {
    cleanup();
  }
});

test('readStageText returns null for missing file', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', { sealed: true });
    assert.equal(
      readStageText(dir, 'run-1-aaaaaa', 'root', 'nope', 'prompt.txt'),
      null,
    );
  } finally {
    cleanup();
  }
});

test('readStageDiff returns content, summary returns object', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      stages: {
        build: {
          stage: { result: 'success' },
          diffMounts: { src: 'diff content' },
          diffSummary: { schemaVersion: 1, mounts: [] },
        },
      },
    });
    assert.equal(
      readStageDiff(dir, 'run-1-aaaaaa', 'root', 'build', 'src'),
      'diff content',
    );
    const summary = readStageDiffSummary(
      dir,
      'run-1-aaaaaa',
      'root',
      'build',
    );
    assert.equal(summary?.schemaVersion, 1);
  } finally {
    cleanup();
  }
});

test('readStageTurns returns array of turn records in order', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      stages: {
        build: {
          stage: { result: 'success' },
          turns: [
            { provider: 'claude', i: 1 },
            { provider: 'claude', i: 2 },
            { provider: 'codex', i: 3 },
          ],
        },
      },
    });
    const turns = readStageTurns(dir, 'run-1-aaaaaa', 'root', 'build');
    assert.equal(turns.length, 3);
    assert.equal(turns[0].i, 1);
    assert.equal(turns[2].provider, 'codex');
  } finally {
    cleanup();
  }
});

test('readStageStream returns null when stream absent', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', { sealed: true });
    assert.equal(
      readStageStream(dir, 'run-1-aaaaaa', 'root', 'build', 'agent'),
      null,
    );
  } finally {
    cleanup();
  }
});

test('readStageStream returns last N lines', () => {
  const { dir, cleanup } = mkProject();
  try {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      stages: { build: { streams: { stdout: lines } } },
    });
    const r = readStageStream(
      dir,
      'run-1-aaaaaa',
      'root',
      'build',
      'stdout',
      5,
    );
    assert.ok(r);
    assert.equal(r!.lines.length, 5);
    assert.equal(r!.lines[0], 'line15');
  } finally {
    cleanup();
  }
});

test('readStageCommand returns sh + meta or {null,null}', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      stages: {
        build: {
          commandSh: 'echo hi',
          commandJson: { shell: 'sh -c', timeoutMs: 1000, env: {} },
        },
        verify: {},
      },
    });
    const cmd = readStageCommand(dir, 'run-1-aaaaaa', 'root', 'build');
    assert.equal(cmd.sh, 'echo hi');
    assert.equal(cmd.meta?.shell, 'sh -c');
    const noCmd = readStageCommand(dir, 'run-1-aaaaaa', 'root', 'verify');
    assert.equal(noCmd.sh, null);
    assert.equal(noCmd.meta, null);
  } finally {
    cleanup();
  }
});

test('readProvenance and readPipelineSnap return parsed JSON', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(dir, 'run-1-aaaaaa', {
      sealed: true,
      provenance: { agents: [{ path: 'a.md' }], templates: [], env: {} },
      pipelineSnap: { stages: [{ name: 'x' }] },
    });
    const p = readProvenance(dir, 'run-1-aaaaaa');
    assert.equal((p?.agents as Array<{ path: string }>)[0].path, 'a.md');
    const snap = readPipelineSnap(dir, 'run-1-aaaaaa');
    assert.equal((snap?.stages as Array<{ name: string }>)[0].name, 'x');
  } finally {
    cleanup();
  }
});

test('getStage walks nested dispatch nodes (stitched)', () => {
  const { dir, cleanup } = mkProject();
  try {
    makeRun(
      dir,
      'run-1-aaaaaa',
      {
        sealed: true,
        stages: { 'd_abc_0__work': { stage: { result: 'success' } } },
      },
      'd_abc_0',
    );
    const s = getStage(dir, 'run-1-aaaaaa', 'd_abc_0', 'd_abc_0__work');
    assert.ok(s);
    assert.equal(s!.stage?.result, 'success');
  } finally {
    cleanup();
  }
});
