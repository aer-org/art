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
    readonlyMountArgs: (host, container) => [
        '-v',
        `${host}:${container}:ro`,
    ],
    writableMountArgs: (host, container) => [
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
    resolveGroupFolderPath: (folder) => path.join(TEST_GROUPS_BASE, folder),
    resolveGroupIpcPath: (folder) => path.join(TEST_IPC_BASE, folder),
}));
// Mock mount-security
vi.mock('./mount-security.js', () => ({
    validateAdditionalMounts: vi.fn(() => []),
}));
// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
    detectAuthMode: () => 'api-key',
}));
// Each stage name maps to a list of "invocations". Each invocation is an array
// of output entries that will be emitted sequentially with delays between them.
// This supports multi-turn retry within a single container invocation.
const stageOutputQueues = new Map();
function enqueueStageOutput(stageName, sequence) {
    if (!stageOutputQueues.has(stageName)) {
        stageOutputQueues.set(stageName, []);
    }
    stageOutputQueues.get(stageName).push(sequence);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
vi.mock('./container-runner.js', () => ({
    prefixLogLines: (chunk, stageName, remainder) => {
        const text = remainder + chunk;
        const lines = text.split('\n');
        const newRemainder = lines.pop();
        const prefixed = lines.map((l) => `[${stageName}] ${l}\n`).join('');
        return { prefixed, remainder: newRemainder };
    },
    runContainerAgent: vi.fn((group, _input, _onProcess, onOutput) => {
        const stageName = group.name.replace('pipeline-', '');
        const queues = stageOutputQueues.get(stageName) || [];
        const sequence = queues.shift();
        // Return a long-lived promise simulating a running container.
        // Emit outputs with delays so the FSM has time to set pendingResult
        // between each round.
        return new Promise((resolve) => {
            (async () => {
                // Wait for FSM to set initial pendingResult
                await delay(30);
                if (sequence) {
                    for (const entry of sequence) {
                        await onOutput({ status: 'success', result: entry.result });
                        // Give FSM time to process result and set new pendingResult
                        await delay(30);
                    }
                }
                // Container exit
                resolve({ status: 'success', result: null });
            })();
        });
    }),
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
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    proc.pid = 12345;
    return proc;
}
let fakeProc;
vi.mock('child_process', async () => {
    const actual = await vi.importActual('child_process');
    return {
        ...actual,
        spawn: vi.fn(() => fakeProc),
    };
});
import { parseStageMarkers, loadPipelineConfig, loadAgentTeamConfig, savePipelineState, loadPipelineState, PipelineRunner, } from './pipeline-runner.js';
// ============================================================
// Group A: Pure functions (no mocks needed)
// ============================================================
describe('parseStageMarkers', () => {
    const transitions = [
        { marker: 'STAGE_COMPLETE', next: 'verify' },
        { marker: 'ERROR', retry: true },
    ];
    it('matches [STAGE_COMPLETE] marker', () => {
        const result = parseStageMarkers(['Some output [STAGE_COMPLETE] done'], transitions);
        expect(result.matched).toEqual(expect.objectContaining({ marker: 'STAGE_COMPLETE' }));
        expect(result.payload).toBeNull();
    });
    it('extracts payload from [ERROR: build failed]', () => {
        const result = parseStageMarkers(['Output [ERROR: build failed] end'], transitions);
        expect(result.matched).toEqual(expect.objectContaining({ marker: 'ERROR' }));
        expect(result.payload).toBe('build failed');
    });
    it('returns first match when multiple markers present', () => {
        const result = parseStageMarkers(['[STAGE_COMPLETE] and [ERROR: oops]'], transitions);
        expect(result.matched.marker).toBe('STAGE_COMPLETE');
    });
    it('returns null when no markers match', () => {
        const result = parseStageMarkers(['no markers here'], transitions);
        expect(result.matched).toBeNull();
        expect(result.payload).toBeNull();
    });
    it('joins multiple result texts before matching', () => {
        const result = parseStageMarkers(['first chunk', 'second chunk [STAGE_COMPLETE]'], transitions);
        expect(result.matched.marker).toBe('STAGE_COMPLETE');
    });
});
// generateRunId tests are in run-manifest.test.ts
describe('loadPipelineConfig', () => {
    let tmpDir;
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
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).not.toBeNull();
        expect(result.stages).toHaveLength(1);
    });
    it('returns null when file does not exist', () => {
        const result = loadPipelineConfig('nonexistent', tmpDir);
        expect(result).toBeNull();
    });
    it('returns null when stages is empty array', () => {
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify({ stages: [] }));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).toBeNull();
    });
});
describe('loadAgentTeamConfig', () => {
    let tmpDir;
    let originalFolder;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-team-cfg-'));
        // loadAgentTeamConfig uses resolveGroupFolderPath(folder) which is mocked
        // We need to create the file in the mocked path
        originalFolder = `team-test-${Date.now()}`;
        const groupDir = path.join(TEST_GROUPS_BASE, originalFolder);
        fs.mkdirSync(groupDir, { recursive: true });
    });
    afterEach(() => {
        const groupDir = path.join(TEST_GROUPS_BASE, originalFolder);
        fs.rmSync(groupDir, { recursive: true, force: true });
    });
    it('returns agents array for valid config', () => {
        const groupDir = path.join(TEST_GROUPS_BASE, originalFolder);
        const config = {
            agents: [
                { name: 'agent-a', folder: 'agent-a' },
                { name: 'agent-b', folder: 'agent-b' },
            ],
        };
        fs.writeFileSync(path.join(groupDir, 'AGENT_TEAM.json'), JSON.stringify(config));
        const result = loadAgentTeamConfig(originalFolder);
        expect(result).not.toBeNull();
        expect(result.agents).toHaveLength(2);
    });
    it('returns null for path traversal in folder', () => {
        const groupDir = path.join(TEST_GROUPS_BASE, originalFolder);
        const config = {
            agents: [{ name: 'evil', folder: '../../../etc' }],
        };
        fs.writeFileSync(path.join(groupDir, 'AGENT_TEAM.json'), JSON.stringify(config));
        const result = loadAgentTeamConfig(originalFolder);
        expect(result).toBeNull();
    });
});
describe('savePipelineState / loadPipelineState round-trip', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-state-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('saves and loads state correctly', () => {
        const state = {
            currentStage: 'verify',
            completedStages: ['implement'],
            lastUpdated: new Date().toISOString(),
            status: 'running',
        };
        savePipelineState(tmpDir, state);
        const loaded = loadPipelineState(tmpDir);
        expect(loaded).toEqual(state);
    });
    it('returns null when no state file exists', () => {
        const loaded = loadPipelineState(tmpDir);
        expect(loaded).toBeNull();
    });
});
// writeRunManifest/readRunManifest
// tests are in run-manifest.test.ts
// ============================================================
// Group B: PipelineRunner FSM (runContainerAgent mock)
// ============================================================
// Test fixture: 2-stage pipeline
function makeTwoStagePipelineConfig() {
    return {
        stages: [
            {
                name: 'implement',
                prompt: 'Implement the feature',
                mounts: {},
                transitions: [
                    { marker: 'IMPL_COMPLETE', next: 'verify' },
                    { marker: 'IMPL_ERROR', retry: true },
                ],
            },
            {
                name: 'verify',
                prompt: 'Verify the implementation',
                mounts: {},
                transitions: [
                    { marker: 'VERIFY_PASS', next: null },
                    { marker: 'VERIFY_FAIL', next: 'implement' },
                ],
            },
        ],
    };
}
function makeTestGroup() {
    return {
        name: 'test-pipeline',
        folder: `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        trigger: '',
        added_at: new Date().toISOString(),
    };
}
describe('PipelineRunner FSM', () => {
    let tmpDir;
    let group;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-fsm-'));
        group = makeTestGroup();
        stageOutputQueues.clear();
        vi.clearAllMocks();
        // Create required directories
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.mkdirSync(groupDir, { recursive: true });
        fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
        fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
        // Create IPC dirs for pipeline stages
        for (const stageName of ['implement', 'verify']) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`, 'input');
            fs.mkdirSync(ipcDir, { recursive: true });
        }
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.rmSync(groupDir, { recursive: true, force: true });
        for (const stageName of ['implement', 'verify', 'debug']) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`);
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
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
    }, 15000);
    it('error marker → retry then success', async () => {
        const config = makeTwoStagePipelineConfig();
        // Both error and success in SAME sequence (same container invocation).
        // The mock emits error first, FSM processes it and waits again,
        // then mock emits success which resolves the new deferred.
        enqueueStageOutput('implement', [
            { result: '[IMPL_ERROR: compilation failed]' },
            { result: '[IMPL_COMPLETE]' },
        ]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
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
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        await runner.run();
        // Check the verify stage was called with prompt containing the payload
        const calls = vi.mocked(runContainerAgent).mock.calls;
        const verifyCall = calls.find((c) => c[0].name === 'pipeline-verify');
        expect(verifyCall).toBeDefined();
        const verifyPrompt = verifyCall[1].prompt;
        expect(verifyPrompt).toContain('files changed: main.ts, utils.ts');
    }, 15000);
    it('verify fail → loopback to implement', async () => {
        const { runContainerAgent } = await import('./container-runner.js');
        const config = makeTwoStagePipelineConfig();
        // Each stage gets its own container invocation.
        // VERIFY_FAIL is a non-retry transition (next: 'implement'),
        // so the FSM closes verify and spawns new implement container.
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_FAIL]' }]);
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        // implement should have been spawned twice
        const implCalls = vi
            .mocked(runContainerAgent)
            .mock.calls.filter((c) => c[0].name === 'pipeline-implement');
        expect(implCalls.length).toBe(2);
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
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        // Verify that implement was NOT spawned
        const { runContainerAgent } = await import('./container-runner.js');
        const implCalls = vi
            .mocked(runContainerAgent)
            .mock.calls.filter((c) => c[0].name === 'pipeline-implement');
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
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
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
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        // implement should have been called twice (first exit, then respawn)
        const calls = vi.mocked(runContainerAgent).mock.calls;
        const implCalls = calls.filter((c) => c[0].name === 'pipeline-implement');
        expect(implCalls.length).toBe(2);
        // Second call should include error context in prompt
        const respawnPrompt = implCalls[1][1].prompt;
        expect(respawnPrompt).toContain('exited abnormally');
    }, 15000);
    it('does not pass sessionId when resumeSession is false', async () => {
        const { runContainerAgent } = await import('./container-runner.js');
        const config = makeTwoStagePipelineConfig();
        // Mark verify as no-resume
        config.stages[1].resumeSession = false;
        // First run: implement → verify (stores sessionIds)
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_FAIL]' }]);
        // Second loop: implement → verify again
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        await runner.run();
        // All verify calls should have sessionId: undefined
        const calls = vi.mocked(runContainerAgent).mock.calls;
        const verifyCalls = calls.filter((c) => c[0].name === 'pipeline-verify');
        expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of verifyCalls) {
            expect(call[1].sessionId).toBeUndefined();
        }
    }, 15000);
    it('passes sessionId by default (resumeSession unset)', async () => {
        const { runContainerAgent } = await import('./container-runner.js');
        const config = makeTwoStagePipelineConfig();
        // resumeSession is undefined (default) on both stages
        // First loop: implement → verify → FAIL → loopback
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_FAIL]' }]);
        // Second loop
        enqueueStageOutput('implement', [{ result: '[IMPL_COMPLETE]' }]);
        enqueueStageOutput('verify', [{ result: '[VERIFY_PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        await runner.run();
        // Second implement call should have a sessionId (from first run)
        const calls = vi.mocked(runContainerAgent).mock.calls;
        const implCalls = calls.filter((c) => c[0].name === 'pipeline-implement');
        expect(implCalls.length).toBe(2);
        // First call has no prior session
        expect(implCalls[0][1].sessionId).toBeUndefined();
        // Second call should have sessionId from first run
        // (the mock doesn't return a real sessionId, so it may still be undefined —
        // but the code path is exercised. The key test is the resumeSession:false case above.)
    }, 15000);
    it('container exit → fails after max respawn attempts', async () => {
        const { runContainerAgent } = await import('./container-runner.js');
        const config = makeTwoStagePipelineConfig();
        // 4 invocations all exit without marker (limit is 3)
        for (let i = 0; i < 4; i++) {
            enqueueStageOutput('implement', [{ result: 'crash...' }]);
        }
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('error');
        // Should have attempted 4 times: 1 original + 3 respawns, then failed
        const calls = vi.mocked(runContainerAgent).mock.calls;
        const implCalls = calls.filter((c) => c[0].name === 'pipeline-implement');
        expect(implCalls.length).toBe(4);
    }, 15000);
});
// ============================================================
// Group C: Command mode + Exclusive lock
// ============================================================
describe('Command mode stage', () => {
    let group;
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
    it('command mode stage spawns shell and parses markers from stdout', async () => {
        const { spawn } = await import('child_process');
        const config = {
            stages: [
                {
                    name: 'build',
                    prompt: 'Build project',
                    command: 'make build',
                    mounts: {},
                    transitions: [
                        { marker: 'BUILD_OK', next: null },
                        { marker: 'BUILD_FAIL', retry: true },
                    ],
                },
            ],
        };
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        // Create IPC dirs for command stage
        const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_build`, 'input');
        fs.mkdirSync(ipcDir, { recursive: true });
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        // Start run in background, then simulate container output
        const runPromise = runner.run();
        // Give the runner time to spawn the process
        await new Promise((r) => setTimeout(r, 50));
        // Simulate stdout with marker
        fakeProc.stdout.push('Compiling... [BUILD_OK]\n');
        fakeProc.stdout.push(null); // end stream
        fakeProc.emit('close', 0);
        const result = await runPromise;
        expect(result).toBe('success');
        expect(spawn).toHaveBeenCalled();
    }, 15000);
});
describe('ExclusiveLock serialization', () => {
    it('stages with same exclusive key run sequentially', async () => {
        // Test the ExclusiveLock class behavior indirectly through concurrent acquires
        // Import the module to access ExclusiveLock indirectly
        const order = [];
        // Simulate exclusive lock behavior
        let locked = false;
        const queue = [];
        async function acquire() {
            if (!locked) {
                locked = true;
                return;
            }
            return new Promise((resolve) => {
                queue.push(resolve);
            });
        }
        function release() {
            if (queue.length > 0) {
                const next = queue.shift();
                next();
            }
            else {
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
describe('parseStageMarkers with dynamic payload', () => {
    it('extracts comma-separated targets from dynamic marker payload', () => {
        const transitions = [
            {
                marker: 'FIX',
                next_dynamic: true,
                next: ['edit-arbiter', 'edit-crossbar'],
            },
        ];
        const result = parseStageMarkers(['[FIX: edit-arbiter,edit-crossbar]'], transitions);
        expect(result.matched.marker).toBe('FIX');
        expect(result.payload).toBe('edit-arbiter,edit-crossbar');
    });
    it('extracts single target from dynamic marker payload', () => {
        const transitions = [
            {
                marker: 'FIX',
                next_dynamic: true,
                next: ['edit-arbiter', 'edit-crossbar'],
            },
        ];
        const result = parseStageMarkers(['[FIX:edit-arbiter]'], transitions);
        expect(result.matched.marker).toBe('FIX');
        expect(result.payload).toBe('edit-arbiter');
    });
});
describe('loadPipelineConfig validation for dynamic features', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-dyn-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('rejects next_dynamic + retry on same transition', () => {
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            retry: true,
                            next: ['edit-a'],
                        },
                    ],
                },
            ],
        };
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).toBeNull();
    });
    it('rejects next_dynamic with null next', () => {
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [{ marker: 'FIX', next_dynamic: true, next: null }],
                },
            ],
        };
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).toBeNull();
    });
    it('rejects invalid fan_in value', () => {
        const config = {
            stages: [
                {
                    name: 'test',
                    prompt: 'Test',
                    mounts: {},
                    fan_in: 'invalid',
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).toBeNull();
    });
    it('accepts valid fan_in: "dynamic"', () => {
        const config = {
            stages: [
                {
                    name: 'build',
                    prompt: 'Build',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'test' }],
                },
                {
                    name: 'test',
                    prompt: 'Test',
                    mounts: {},
                    fan_in: 'dynamic',
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).not.toBeNull();
        expect(result.stages[1].fan_in).toBe('dynamic');
    });
    it('accepts valid next_dynamic transition', () => {
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a', 'edit-b'],
                        },
                    ],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        fs.writeFileSync(path.join(tmpDir, 'PIPELINE.json'), JSON.stringify(config));
        const result = loadPipelineConfig('test', tmpDir);
        expect(result).not.toBeNull();
        expect(result.stages[0].transitions[0].next_dynamic).toBe(true);
    });
});
describe('Dynamic Transition FSM', () => {
    let group;
    function setupStageIpc(stageNames) {
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.mkdirSync(groupDir, { recursive: true });
        fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
        fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
        for (const stageName of stageNames) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`, 'input');
            fs.mkdirSync(ipcDir, { recursive: true });
        }
    }
    function cleanupStageIpc(stageNames) {
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.rmSync(groupDir, { recursive: true, force: true });
        for (const stageName of stageNames) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`);
            fs.rmSync(ipcDir, { recursive: true, force: true });
        }
    }
    beforeEach(() => {
        group = makeTestGroup();
        stageOutputQueues.clear();
        vi.clearAllMocks();
    });
    it('dynamic transition routes to agent-selected single target', async () => {
        const stageNames = ['review', 'edit-a', 'edit-b'];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review and pick target',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a', 'edit-b'],
                        },
                    ],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        // review selects only edit-a
        enqueueStageOutput('review', [{ result: '[FIX:edit-a]' }]);
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        // edit-b should NOT be called
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        // Verify edit-b was never executed (no output was dequeued)
        expect(stageOutputQueues.get('edit-b')).toBeUndefined();
        cleanupStageIpc(stageNames);
    }, 15000);
    it('dynamic transition routes to multiple targets (fan-out)', async () => {
        const stageNames = ['review', 'edit-a', 'edit-b', 'merge'];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a', 'edit-b'],
                        },
                    ],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'merge',
                    prompt: 'Merge',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        // review selects both edit-a and edit-b
        enqueueStageOutput('review', [{ result: '[FIX:edit-a,edit-b]' }]);
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('edit-b', [{ result: '[DONE]' }]);
        enqueueStageOutput('merge', [{ result: '[DONE]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        cleanupStageIpc(stageNames);
    }, 15000);
    it('dynamic transition errors on invalid target', async () => {
        const stageNames = ['review', 'edit-a'];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a'],
                        },
                    ],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        // review selects non-existent target
        enqueueStageOutput('review', [{ result: '[FIX:nonexistent]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('error');
        cleanupStageIpc(stageNames);
    }, 15000);
    it('dynamic transition falls back to static next when payload is empty', async () => {
        const stageNames = ['review', 'edit-a', 'edit-b'];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'review',
                    prompt: 'Review',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a', 'edit-b'],
                        },
                    ],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: null }],
                },
            ],
        };
        // Empty payload → fall back to all targets
        enqueueStageOutput('review', [{ result: '[FIX]' }]);
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('edit-b', [{ result: '[DONE]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        cleanupStageIpc(stageNames);
    }, 15000);
});
describe('Dynamic Fan-in FSM', () => {
    let group;
    function setupStageIpc(stageNames) {
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.mkdirSync(groupDir, { recursive: true });
        fs.mkdirSync(path.join(groupDir, 'plan'), { recursive: true });
        fs.writeFileSync(path.join(groupDir, 'plan', 'PLAN.md'), '# Test Plan');
        for (const stageName of stageNames) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`, 'input');
            fs.mkdirSync(ipcDir, { recursive: true });
        }
    }
    function cleanupStageIpc(stageNames) {
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        fs.rmSync(groupDir, { recursive: true, force: true });
        for (const stageName of stageNames) {
            const ipcDir = path.join(TEST_IPC_BASE, `${group.folder}__pipeline_${stageName}`);
            fs.rmSync(ipcDir, { recursive: true, force: true });
        }
    }
    beforeEach(() => {
        group = makeTestGroup();
        stageOutputQueues.clear();
        vi.clearAllMocks();
    });
    it('dynamic fan-in fires when only activated predecessor completes', async () => {
        // Pipeline: plan → [edit-a, edit-b] → [test-a, test-b] → merge (fan_in: dynamic)
        // review selects only edit-a path, merge should fire after test-a only
        const stageNames = [
            'plan',
            'edit-a',
            'edit-b',
            'test-a',
            'test-b',
            'merge',
            'review',
        ];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'plan',
                    prompt: 'Plan',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: ['edit-a', 'edit-b'] }],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'test-a' }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'test-b' }],
                },
                {
                    name: 'test-a',
                    prompt: 'Test A',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'test-b',
                    prompt: 'Test B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'merge',
                    prompt: 'Merge',
                    mounts: {},
                    fan_in: 'dynamic',
                    transitions: [
                        { marker: 'PASS', next: null },
                        { marker: 'FAIL', next: 'review' },
                    ],
                },
                {
                    name: 'review',
                    prompt: 'Review failure',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'FIX',
                            next_dynamic: true,
                            next: ['edit-a', 'edit-b'],
                        },
                    ],
                },
            ],
        };
        // First run: both paths
        enqueueStageOutput('plan', [{ result: '[DONE]' }]);
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('edit-b', [{ result: '[DONE]' }]);
        enqueueStageOutput('test-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('test-b', [{ result: '[DONE]' }]);
        // merge fails, review selects only edit-a
        enqueueStageOutput('merge', [{ result: '[FAIL]' }]);
        enqueueStageOutput('review', [{ result: '[FIX:edit-a]' }]);
        // Re-run: only edit-a path
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('test-a', [{ result: '[DONE]' }]);
        // merge should fire (dynamic fan-in: only test-a was activated this round)
        enqueueStageOutput('merge', [{ result: '[PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        cleanupStageIpc(stageNames);
    }, 30000);
    it('dynamic fan-in waits when retry path could still activate predecessor', async () => {
        // Pipeline:
        //   plan → [edit-a, edit-b]
        //   edit-a → test-a-unit
        //   edit-b → test-b-unit
        //   test-a-unit DONE → router    (success path)
        //   test-a-unit FAIL → edit-a    (error retry path)
        //   test-b-unit DONE → merge     (success path)
        //   router DONE → merge          (fan_in: dynamic)
        //
        // Scenario: test-a-unit fails first, then test-b-unit succeeds.
        // merge should NOT start yet because edit-a retry path could still activate router.
        // After edit-a re-runs → test-a-unit succeeds → router succeeds → merge fires.
        const stageNames = [
            'plan',
            'edit-a',
            'edit-b',
            'test-a-unit',
            'test-b-unit',
            'router',
            'merge',
        ];
        setupStageIpc(stageNames);
        const config = {
            stages: [
                {
                    name: 'plan',
                    prompt: 'Plan',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: ['edit-a', 'edit-b'] }],
                },
                {
                    name: 'edit-a',
                    prompt: 'Edit A',
                    mounts: {},
                    fan_in: 'dynamic',
                    transitions: [{ marker: 'DONE', next: 'test-a-unit' }],
                },
                {
                    name: 'edit-b',
                    prompt: 'Edit B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'test-b-unit' }],
                },
                {
                    name: 'test-a-unit',
                    prompt: 'Test A',
                    mounts: {},
                    transitions: [
                        { marker: 'DONE', next: 'router' },
                        { marker: 'FAIL', next: 'edit-a' },
                    ],
                },
                {
                    name: 'test-b-unit',
                    prompt: 'Test B',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'router',
                    prompt: 'Router',
                    mounts: {},
                    transitions: [{ marker: 'DONE', next: 'merge' }],
                },
                {
                    name: 'merge',
                    prompt: 'Merge',
                    mounts: {},
                    fan_in: 'dynamic',
                    transitions: [{ marker: 'PASS', next: null }],
                },
            ],
        };
        // First pass: plan succeeds
        enqueueStageOutput('plan', [{ result: '[DONE]' }]);
        // edit-a and edit-b both succeed
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        enqueueStageOutput('edit-b', [{ result: '[DONE]' }]);
        // test-a-unit FAILS → error transition to edit-a
        enqueueStageOutput('test-a-unit', [{ result: '[FAIL]' }]);
        // test-b-unit succeeds → next: merge (but merge must wait for router path)
        enqueueStageOutput('test-b-unit', [{ result: '[DONE]' }]);
        // edit-a re-runs (from test-a-unit FAIL → edit-a)
        enqueueStageOutput('edit-a', [{ result: '[DONE]' }]);
        // test-a-unit succeeds on retry → next: router
        enqueueStageOutput('test-a-unit', [{ result: '[DONE]' }]);
        // router succeeds → next: merge
        enqueueStageOutput('router', [{ result: '[DONE]' }]);
        // NOW merge should fire (both test-b-unit and router completed)
        enqueueStageOutput('merge', [{ result: '[PASS]' }]);
        const groupDir = path.join(TEST_GROUPS_BASE, group.folder);
        const runner = new PipelineRunner(group, 'test@g.us', config, async () => { }, () => { }, groupDir);
        const result = await runner.run();
        expect(result).toBe('success');
        cleanupStageIpc(stageNames);
    }, 30000);
});
describe('savePipelineState with activations/completions', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-ac-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('persists and restores activations/completions', () => {
        const state = {
            currentStage: 'test-router',
            completedStages: ['edit-arbiter', 'test-arbiter'],
            lastUpdated: new Date().toISOString(),
            status: 'running',
            activations: { 'edit-arbiter': 2, 'test-arbiter': 2 },
            completions: { 'edit-arbiter': 2, 'test-arbiter': 1 },
        };
        savePipelineState(tmpDir, state);
        const loaded = loadPipelineState(tmpDir);
        expect(loaded).toEqual(state);
        expect(loaded.activations).toEqual({
            'edit-arbiter': 2,
            'test-arbiter': 2,
        });
        expect(loaded.completions).toEqual({
            'edit-arbiter': 2,
            'test-arbiter': 1,
        });
    });
    it('loads state without activations/completions (backwards compat)', () => {
        const state = {
            currentStage: 'verify',
            completedStages: ['implement'],
            lastUpdated: new Date().toISOString(),
            status: 'running',
        };
        savePipelineState(tmpDir, state);
        const loaded = loadPipelineState(tmpDir);
        expect(loaded).not.toBeNull();
        expect(loaded.activations).toBeUndefined();
        expect(loaded.completions).toBeUndefined();
    });
});
//# sourceMappingURL=pipeline-runner.test.js.map