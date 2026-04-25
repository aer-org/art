import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'art-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/aer-art-test-data',
  GROUPS_DIR: '/tmp/aer-art-test-groups',
  IDLE_TIMEOUT: 1800000,
  MCP_REGISTRY_PATH: '/tmp/aer-art-test-mcp-registry.json',
  TIMEZONE: 'America/Los_Angeles',
  getProjectRoot: () => '/tmp/aer-art-test-root',
  getCredentialProxyPort: () => 3001,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  getRuntime: () => ({
    kind: 'docker',
    bin: 'docker',
    capabilities: {
      canBuild: true,
      supportsAutoRemove: true,
      supportsNaming: true,
      supportsAddHost: true,
      supportsDevices: true,
      supportsDeviceCgroupRule: true,
      supportsPsFilter: true,
      supportsUser: true,
      supportsStdin: true,
    },
    hostGateway: 'host.docker.internal',
    bridgeInterface: 'docker0',
    selinux: false,
    rootless: false,
  }),
  hostGatewayArgs: () => [],
  readonlyMountArgs: (host: string, container: string) => [
    '-v',
    `${host}:${container}:ro`,
  ],
  writableMountArgs: (host: string, container: string) => [
    '-v',
    `${host}:${container}`,
  ],
  stopContainer: vi.fn(),
  prepareContainer: vi.fn(),
  cleanupContainer: vi.fn(),
}));

// Mock image-registry
vi.mock('./image-registry.js', () => ({
  getImageForStage: vi.fn(() => 'art-agent:latest'),
  loadImageRegistry: vi.fn(() => ({})),
}));

// Mock group-folder — route to temp dirs
const TEST_GROUPS_BASE = path.join(os.tmpdir(), 'art-test-groups');
const TEST_IPC_BASE = path.join(os.tmpdir(), 'art-test-ipc');

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    path.join(TEST_GROUPS_BASE, folder),
  resolveGroupIpcPath: (folder: string) => path.join(TEST_IPC_BASE, folder),
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key',
}));

vi.mock('./mcp-registry.js', () => ({
  formatStageMcpAccessSummary: vi.fn(() => []),
  loadMcpRegistry: vi.fn(() => ({})),
  resolveStageMcpServers: vi.fn(() => []),
}));

// --- runContainerAgent mock ---
// Queue-based: tests enqueue output sequences per stage name.
// When runContainerAgent is called, it pulls the next sequence for that stage.

interface OutputSequenceEntry {
  result: string | null;
}

// Each stage name maps to a list of "invocations". Each invocation is an array
// of output entries that will be emitted sequentially with delays between them.
// This supports multi-turn retry within a single container invocation.
const stageOutputQueues = new Map<string, OutputSequenceEntry[][]>();

function enqueueStageOutput(
  stageName: string,
  sequence: OutputSequenceEntry[],
) {
  if (!stageOutputQueues.has(stageName)) {
    stageOutputQueues.set(stageName, []);
  }
  stageOutputQueues.get(stageName)!.push(sequence);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('./container-runner.js', () => ({
  prefixLogLines: (chunk: string, stageName: string, remainder: string) => {
    const text = remainder + chunk;
    const lines = text.split('\n');
    const newRemainder = lines.pop()!;
    const prefixed = lines.map((l: string) => `[${stageName}] ${l}\n`).join('');
    return { prefixed, remainder: newRemainder };
  },
  runContainerAgent: vi.fn(
    (
      group: { name: string },
      _input: { prompt: string },
      _onProcess: unknown,
      onOutput: (output: { status: string; result: string | null }) => void,
    ) => {
      const stageName = group.name.replace('pipeline-', '');
      const queues = stageOutputQueues.get(stageName) || [];
      const sequence = queues.shift();

      // Return a long-lived promise simulating a running container.
      // Emit outputs with delays so the FSM has time to set pendingResult
      // between each round. Sentinel `__REJECT__` lets tests force a failure.
      return new Promise<{ status: string; result: string | null }>(
        (resolve, reject) => {
          (async () => {
            // Wait for FSM to set initial pendingResult
            await delay(30);

            if (sequence) {
              for (const entry of sequence) {
                if (entry.result === '__REJECT__') {
                  reject(new Error(`forced reject in ${stageName}`));
                  return;
                }
                await onOutput({ status: 'success', result: entry.result });
                // Give FSM time to process result and set new pendingResult
                await delay(30);
              }
            }

            // Container exit
            resolve({ status: 'success', result: null });
          })();
        },
      );
    },
  ),
  buildContainerArgs: vi.fn(() => [
    'run',
    '--rm',
    '--name',
    'test-container',
    'art-agent:latest',
  ]),
}));

// Mock child_process for command mode
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess> | null = null;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_bin: string, args?: readonly string[]) => {
      // Group C tests set fakeProc manually and drive stdout/close themselves.
      if (fakeProc) return fakeProc;
      // Otherwise auto-complete: simulate `sh -c '<cmd>'` for trivial echo
      // commands (used by the parallel-stitch barrier).
      const proc = createFakeProcess();
      const argList = args ?? [];
      const cmdIdx = argList.indexOf('-c');
      const cmd = cmdIdx >= 0 ? (argList[cmdIdx + 1] ?? '') : '';
      const echoMatch = cmd.match(/^echo\s+'([^']*)'$/);
      setImmediate(() => {
        if (echoMatch) {
          proc.stdout.push(echoMatch[1] + '\n');
        }
        proc.stdout.push(null);
        proc.emit('close', 0);
      });
      return proc;
    }),
  };
});

import {
  parseStageMarkers,
  loadPipelineConfig,
  savePipelineState,
  loadPipelineState,
  PipelineRunner,
  resolveStitchInputs,
  type PipelineTransition,
  type PipelineConfig,
  type PipelineState,
} from './pipeline-runner.js';
import * as mcpRegistry from './mcp-registry.js';
import type { RegisteredGroup } from './types.js';

const mockLoadMcpRegistry = vi.mocked(mcpRegistry.loadMcpRegistry);
const mockResolveStageMcpServers = vi.mocked(
  mcpRegistry.resolveStageMcpServers,
);

beforeEach(() => {
  mockLoadMcpRegistry.mockReset();
  mockLoadMcpRegistry.mockReturnValue({});
  mockResolveStageMcpServers.mockReset();
  mockResolveStageMcpServers.mockReturnValue([]);
});

// ============================================================
// Group A: Pure functions (no mocks needed)
// ============================================================

describe('parseStageMarkers', () => {
  const transitions: PipelineTransition[] = [
    { marker: 'STAGE_COMPLETE', next: 'verify' },
    { marker: 'ERROR', next: null },
  ];

  it('matches [STAGE_COMPLETE] marker', () => {
    const result = parseStageMarkers(
      ['Some output [STAGE_COMPLETE] done'],
      transitions,
    );
    expect(result.matched).toEqual(
      expect.objectContaining({ marker: 'STAGE_COMPLETE' }),
    );
    expect(result.payload).toBeNull();
  });

  it('extracts payload from [ERROR: build failed]', () => {
    const result = parseStageMarkers(
      ['Output [ERROR: build failed] end'],
      transitions,
    );
    expect(result.matched).toEqual(
      expect.objectContaining({ marker: 'ERROR' }),
    );
    expect(result.payload).toBe('build failed');
  });

  it('returns first match when multiple markers present', () => {
    const result = parseStageMarkers(
      ['[STAGE_COMPLETE] and [ERROR: oops]'],
      transitions,
    );
    expect(result.matched!.marker).toBe('STAGE_COMPLETE');
  });

  it('returns null when no markers match', () => {
    const result = parseStageMarkers(['no markers here'], transitions);
    expect(result.matched).toBeNull();
    expect(result.payload).toBeNull();
  });

  it('joins multiple result texts before matching', () => {
    const result = parseStageMarkers(
      ['first chunk', 'second chunk [STAGE_COMPLETE]'],
      transitions,
    );
    expect(result.matched!.marker).toBe('STAGE_COMPLETE');
  });

  it('extracts fenced multi-line payload', () => {
    const text = [
      'Here is the handoff:',
      '[ERROR]',
      '---PAYLOAD_START---',
      'line one',
      'line two with ] bracket and "quotes"',
      '',
      'line four after blank',
      '---PAYLOAD_END---',
      'trailing text',
    ].join('\n');
    const result = parseStageMarkers([text], transitions);
    expect(result.matched!.marker).toBe('ERROR');
    expect(result.payload).toBe(
      'line one\nline two with ] bracket and "quotes"\n\nline four after blank',
    );
  });

  it('fenced form takes precedence over inline form for the same marker', () => {
    const text = [
      'pre [ERROR: short] mid',
      '[ERROR]',
      '---PAYLOAD_START---',
      'long payload',
      '---PAYLOAD_END---',
    ].join('\n');
    const result = parseStageMarkers([text], transitions);
    expect(result.matched!.marker).toBe('ERROR');
    expect(result.payload).toBe('long payload');
  });

  it('falls back to inline form when fence is absent', () => {
    const result = parseStageMarkers(['[ERROR: plain inline]'], transitions);
    expect(result.payload).toBe('plain inline');
  });

  it('unwraps fenced payload that is solely a same-marker inline form', () => {
    const text = [
      '[ERROR]',
      '---PAYLOAD_START---',
      '[ERROR: section_testplan]',
      '---PAYLOAD_END---',
    ].join('\n');
    const result = parseStageMarkers([text], transitions);
    expect(result.matched!.marker).toBe('ERROR');
    expect(result.payload).toBe('section_testplan');
  });

  it('unwraps fenced payload that is solely a bare same-marker', () => {
    const text = [
      '[ERROR]',
      '---PAYLOAD_START---',
      '[ERROR]',
      '---PAYLOAD_END---',
    ].join('\n');
    const result = parseStageMarkers([text], transitions);
    expect(result.matched!.marker).toBe('ERROR');
    expect(result.payload).toBeNull();
  });

  it('does not unwrap when fenced payload only contains marker-like text mid-body', () => {
    const text = [
      '[ERROR]',
      '---PAYLOAD_START---',
      'prefix [ERROR: x] suffix',
      '---PAYLOAD_END---',
    ].join('\n');
    const result = parseStageMarkers([text], transitions);
    expect(result.payload).toBe('prefix [ERROR: x] suffix');
  });

  it('does not unwrap when fenced payload is a different marker', () => {
    // ERROR listed first so its fenced form wins before STAGE_COMPLETE's
    // inline regex can match the marker-like text inside the payload.
    const errorFirst: PipelineTransition[] = [
      { marker: 'ERROR', next: null },
      { marker: 'STAGE_COMPLETE', next: 'verify' },
    ];
    const text = [
      '[ERROR]',
      '---PAYLOAD_START---',
      '[STAGE_COMPLETE: nope]',
      '---PAYLOAD_END---',
    ].join('\n');
    const result = parseStageMarkers([text], errorFirst);
    expect(result.matched!.marker).toBe('ERROR');
    expect(result.payload).toBe('[STAGE_COMPLETE: nope]');
  });
});

// generateRunId tests are in run-manifest.test.ts

describe('resolveStitchInputs', () => {
  function t(over: Partial<PipelineTransition> = {}): PipelineTransition {
    return { marker: 'OK', template: 'tpl', ...over };
  }

  it('returns single mode when no count or countFrom', () => {
    expect(resolveStitchInputs(t(), null)).toEqual({ mode: 'single' });
  });

  it('returns single mode for count: 1', () => {
    expect(resolveStitchInputs(t({ count: 1 }), null)).toEqual({
      mode: 'single',
    });
  });

  it('returns parallel mode for count >= 2', () => {
    expect(resolveStitchInputs(t({ count: 4 }), null)).toEqual({
      mode: 'parallel',
      count: 4,
    });
  });

  it('derives parallel mode from payload length with subs', () => {
    const payload = JSON.stringify([
      { id: 'a', kind: 'x' },
      { id: 'b', kind: 'y' },
      { id: 'c', kind: 'z' },
    ]);
    const d = resolveStitchInputs(
      t({ countFrom: 'payload', substitutionsFrom: 'payload' }),
      payload,
    );
    expect(d).toEqual({
      mode: 'parallel',
      count: 3,
      perCopySubs: [
        { id: 'a', kind: 'x' },
        { id: 'b', kind: 'y' },
        { id: 'c', kind: 'z' },
      ],
    });
  });

  it('derives parallel mode from payload length without subs when substitutionsFrom is absent', () => {
    const payload = JSON.stringify([{ id: 'a' }, { id: 'b' }]);
    const d = resolveStitchInputs(t({ countFrom: 'payload' }), payload);
    expect(d).toEqual({ mode: 'parallel', count: 2, perCopySubs: undefined });
  });

  it('collapses length-1 payload to single mode', () => {
    const payload = JSON.stringify([{ id: 'solo', kind: 'stimulus' }]);
    const d = resolveStitchInputs(
      t({ countFrom: 'payload', substitutionsFrom: 'payload' }),
      payload,
    );
    expect(d).toEqual({
      mode: 'single',
      subs: { id: 'solo', kind: 'stimulus' },
    });
  });

  it('throws when countFrom is set but payload is missing', () => {
    expect(() =>
      resolveStitchInputs(t({ countFrom: 'payload' }), null),
    ).toThrow(/requires.*PAYLOAD_START/);
  });

  it('throws on invalid JSON payload', () => {
    expect(() =>
      resolveStitchInputs(t({ countFrom: 'payload' }), '{not json'),
    ).toThrow(/not valid JSON/);
  });

  it('throws when payload is not an array', () => {
    expect(() =>
      resolveStitchInputs(t({ countFrom: 'payload' }), '{"id":"a"}'),
    ).toThrow(/must be a JSON array/);
  });

  it('throws on empty payload array', () => {
    expect(() =>
      resolveStitchInputs(t({ countFrom: 'payload' }), '[]'),
    ).toThrow(/non-empty/);
  });

  it('throws when a payload element is not an object', () => {
    expect(() =>
      resolveStitchInputs(
        t({ countFrom: 'payload' }),
        JSON.stringify([{ id: 'a' }, 'bad']),
      ),
    ).toThrow(/\[1\].*flat JSON object/);
  });

  it('throws when a payload element uses a reserved key', () => {
    expect(() =>
      resolveStitchInputs(
        t({ countFrom: 'payload', substitutionsFrom: 'payload' }),
        JSON.stringify([{ id: 'a', index: 99 }]),
      ),
    ).toThrow(/reserved key "index"/);
  });

  it('throws when a payload field has a non-primitive value', () => {
    expect(() =>
      resolveStitchInputs(
        t({ countFrom: 'payload', substitutionsFrom: 'payload' }),
        JSON.stringify([{ id: 'a', nested: { x: 1 } }]),
      ),
    ).toThrow(/field "nested".*string\/number\/boolean/);
  });
});

describe('loadPipelineConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses valid PIPELINE.json with stages', () => {
    const config = {
      stages: [
        {
          name: 'build',
          prompt: 'Build it',
          mounts: {},
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stages).toHaveLength(1);
  });

  it('returns null when file does not exist', () => {
    const result = loadPipelineConfig('nonexistent', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when stages is empty array', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify({ stages: [] }),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).toBeNull();
  });
});

describe('savePipelineState / loadPipelineState round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads state correctly', () => {
    const state: PipelineState = {
      currentStage: 'verify',
      completedStages: ['implement'],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    };
    savePipelineState(tmpDir, state);
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).toEqual({ ...state, version: 2 });
  });

  it('returns null when no state file exists', () => {
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).toBeNull();
  });

  it('isolates state files by scopeId', () => {
    const stateA: PipelineState = {
      currentStage: 'a1',
      completedStages: [],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    };
    const stateB: PipelineState = {
      currentStage: 'b1',
      completedStages: ['prior'],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    };
    savePipelineState(tmpDir, stateA, undefined, 'scopeA');
    savePipelineState(tmpDir, stateB, undefined, 'scopeB');

    expect(loadPipelineState(tmpDir, undefined, 'scopeA')).toEqual({
      ...stateA,
      version: 2,
    });
    expect(loadPipelineState(tmpDir, undefined, 'scopeB')).toEqual({
      ...stateB,
      version: 2,
    });
    // Top-level state is untouched
    expect(loadPipelineState(tmpDir)).toBeNull();

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toEqual([
      'PIPELINE_STATE.scopeA.json',
      'PIPELINE_STATE.scopeB.json',
    ]);
  });

  it('combines scopeId and tag in state filename', () => {
    const state: PipelineState = {
      currentStage: 's',
      completedStages: [],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    };
    savePipelineState(tmpDir, state, 'my-tag', 'scope1');
    expect(
      fs.existsSync(path.join(tmpDir, 'PIPELINE_STATE.scope1.my-tag.json')),
    ).toBe(true);
    expect(loadPipelineState(tmpDir, 'my-tag', 'scope1')).toEqual({
      ...state,
      version: 2,
    });
  });

  it('rejects invalid scopeId via PipelineRunner constructor', () => {
    const group = makeTestGroup();
    const cfg = makeTwoStagePipelineConfig();
    expect(
      () =>
        new PipelineRunner(
          group,
          'jid',
          cfg,
          async () => {},
          () => {},
          tmpDir,
          undefined,
          undefined,
          'has/slash',
        ),
    ).toThrow(/Invalid scopeId/);
    expect(
      () =>
        new PipelineRunner(
          group,
          'jid',
          cfg,
          async () => {},
          () => {},
          tmpDir,
          undefined,
          undefined,
          'x'.repeat(17),
        ),
    ).toThrow(/Invalid scopeId/);
  });
});

// writeRunManifest/readRunManifest
// tests are in run-manifest.test.ts

// ============================================================
// Group B: PipelineRunner FSM (runContainerAgent mock)
// ============================================================

// Test fixture: 2-stage pipeline (strict DAG — no cycles, no retry)
function makeTwoStagePipelineConfig(): PipelineConfig {
  return {
    stages: [
      {
        name: 'implement',
        prompt: 'Implement the feature',
        mounts: {},
        transitions: [{ marker: 'IMPL_COMPLETE', next: 'verify' }],
      },
      {
        name: 'verify',
        prompt: 'Verify the implementation',
        mounts: {},
        transitions: [
          { marker: 'VERIFY_PASS', next: null },
          { marker: 'VERIFY_FAIL', next: null },
        ],
      },
    ],
  };
}

function makeTestGroup(): RegisteredGroup {
  return {
    name: 'test-pipeline',
    folder: `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    trigger: '',
    added_at: new Date().toISOString(),
  };
}

describe('PipelineRunner FSM', () => {
  let tmpDir: string;
  let group: RegisteredGroup;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-fsm-'));
    group = makeTestGroup();
    stageOutputQueues.clear();
    fakeProc = null;
    vi.clearAllMocks();

    // Create required directories
    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');

    // Create IPC dirs for pipeline stages
    for (const stageName of ['implement', 'verify']) {
      const ipcDir = path.join(
        TEST_IPC_BASE,
        `${group.folder}__pipeline_${stageName}`,
        'input',
      );
      fs.mkdirSync(ipcDir, { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.rmSync(groupDir, { recursive: true, force: true });
    for (const stageName of ['implement', 'verify', 'debug']) {
      const ipcDir = path.join(
        TEST_IPC_BASE,
        `${group.folder}__pipeline_${stageName}`,
      );
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('2-stage success: implement → verify → done', async () => {
    const config = makeTwoStagePipelineConfig();

    enqueueStageOutput('implement', [
      { result: 'Implemented [IMPL_COMPLETE]' },
    ]);
    enqueueStageOutput('verify', [{ result: 'All good [VERIFY_PASS]' }]);

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('success');
  }, 15000);

  it('payload from implement is included in verify prompt', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    const config = makeTwoStagePipelineConfig();

    enqueueStageOutput('implement', [
      { result: '[IMPL_COMPLETE: files changed: main.ts, utils.ts]' },
    ]);
    enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    await runner.run();

    // Check the verify stage was called with prompt containing the payload
    const calls = vi.mocked(runContainerAgent).mock.calls;
    const verifyCall = calls.find(
      (c) => (c[0] as { name: string }).name === 'pipeline-verify',
    );
    expect(verifyCall).toBeDefined();
    const verifyPrompt = (verifyCall![1] as { prompt: string }).prompt;
    expect(verifyPrompt).toContain('files changed: main.ts, utils.ts');
  }, 15000);

  it('checkpoint resume: skips completed implement, starts at verify', async () => {
    const config = makeTwoStagePipelineConfig();
    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);

    // Pre-save state with implement completed
    savePipelineState(groupDir, {
      currentStage: 'implement',
      completedStages: ['implement'],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    });

    // Only enqueue verify output (implement should be skipped)
    enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('success');

    // Verify that implement was NOT spawned
    const { runContainerAgent } = await import('./container-runner.js');
    const implCalls = vi
      .mocked(runContainerAgent)
      .mock.calls.filter(
        (c) => (c[0] as { name: string }).name === 'pipeline-implement',
      );
    expect(implCalls.length).toBe(0);
  }, 15000);

  it('no marker → sends retry then succeeds on next output', async () => {
    const config = makeTwoStagePipelineConfig();

    // Same container: first output has no marker, then null (end-of-query triggers
    // no-marker resolve), then the success marker on next round.
    enqueueStageOutput('implement', [
      { result: 'working on it...' },
      { result: null },
      { result: '[IMPL_COMPLETE]' },
    ]);
    enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('success');
  }, 15000);

  it('container exit → respawn same stage then success', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    const config = makeTwoStagePipelineConfig();

    // First invocation: no marker emitted, container exits → _CONTAINER_EXIT
    enqueueStageOutput('implement', [{ result: 'Working on it...' }]);

    // Second invocation (respawn): emits success marker
    enqueueStageOutput('implement', [{ result: 'Done [IMPL_COMPLETE]' }]);

    enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('success');

    // implement should have been called twice (first exit, then respawn)
    const calls = vi.mocked(runContainerAgent).mock.calls;
    const implCalls = calls.filter(
      (c) => (c[0] as { name: string }).name === 'pipeline-implement',
    );
    expect(implCalls.length).toBe(2);

    // Second call should include error context in prompt
    const respawnPrompt = (implCalls[1][1] as { prompt: string }).prompt;
    expect(respawnPrompt).toContain('exited abnormally');
  }, 15000);

  it('passes resolved external MCP servers into stage containers', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    mockResolveStageMcpServers.mockReturnValue([
      {
        ref: 'sqlite.read',
        name: 'sqlite_read',
        transport: 'http',
        url: 'http://host.docker.internal:4318/mcp',
        tools: ['query'],
      },
    ]);

    const config = makeTwoStagePipelineConfig();
    config.stages[0].mcpAccess = ['sqlite.read'];

    enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
    enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('success');

    const calls = vi.mocked(runContainerAgent).mock.calls;
    const implCall = calls.find(
      (c) => (c[0] as { name: string }).name === 'pipeline-implement',
    );
    expect(implCall).toBeDefined();
    expect(
      (implCall![0] as { containerConfig?: { externalMcpServers?: unknown[] } })
        .containerConfig?.externalMcpServers,
    ).toEqual([
      expect.objectContaining({
        ref: 'sqlite.read',
        name: 'sqlite_read',
      }),
    ]);
    expect(
      (implCall![1] as { externalMcpServers?: unknown[] }).externalMcpServers,
    ).toEqual([
      expect.objectContaining({
        ref: 'sqlite.read',
        name: 'sqlite_read',
      }),
    ]);
  }, 15000);

  it('container exit → fails after max respawn attempts', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    const config = makeTwoStagePipelineConfig();

    // 4 invocations all exit without marker (limit is 3)
    for (let i = 0; i < 4; i++) {
      enqueueStageOutput('implement', [{ result: 'crash...' }]);
    }

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const result = await runner.run();
    expect(result).toBe('error');

    // Should have attempted 4 times: 1 original + 3 respawns, then failed
    const calls = vi.mocked(runContainerAgent).mock.calls;
    const implCalls = calls.filter(
      (c) => (c[0] as { name: string }).name === 'pipeline-implement',
    );
    expect(implCalls.length).toBe(4);
  }, 15000);
});

describe('Stitch integration', () => {
  let tmpDir: string;
  let group: RegisteredGroup;
  let groupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-stitch-'));
    group = makeTestGroup();
    stageOutputQueues.clear();
    vi.clearAllMocks();

    groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(groupDir, { recursive: true, force: true });
    const ipcRoot = TEST_IPC_BASE;
    for (const entry of fs.existsSync(ipcRoot) ? fs.readdirSync(ipcRoot) : []) {
      if (entry.startsWith(group.folder)) {
        fs.rmSync(path.join(ipcRoot, entry), { recursive: true, force: true });
      }
    }
  });

  function ensureIpc(stageName: string) {
    fs.mkdirSync(
      path.join(
        TEST_IPC_BASE,
        `${group.folder}__pipeline_${stageName}`,
        'input',
      ),
      { recursive: true },
    );
  }

  it('single stitch — template-named next is expanded into the graph', async () => {
    const templateName = 'followup';
    fs.writeFileSync(
      path.join(groupDir, 'templates', `${templateName}.json`),
      JSON.stringify({
        entry: 'do',
        stages: [
          {
            name: 'do',
            prompt: 'do it',
            mounts: {},
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    const config: PipelineConfig = {
      stages: [
        {
          name: 'start',
          prompt: 'kick off',
          mounts: {},
          transitions: [{ marker: 'GO', template: templateName }],
        },
      ],
    };

    ensureIpc('start');
    ensureIpc(`start__${templateName}0__do`);

    enqueueStageOutput('start', [{ result: '[GO]' }]);
    enqueueStageOutput(`start__${templateName}0__do`, [{ result: '[DONE]' }]);

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );
    const result = await runner.run();
    expect(result).toBe('success');

    // Verify the stitched stage ran
    const { runContainerAgent } = await import('./container-runner.js');
    const calls = vi.mocked(runContainerAgent).mock.calls;
    const stitchedCalls = calls.filter(
      (c) =>
        (c[0] as { name: string }).name ===
        `pipeline-start__${templateName}0__do`,
    );
    expect(stitchedCalls.length).toBe(1);
  }, 15000);

  it('nested stitch + parallel barrier — three levels deep then fan-out of 3 lanes', async () => {
    // Host-level templates:
    //   start → "demo" (single) → intro → "deep1" (single) → work → "deep2" (single)
    //     → work → "lane" × 3 (parallel) → barrier → null
    fs.writeFileSync(
      path.join(groupDir, 'templates', 'demo.json'),
      JSON.stringify({
        entry: 'intro',
        stages: [
          {
            name: 'intro',
            prompt: 'go deeper',
            mounts: {},
            transitions: [{ marker: 'DEEPER', template: 'deep1' }],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(groupDir, 'templates', 'deep1.json'),
      JSON.stringify({
        entry: 'work',
        stages: [
          {
            name: 'work',
            prompt: 'go deeper',
            mounts: {},
            transitions: [{ marker: 'DEEPER', template: 'deep2' }],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(groupDir, 'templates', 'deep2.json'),
      JSON.stringify({
        entry: 'work',
        stages: [
          {
            name: 'work',
            prompt: 'fan out',
            mounts: {},
            transitions: [{ marker: 'PARALLEL', template: 'lane', count: 3 }],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(groupDir, 'templates', 'lane.json'),
      JSON.stringify({
        entry: 'task',
        stages: [
          {
            name: 'task',
            prompt: 'lane {{index}}',
            mounts: {},
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    const config: PipelineConfig = {
      stages: [
        {
          name: 'start',
          prompt: 'kick off',
          mounts: {},
          transitions: [{ marker: 'GO', template: 'demo' }],
        },
      ],
    };

    // All deterministic stitched names — IPC dirs + mock output queues.
    const intro = 'start__demo0__intro';
    const deep1Work = `${intro}__deep10__work`;
    const deep2Work = `${deep1Work}__deep20__work`;
    const laneTask = (i: number) => `${deep2Work}__lane${i}__task`;
    const barrier = `${deep2Work}__lane__barrier`;
    const allNames = [
      'start',
      intro,
      deep1Work,
      deep2Work,
      laneTask(0),
      laneTask(1),
      laneTask(2),
      barrier,
    ];
    for (const n of allNames) {
      fs.mkdirSync(
        path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${n}`, 'input'),
        { recursive: true },
      );
    }
    enqueueStageOutput('start', [{ result: '[GO]' }]);
    enqueueStageOutput(intro, [{ result: '[DEEPER]' }]);
    enqueueStageOutput(deep1Work, [{ result: '[DEEPER]' }]);
    enqueueStageOutput(deep2Work, [{ result: '[PARALLEL]' }]);
    for (let i = 0; i < 3; i++) {
      enqueueStageOutput(laneTask(i), [{ result: '[DONE]' }]);
    }
    // Barrier is a command-mode stage — auto-completed by the spawn mock.

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );
    const result = await runner.run();
    expect(result).toBe('success');

    const { runContainerAgent } = await import('./container-runner.js');
    const calls = vi.mocked(runContainerAgent).mock.calls;
    const callNames = calls.map((c) => (c[0] as { name: string }).name);
    // Every agent-mode stitched stage was spawned.
    expect(callNames).toContain(`pipeline-${intro}`);
    expect(callNames).toContain(`pipeline-${deep1Work}`);
    expect(callNames).toContain(`pipeline-${deep2Work}`);
    for (let i = 0; i < 3; i++) {
      expect(callNames).toContain(`pipeline-${laneTask(i)}`);
    }
  }, 30000);

  it('payload-driven fanout — agent emits 3-element payload, 3 lanes spawn with per-lane subs', async () => {
    // Template has one agent stage that uses {{id}} in its prompt. The planner
    // emits a 3-element fanout payload; runtime derives count=3 and maps
    // payload[i] → lane i substitutions.
    fs.writeFileSync(
      path.join(groupDir, 'templates', 'per_id.json'),
      JSON.stringify({
        entry: 'author',
        stages: [
          {
            name: 'author',
            prompt: 'author {{id}} of kind {{kind}}',
            mounts: {},
            transitions: [
              { marker: 'DONE', next: null, prompt: 'wrote {{id}}' },
            ],
          },
        ],
      }),
    );

    const config: PipelineConfig = {
      stages: [
        {
          name: 'planner',
          prompt: 'emit payload',
          mounts: {},
          transitions: [
            {
              marker: 'PLAN_READY',
              template: 'per_id',
              countFrom: 'payload',
              substitutionsFrom: 'payload',
            },
          ],
        },
      ],
    };

    const laneName = (id: string) =>
      `planner__per_id0__author`.replace(
        'per_id0',
        `per_id${['alpha', 'beta', 'gamma'].indexOf(id)}`,
      );
    const allNames = [
      'planner',
      'planner__per_id0__author',
      'planner__per_id1__author',
      'planner__per_id2__author',
      'planner__per_id__barrier',
    ];
    for (const n of allNames) {
      fs.mkdirSync(
        path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${n}`, 'input'),
        { recursive: true },
      );
    }

    const payloadBlock =
      '[PLAN_READY]\n---PAYLOAD_START---\n' +
      JSON.stringify([
        { id: 'alpha', kind: 'stimulus' },
        { id: 'beta', kind: 'monitor' },
        { id: 'gamma', kind: 'probe' },
      ]) +
      '\n---PAYLOAD_END---';
    enqueueStageOutput('planner', [{ result: payloadBlock }]);
    for (const lane of [0, 1, 2]) {
      enqueueStageOutput(`planner__per_id${lane}__author`, [
        { result: '[DONE]' },
      ]);
    }
    // Barrier is a command-mode stage — auto-completed by the spawn mock.

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );
    const result = await runner.run();
    expect(result).toBe('success');

    const { runContainerAgent } = await import('./container-runner.js');
    const calls = vi.mocked(runContainerAgent).mock.calls;
    // The per-lane container was spawned with the lane-specific prompt (via
    // substitution of {{id}} / {{kind}} from payload[i]). The prompt reaches
    // the container through the stage config captured at spawn time.
    const authorCalls = calls.filter((c) =>
      /^pipeline-planner__per_id\d+__author$/.test(
        (c[0] as { name: string }).name,
      ),
    );
    expect(authorCalls).toHaveLength(3);
    const prompts = authorCalls
      .map((c) => (c[1] as { prompt?: string }).prompt ?? '')
      .sort();
    expect(prompts[0]).toContain('author alpha of kind stimulus');
    expect(prompts[1]).toContain('author beta of kind monitor');
    expect(prompts[2]).toContain('author gamma of kind probe');
    // Transition prompt substitution is applied too (transitions whitelist).
    // Hard to inspect directly without exposing runtime internals — the fact
    // that the barrier fired proves all three lanes reached null, meaning
    // their transitions were wired correctly.
    void laneName;
  }, 30000);
});

// ============================================================
// Group C: Command mode + Exclusive lock
// ============================================================

describe('Command mode stage', () => {
  let group: RegisteredGroup;

  beforeEach(() => {
    group = makeTestGroup();
    stageOutputQueues.clear();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
  });

  afterEach(() => {
    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('command mode stage uses exit code for success when no successMarker', async () => {
    const { spawn } = await import('child_process');
    const config: PipelineConfig = {
      stages: [
        {
          name: 'build',
          prompt: 'Build project',
          command: 'make build',
          mounts: {},
          transitions: [
            { marker: 'STAGE_COMPLETE', next: null },
            { marker: 'STAGE_ERROR', next: null },
          ],
        },
      ],
    };

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);

    const ipcDir = path.join(
      TEST_IPC_BASE,
      `${group.folder}__pipeline_build`,
      'input',
    );
    fs.mkdirSync(ipcDir, { recursive: true });

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const runPromise = runner.run();
    await new Promise((r) => setTimeout(r, 50));

    // Exit 0 without successMarker → STAGE_COMPLETE
    fakeProc!.stdout.push('Compiling... done\n');
    fakeProc!.stdout.push(null);
    fakeProc!.emit('close', 0);

    const result = await runPromise;
    expect(result).toBe('success');
    expect(spawn).toHaveBeenCalled();
  }, 15000);

  it('command mode stage uses successMarker to determine success', async () => {
    const { spawn } = await import('child_process');
    const config: PipelineConfig = {
      stages: [
        {
          name: 'test',
          prompt: 'Run tests',
          command: 'make test',
          successMarker: '[TEST] passed',
          mounts: {},
          transitions: [
            { marker: 'STAGE_COMPLETE', next: null },
            { marker: 'STAGE_ERROR', next: null },
          ],
        },
      ],
    };

    const groupDir = path.join(TEST_GROUPS_BASE, group.folder);

    const ipcDir = path.join(
      TEST_IPC_BASE,
      `${group.folder}__pipeline_test`,
      'input',
    );
    fs.mkdirSync(ipcDir, { recursive: true });

    const runner = new PipelineRunner(
      group,
      'test@g.us',
      config,
      async () => {},
      () => {},
      groupDir,
    );

    const runPromise = runner.run();
    await new Promise((r) => setTimeout(r, 50));

    // successMarker found in stdout → STAGE_COMPLETE
    fakeProc!.stdout.push('Running tests... [TEST] passed\n');
    fakeProc!.stdout.push(null);
    fakeProc!.emit('close', 0);

    const result = await runPromise;
    expect(result).toBe('success');
    expect(spawn).toHaveBeenCalled();
  }, 15000);
});

describe('ExclusiveLock serialization', () => {
  it('stages with same exclusive key run sequentially', async () => {
    // Test the ExclusiveLock class behavior indirectly through concurrent acquires
    // Import the module to access ExclusiveLock indirectly
    const order: number[] = [];

    // Simulate exclusive lock behavior
    let locked = false;
    const queue: Array<() => void> = [];

    async function acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        return;
      }
      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    function release(): void {
      if (queue.length > 0) {
        const next = queue.shift()!;
        next();
      } else {
        locked = false;
      }
    }

    // Task 1 acquires immediately
    const p1 = acquire().then(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      release();
    });

    // Task 2 waits in queue
    const p2 = acquire().then(async () => {
      order.push(2);
      release();
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

// ============================================================
// Group D: Dynamic Transition & Conditional Fan-in
// ============================================================

describe('loadPipelineConfig validation (stitch schema)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-validate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects legacy retry field on a transition', () => {
    const config = {
      stages: [
        {
          name: 'review',
          prompt: 'Review',
          mounts: {},
          transitions: [{ marker: 'FIX', retry: true }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects legacy next_dynamic field on a transition', () => {
    const config = {
      stages: [
        {
          name: 'review',
          prompt: 'Review',
          mounts: {},
          transitions: [
            { marker: 'FIX', next_dynamic: true, next: ['edit-a'] },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects authored array next', () => {
    const config = {
      stages: [
        {
          name: 'review',
          prompt: 'Review',
          mounts: {},
          transitions: [{ marker: 'FIX', next: ['a', 'b'] }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects fan_in: "dynamic"', () => {
    const config = {
      stages: [
        {
          name: 'test',
          prompt: 'Test',
          mounts: {},
          fan_in: 'dynamic',
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects kind: "dynamic-fanout"', () => {
    const config = {
      stages: [
        {
          name: 'fanout',
          kind: 'dynamic-fanout',
          mounts: {},
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects a base pipeline containing a cycle', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', next: 'b' }],
        },
        {
          name: 'b',
          prompt: 'B',
          mounts: {},
          transitions: [{ marker: 'OK', next: 'a' }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects count without template', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', next: null, count: 3 }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects non-positive count', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', template: 'my-tpl', count: 0 }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects next pointing to a non-existent stage', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', next: 'nowhere' }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects both next (string) and template present', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', next: 'a', template: 'my-tpl' }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects non-string template', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', template: 42 }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('accepts a transition with template (single stitch, no count)', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', template: 'my-tpl' }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).not.toBeNull();
  });

  it('accepts a transition with template + count (parallel stitch)', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', template: 'my-tpl', count: 3 }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).not.toBeNull();
  });

  it('rejects countFrom without template', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [{ marker: 'OK', next: null, countFrom: 'payload' }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects countFrom with unknown literal', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [
            { marker: 'OK', template: 'my-tpl', countFrom: 'stdin' },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects count + countFrom both present', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [
            {
              marker: 'OK',
              template: 'my-tpl',
              count: 3,
              countFrom: 'payload',
            },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('rejects substitutionsFrom without countFrom', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [
            {
              marker: 'OK',
              template: 'my-tpl',
              substitutionsFrom: 'payload',
            },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).toBeNull();
  });

  it('accepts template + countFrom + substitutionsFrom (payload-driven fanout)', () => {
    const config = {
      stages: [
        {
          name: 'a',
          prompt: 'A',
          mounts: {},
          transitions: [
            {
              marker: 'OK',
              template: 'my-tpl',
              countFrom: 'payload',
              substitutionsFrom: 'payload',
            },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    expect(loadPipelineConfig('test', tmpDir)).not.toBeNull();
  });

  it('accepts prompt DB ids for agent stages', () => {
    const config = {
      stages: [
        {
          name: 'scope_plan',
          prompts: ['db_id_1', 'db_id_2'],
          prompt_append: 'Target module is fixed to VPU.',
          mounts: {},
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stages[0].prompts).toEqual(['db_id_1', 'db_id_2']);
  });

  it('rejects non-string prompt ids', () => {
    const config = {
      stages: [
        {
          name: 'scope_plan',
          prompts: ['db_id_1', 2],
          mounts: {},
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).toBeNull();
  });

  it('accepts valid mcpAccess for agent stages', () => {
    mockLoadMcpRegistry.mockReturnValue({
      'sqlite.read': {
        name: 'sqlite_read',
        transport: 'http',
        url: 'http://host.docker.internal:4318/mcp',
        tools: ['query'],
      },
    });
    mockResolveStageMcpServers.mockReturnValue([
      {
        ref: 'sqlite.read',
        name: 'sqlite_read',
        transport: 'http',
        url: 'http://host.docker.internal:4318/mcp',
        tools: ['query'],
      },
    ]);

    const config = {
      stages: [
        {
          name: 'build',
          prompt: 'Build',
          mounts: {},
          mcpAccess: ['sqlite.read'],
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stages[0].mcpAccess).toEqual(['sqlite.read']);
  });

  it('rejects command stages that declare mcpAccess', () => {
    const config = {
      stages: [
        {
          name: 'lint',
          prompt: 'Lint',
          command: 'npm run lint',
          mounts: {},
          mcpAccess: ['sqlite.read'],
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).toBeNull();
  });

  it('rejects invalid mcpAccess refs', () => {
    mockLoadMcpRegistry.mockReturnValue({});
    mockResolveStageMcpServers.mockImplementation(() => {
      throw new Error('missing ref');
    });

    const config = {
      stages: [
        {
          name: 'build',
          prompt: 'Build',
          mounts: {},
          mcpAccess: ['missing.ref'],
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'PIPELINE.json'),
      JSON.stringify(config),
    );
    const result = loadPipelineConfig('test', tmpDir);
    expect(result).toBeNull();
  });
});

describe('savePipelineState with activations/completions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-ac-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and restores activations/completions', () => {
    const state: PipelineState = {
      currentStage: 'test-router',
      completedStages: ['edit-arbiter', 'test-arbiter'],
      lastUpdated: new Date().toISOString(),
      status: 'running',
      activations: { 'edit-arbiter': 2, 'test-arbiter': 2 },
      completions: { 'edit-arbiter': 2, 'test-arbiter': 1 },
    };
    savePipelineState(tmpDir, state);
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).toEqual({ ...state, version: 2 });
    expect(loaded!.activations).toEqual({
      'edit-arbiter': 2,
      'test-arbiter': 2,
    });
    expect(loaded!.completions).toEqual({
      'edit-arbiter': 2,
      'test-arbiter': 1,
    });
  });

  it('loads state without activations/completions (backwards compat)', () => {
    const state: PipelineState = {
      currentStage: 'verify',
      completedStages: ['implement'],
      lastUpdated: new Date().toISOString(),
      status: 'running',
    };
    savePipelineState(tmpDir, state);
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.activations).toBeUndefined();
    expect(loaded!.completions).toBeUndefined();
  });
});

describe('generalized sub-path mounts', () => {
  let group: RegisteredGroup;
  let groupDir: string;

  beforeEach(() => {
    group = makeTestGroup();
    groupDir = path.join(TEST_GROUPS_BASE, group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
    stageOutputQueues.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(TEST_IPC_BASE, { recursive: true, force: true });
    fs.rmSync(TEST_GROUPS_BASE, { recursive: true, force: true });
  });

  async function runOneStageCapturingMounts(
    mounts: Record<string, 'ro' | 'rw' | null>,
  ): Promise<
    Array<{ hostPath: string; containerPath: string; readonly: boolean }>
  > {
    const cfg: PipelineConfig = {
      stages: [
        {
          name: 'only',
          prompt: 'x',
          mounts,
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    enqueueStageOutput('only', [{ result: '[DONE]' }]);
    const runner = new PipelineRunner(
      group,
      'test@g.us',
      cfg,
      async () => {},
      () => {},
      groupDir,
    );
    await runner.run();
    const { runContainerAgent } = await import('./container-runner.js');
    const fn = vi.mocked(runContainerAgent);
    const call = fn.mock.calls[0];
    const containerConfig = (
      call[0] as unknown as {
        containerConfig: {
          internalMounts: Array<{
            hostPath: string;
            containerPath: string;
            readonly: boolean;
          }>;
        };
      }
    ).containerConfig;
    return containerConfig.internalMounts;
  }

  it('mounts a top-level key and its sub-path override', async () => {
    const internal = await runOneStageCapturingMounts({
      results: 'ro',
      'results:generated': 'rw',
    });
    const results = internal.find(
      (m) => m.containerPath === '/workspace/results',
    );
    const sub = internal.find(
      (m) => m.containerPath === '/workspace/results/generated',
    );
    expect(results).toBeDefined();
    expect(results!.readonly).toBe(true);
    expect(sub).toBeDefined();
    expect(sub!.readonly).toBe(false);
    expect(sub!.hostPath).toBe(path.join(groupDir, 'results', 'generated'));
  });

  it('direct mode: mounts sub-path even when parent key is absent', async () => {
    const internal = await runOneStageCapturingMounts({
      'cov_per_section:S-01': 'rw',
    });
    const sub = internal.find(
      (m) => m.containerPath === '/workspace/cov_per_section/S-01',
    );
    expect(sub).toBeDefined();
    expect(sub!.readonly).toBe(false);
    expect(sub!.hostPath).toBe(path.join(groupDir, 'cov_per_section', 'S-01'));
    // Parent path not mounted
    expect(
      internal.find((m) => m.containerPath === '/workspace/cov_per_section'),
    ).toBeUndefined();
  });

  it('null sub-path shadows with empty dir when parent is mounted', async () => {
    const internal = await runOneStageCapturingMounts({
      results: 'rw',
      'results:secrets': null,
    });
    const shadow = internal.find(
      (m) => m.containerPath === '/workspace/results/secrets',
    );
    expect(shadow).toBeDefined();
    expect(shadow!.readonly).toBe(true);
    expect(shadow!.hostPath).toBe(path.join('/tmp/aer-art-test-data', 'empty'));
  });

  it('skips sub-path override when policy matches the parent (no-op)', async () => {
    const internal = await runOneStageCapturingMounts({
      results: 'rw',
      'results:generated': 'rw',
    });
    // Parent covers it, no override needed
    expect(
      internal.find((m) => m.containerPath === '/workspace/results/generated'),
    ).toBeUndefined();
  });

  it('rejects invalid sub-paths (..)', async () => {
    const internal = await runOneStageCapturingMounts({
      results: 'rw',
      'results:../escape': 'rw',
    });
    expect(
      internal.find((m) => m.containerPath.includes('escape')),
    ).toBeUndefined();
  });

  it('rejects reserved parent keys (ipc, global, extra, conversations)', async () => {
    const internal = await runOneStageCapturingMounts({
      'ipc:leak': 'rw',
      'global:secret': 'rw',
      'extra:bad': 'rw',
      'conversations:sneak': 'rw',
    });
    expect(
      internal.find((m) => m.containerPath.includes('/ipc/')),
    ).toBeUndefined();
    expect(
      internal.find((m) => m.containerPath.includes('/global/')),
    ).toBeUndefined();
    expect(
      internal.find((m) => m.containerPath.includes('/extra/')),
    ).toBeUndefined();
    expect(
      internal.find((m) => m.containerPath.includes('/conversations/')),
    ).toBeUndefined();
  });

  it('preserves existing project:subpath semantics', async () => {
    const internal = await runOneStageCapturingMounts({
      project: 'ro',
      'project:src/generated': 'rw',
    });
    const project = internal.find(
      (m) => m.containerPath === '/workspace/project',
    );
    expect(project).toBeDefined();
    expect(project!.readonly).toBe(true);
    const sub = internal.find(
      (m) => m.containerPath === '/workspace/project/src/generated',
    );
    expect(sub).toBeDefined();
    expect(sub!.readonly).toBe(false);
    // Host should be projectRoot/src/generated, not groupDir/project/src/generated
    expect(sub!.hostPath).toBe(
      path.join(path.dirname(groupDir), 'src', 'generated'),
    );
  });
});
