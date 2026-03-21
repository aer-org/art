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
| loadPipelineConfig — valid JSON | Parses stages |
| loadPipelineConfig — file missing | Returns null |
| loadPipelineConfig — empty stages | Returns null |
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

## E2E Tests

Real container pipelines on Docker. No mocking — exercises `art run` / `art compose` end-to-end.

```bash
npm run test:e2e                    # All E2E tests (Docker required)
npx vitest run --config vitest.e2e.config.ts tests/e2e/pipeline.e2e.test.ts  # Single file
```

The E2E suite installs the package globally via `npm pack → npm install -g` to match real user install environment.

### `tests/e2e/pipeline.e2e.test.ts`

| # | Test | Docker | API | Description |
|---|------|:---:|:---:|-------------|
| — | Package contents (regression #13) | No | No | Verifies `npm pack` includes agent-runner src/dist, Dockerfile, build.sh |
| 1 | Environment check | No | No | Docker available, Node 20+ |
| 2 | Container image build | Yes | No | `art-agent:latest` exists or builds successfully |
| 3 | Single command pipeline | Yes | No | `echo '[STAGE_COMPLETE]'` → exit 0, state=success |
| 4 | Multi-stage command pipeline | Yes | No | 3 stages (a→b→c) complete in order |
| 5 | Agent-mode pipeline | Yes | Yes | Claude API call → `[STAGE_COMPLETE]` marker |
| 6 | Headless compose | Yes | Yes | `art compose --headless` → PLAN.md created |
| 7 | Compose + Run full flow | Yes | Yes | headless compose → overwrite PLAN.md → `art run` succeeds |

- Command-mode tests (#3-4) use `--skip-preflight` to bypass Claude CLI/auth checks.
- API-dependent tests (#5-7) auto-skip when `ANTHROPIC_API_KEY` is absent.

### Test helpers (`tests/e2e/helpers.ts`)

- `installGlobal()` / `uninstallGlobal()` — `npm pack` → `npm install -g` / cleanup
- `listPackageFiles()` — `npm pack --dry-run` output parsed to file list
- `copyFixture(name)` — copies `tests/e2e/fixtures/{name}` to tmpdir
- `runArt(args, cwd, env?)` — spawns global `art` binary and returns `{ code, stdout, stderr }`
- `cleanupFixture(dir)` — removes tmpdir
- `readPipelineState(artDir)` — parses `PIPELINE_STATE.json`

### Fixtures (`tests/e2e/fixtures/`)

| Fixture | Purpose |
|---------|---------|
| `minimal-command/` | Single command-mode stage |
| `multi-stage/` | 3 command stages with transitions |
| `minimal-agent/` | Single agent stage (API required) |
| `minimal-compose/` | Empty project for headless compose |

## CI Configuration

### `.github/workflows/ci.yml`

Runs on push/PR to `main`/`dev`. Three parallel jobs:
- **typecheck** — `npm run typecheck`
- **test** — `npm run test` (all unit tests)
- **format** — `npm run format:check`

### `.github/workflows/e2e.yml`

| Trigger | API token | Tests |
|---------|-----------|-------|
| PR to main/dev | Not injected | #1-4 (command-mode only, zero API cost) |
| Push to main (merge) | `secrets.ANTHROPIC_API_KEY` | #1-7 (full suite) |
| Manual dispatch | `secrets.ANTHROPIC_API_KEY` | #1-7 (full suite) |

Steps: checkout → build → Docker image cache/build → install Claude CLI → `npm run test:e2e`.

### `.github/workflows/container-build.yml`

Manual trigger (`workflow_dispatch`) for container image build verification. Inputs:
- `base_image` — custom base Docker image (optional)
- `tag` — image tag name (optional, default: latest)

Steps: checkout → build via `./container/build.sh` → smoke test (TypeScript compiles in container) → smoke test (agent-runner loads).

## Adding New Tests

### Unit tests

1. Create `src/<module>.test.ts` next to the source file.
2. Follow existing mock patterns — see `container-runner.test.ts` for the canonical structure.
3. Mock external dependencies (`config.js`, `logger.js`, etc.) at the top of the file using `vi.mock()`.
4. Use real filesystem (`os.tmpdir()`) for state file tests instead of mocking `fs`.
5. Clean up temp dirs in `afterEach`.

### E2E tests

1. Add fixtures to `tests/e2e/fixtures/` with `__art__/PIPELINE.json` and `__art__/plan/PLAN.md`.
2. Add test cases in `tests/e2e/pipeline.e2e.test.ts`.
3. Use `--skip-preflight` for tests that don't need Claude API.
4. Guard API-dependent tests with `describe.skipIf(!hasApiKey)`.
