# Testing Guide

## Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode (re-runs on file changes)
npx vitest run src/pipeline-runner.test.ts  # Single file
```

## Test Files

### `src/container-runner.test.ts`

**Target:** `container-runner.ts` — container spawning, timeout, output parsing.

| Test | Description |
|------|-------------|
| timeout after output resolves as success | Output received before timeout → success |
| timeout with no output resolves as error | No output + timeout → error with "timed out" |
| normal exit after output resolves as success | Output + clean exit → success |

**Mocking:** `child_process.spawn` → fake `ChildProcess` with controllable `stdout`/`stderr`/events. `fs` mocked for `existsSync`/`mkdirSync`/etc. `config.js`, `logger.js`, `container-runtime.js`, `mount-security.js`, `credential-proxy.js`, `group-folder.js` all mocked.

### `src/credential-proxy.test.ts`

**Target:** `credential-proxy.ts` — HTTP proxy, auth injection (API-key/OAuth).

**Mocking:** HTTP server/client interactions.

### `src/container-runtime.test.ts`

**Target:** `container-runtime.ts` — runtime detection, mount argument generation, cleanup.

| Tests | Description |
|-------|-------------|
| 34 tests | Docker/Podman runtime detection, mount args, SELinux, rootless mode, container lifecycle |

**Mocking:** `child_process.execSync` for runtime binary detection. `fs` for config file checks.

### `src/group-folder.test.ts`

**Target:** `group-folder.ts` — path resolution, path traversal defense.

| Tests | Description |
|-------|-------------|
| 5 tests | Valid folder resolution, path traversal rejection, IPC path resolution |

**Mocking:** `config.js` for `GROUPS_DIR`/`DATA_DIR`.

### `src/timezone.test.ts`

**Target:** `timezone.ts` — timezone conversion utilities.

| Tests | Description |
|-------|-------------|
| 2 tests | Timezone string conversion |

### `src/pipeline-runner.test.ts`

**Target:** `pipeline-runner.ts` — FSM transitions, marker parsing, checkpoint, command mode.

**Group A: Pure functions (no container mock needed)**

| Test | Description |
|------|-------------|
| parseStageMarkers — marker matching | `[STAGE_COMPLETE]` → correct transition |
| parseStageMarkers — payload extraction | `[ERROR: build failed]` → payload "build failed" |
| parseStageMarkers — first match wins | Multiple markers → first one returned |
| parseStageMarkers — no match | No markers → `{ matched: null, payload: null }` |
| parseStageMarkers — multi-text join | Joins array before matching |
| generateRunId — format | Matches `run-{timestamp}-{hex}` |
| generateRunId — uniqueness | 10 IDs are all distinct |
| loadPipelineConfig — valid JSON | Parses stages + errorPolicy |
| loadPipelineConfig — file missing | Returns null |
| loadPipelineConfig — empty stages | Returns null |
| loadPipelineConfig — default errorPolicy | `{ maxConsecutive: 3, debugOnMaxErrors: true }` |
| loadAgentTeamConfig — valid | Returns agents array |
| loadAgentTeamConfig — path traversal | Returns null for `../` folders |
| savePipelineState / loadPipelineState | Round-trip save/load |
| writeRunManifest / readRunManifest | Round-trip save/load |
| writeCurrentRun / readCurrentRun / removeCurrentRun | CRUD operations |

**Group B: PipelineRunner FSM (runContainerAgent mocked)**

| Test | Description |
|------|-------------|
| 2-stage success | implement → verify → done, returns `'success'` |
| error marker → retry then success | IMPL_ERROR → retry within container → IMPL_COMPLETE → verify |
| payload transfer | `[IMPL_COMPLETE: payload]` → verify prompt contains payload |
| verify fail → loopback | VERIFY_FAIL → re-spawns implement |
| checkpoint resume | Pre-saved state → skips completed stages |
| no marker → retry | Missing marker → sends retry IPC, then succeeds |

**Group C: Command mode + Lock**

| Test | Description |
|------|-------------|
| command mode stage | `stage.command` set → `spawn` called, markers parsed from stdout |
| exclusive lock serialization | Same key → sequential execution |

**Mocking strategy:**
- `runContainerAgent` — queue-based mock: tests enqueue output sequences per stage name. The mock emits outputs with delays between each entry so the FSM has time to set up deferred promises between rounds.
- `child_process.spawn` — fake `ChildProcess` for command mode tests.
- `fs` is NOT mocked — uses real `os.tmpdir()` temp directories for state file round-trips.
- `config.js`, `logger.js`, `container-runtime.js`, `image-registry.js`, `group-folder.js`, `mount-security.js` — all mocked to isolate from real environment.

## CI Configuration

### `.github/workflows/ci.yml`

Runs on push/PR to `main`/`dev`. Three parallel jobs:
- **typecheck** — `npm run typecheck`
- **test** — `npm run test` (all unit tests)
- **format** — `npm run format:check`

### `.github/workflows/container-build.yml`

Manual trigger (`workflow_dispatch`) for container image build verification. Inputs:
- `base_image` — custom base Docker image (optional)
- `tag` — image tag name (optional, default: latest)

Steps: checkout → build via `./container/build.sh` → smoke test (TypeScript compiles in container) → smoke test (agent-runner loads).

## Adding New Tests

1. Create `src/<module>.test.ts` next to the source file.
2. Follow existing mock patterns — see `container-runner.test.ts` for the canonical structure.
3. Mock external dependencies (`config.js`, `logger.js`, etc.) at the top of the file using `vi.mock()`.
4. Use real filesystem (`os.tmpdir()`) for state file tests instead of mocking `fs`.
5. Clean up temp dirs in `afterEach`.
