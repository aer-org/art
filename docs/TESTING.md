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

### `tests/e2e/mounts.e2e.test.ts`

| Test | Docker | API | Description |
|------|:---:|:---:|-------------|
| Read-only mount (ro) | Yes | No | Can read, cannot write to `"src": "ro"` mount |
| Read-write mount (rw) | Yes | No | Can read and write to `"src": "rw"` mount, file persists on host |
| Hidden mount (null) | Yes | No | `"memory": null` path not visible in container |
| Project ro + sub-path rw | Yes | No | Project readable not writable, `project:src/generated` writable, `__art__/` hidden |

### Fixtures (`tests/e2e/fixtures/`)

| Fixture | Purpose |
|---------|---------|
| `minimal-command/` | Single command-mode stage |
| `multi-stage/` | 3 command stages with transitions |
| `minimal-agent/` | Single agent stage (API required) |
| `minimal-compose/` | Empty project for headless compose |
| `mount-ro/` | Read-only group mount verification |
| `mount-rw/` | Read-write group mount verification |
| `mount-hidden/` | Hidden (null) mount verification |
| `mount-project-sub/` | Project mount with sub-path override |

## Integration Tests

No mocks — calls real Docker/Podman/udocker binaries. Not included in CI; must be run explicitly on local machines.

```bash
npm run test:integration                        # All (runs only available runtimes, skips the rest)
npm run test:integration -- --grep "Docker"     # Docker only
npm run test:integration -- --grep "Podman"     # Podman only
npm run test:integration -- --grep "udocker"    # udocker only
```

**Prerequisites:** The target runtime must be installed. Unavailable runtimes are automatically skipped.

### `tests/integration/container-runtime.integration.test.ts`

**Target:** `container-runtime.ts` — runtime detection, config, capabilities, mount args, and lifecycle verified against real binaries.

| Runtime | Tests | Verified |
|---------|-------|----------|
| Docker | 15 | initRuntime, capabilities, bridge detection, proxy bind host, hostGatewayArgs, mount args, stopContainer, cleanupOrphans, cleanupRunContainers, ensureImage, SELinux/rootless state |
| Podman | 16 | All of the above + rootless detection (`podman info --format json`), SELinux system state match, bridge interface (`podman0`/`cni-podman0`) |
| udocker | 12 | Restricted capabilities, hostGateway=localhost, bridge=null, proxy=127.0.0.1, prepareContainer(F1)/cleanupContainer lifecycle |

### `tests/integration/container-runner.integration.test.ts`

**Target:** `container-runner.ts` — real container spawn, mount, stdin, gateway connectivity, UID mapping, and orphan cleanup.

Docker/Podman common tests are parameterized in a loop; runtime-specific differences are in separate blocks.

**Common (runs for both Docker & Podman)**

| Test | Description |
|------|-------------|
| basic execution (3) | echo stdout capture, exit code 0, exit code 42 |
| buildContainerArgs (4) | --rm/--name/-i flags, --user 0:0 (runAsRoot), host gateway args, run-id label |
| mount verification (3) | ro mount: read OK / write denied, rw mount: write OK + host persistence, UID-mapped file access and ownership |
| stdin (1) | JSON via stdin → container receives via cat |
| host gateway connectivity (1) | HTTP server on host → container wget via gateway → response received |
| timeout and stop (1) | `sleep 300` container stopped via stopContainer() |
| output marker parsing (1) | `---AER_ART_OUTPUT_START---{json}---AER_ART_OUTPUT_END---` captured |
| orphan cleanup (2) | cleanupOrphans: stops `aer-art-*` containers, cleanupRunContainers: label-based cleanup |

**Podman-specific**

| Test | Description |
|------|-------------|
| --userns=keep-id | Rootless podman includes `--userns=keep-id`, excludes `--user` |

**Docker-specific**

| Test | Description |
|------|-------------|
| --user uid:gid | Includes `--user` for non-root non-1000 uid |
| --gpus all | gpu=true includes `--gpus all` |
| --device | Device passthrough args included |
| USB cgroup rule | `/dev/bus/usb` includes `--device-cgroup-rule` |

**udocker**

| Test | Description |
|------|-------------|
| buildContainerArgs (4) | --rm/--name/-i excluded, device/GPU/label skipped |
| lifecycle (1) | `udocker create` + `setup --execmode=F1` → echo → cleanup |

### Test helpers (`tests/integration/helpers.ts`)

| Export | Purpose |
|--------|---------|
| `FULL_RUNTIMES` | Parameterized array of Docker/Podman `[{ kind, bin }]` |
| `ALPINE_IMAGE` | Lightweight test image (`alpine:latest`) |
| `isRuntimeAvailable(kind)` | Checks binary existence and functionality |
| `isDockerActuallyPodman()` | Detects podman-docker alias |
| `detectSystemSELinux()` | Detects SELinux enforcing state |
| `describeRuntime(kind, fn)` | Runs describe if runtime available, skips otherwise |
| `ensureAlpineImage(bin)` | Pulls alpine image if not present |
| `createTempDir(prefix)` / `cleanupTempDir(dir)` | Temp directory create/cleanup |
| `runContainer(bin, args, opts?)` | spawnSync wrapper returning code/stdout/stderr |

### Design principles

- **Environment-adaptive:** SELinux, rootless, bridge interface, etc. are never hardcoded — tests query actual system state and compare
- **Parameterized:** Docker/Podman common behavior runs in a shared loop; only differences are split out
- **Real behavior verification:** Tests verify actual gateway connectivity, UID file access, and mount enforcement — not just arg generation
- **podman-docker alias support:** Tests work even when the `docker` binary is actually podman

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

### Integration tests

1. Add common behavior inside the `for (const { kind, bin } of FULL_RUNTIMES)` loop.
2. Add runtime-specific differences in separate `describeRuntime(kind, ...)` blocks.
3. Never hardcode environment-specific values (SELinux, rootless, etc.) — query actual system state and compare.
4. When async resources are needed (e.g., HTTP server), use `server.unref()` + async `spawn` — `spawnSync` blocks the event loop and prevents the server from responding.
5. In `beforeAll`, follow this order: `_resetRuntime()` → set `process.env.CONTAINER_RUNTIME` → `initRuntime()`.

### E2E tests

1. Add fixtures to `tests/e2e/fixtures/` with `__art__/PIPELINE.json` and `__art__/plan/PLAN.md`.
2. Add test cases in `tests/e2e/pipeline.e2e.test.ts`.
3. Use `--skip-preflight` for tests that don't need Claude API.
4. Guard API-dependent tests with `describe.skipIf(!hasApiKey)`.
