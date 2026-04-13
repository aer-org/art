# Codex Support Design Draft

Goal: support `Codex` in the existing container runtime without replacing the current Claude path, and do it with the smallest possible code change set.

## Recommendation

Use an **engine adapter inside `container/agent-runner`**.

Keep these parts unchanged:

- host-side container lifecycle
- IPC protocol between host and container
- long-lived container query loop
- AerArt MCP bridge (`ipc-mcp-stdio.ts`)
- stdout framing markers used by the host

Add a provider switch only at the point where the container-side runner talks to the underlying agent SDK.

## Why This Is The Minimum-Change Path

Today the main provider coupling is inside the container-side runner, not in the host orchestration layer.

- `src/container-runner.ts` already does generic container setup, mount wiring, and IPC setup.
- `container/agent-runner/src/index.ts` is where Claude-specific SDK calls and Claude-specific event parsing live.
- The host only needs `ContainerOutput` messages and marker-delimited streaming text/tool activity.

That means the smallest viable change is:

1. add `provider` to container input
2. split provider-specific execution into two engine adapters
3. normalize Claude/Codex events into the same AerArt internal stream shape

## Proposed Architecture

### New Provider Field

Extend `ContainerInput` with:

```ts
provider?: 'claude' | 'codex';
```

Default to `'claude'` for backward compatibility.

### New Internal Abstraction

Inside `container/agent-runner/src/`, introduce a small internal engine boundary:

```ts
interface AgentEngine {
  runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent>;
}
```

Suggested files:

- `container/agent-runner/src/engines/types.ts`
- `container/agent-runner/src/engines/claude-engine.ts`
- `container/agent-runner/src/engines/codex-engine.ts`

`index.ts` remains the container entrypoint and query loop owner. It selects an engine and consumes normalized events.

## Normalized Event Model

Do not let the rest of `index.ts` understand Claude SDK messages or Codex SDK events directly.

Introduce a minimal normalized shape:

```ts
type NormalizedEvent =
  | { type: 'session.started'; sessionId: string }
  | { type: 'assistant.text'; text: string }
  | { type: 'tool.started'; id: string; name: string; preview?: string }
  | { type: 'tool.result'; id: string; isError: boolean; errorText?: string }
  | { type: 'assistant.checkpoint'; messageId?: string }
  | { type: 'turn.result'; result: string | null }
  | { type: 'turn.error'; error: string };
```

This is intentionally smaller than either SDK surface. The host does not need full provider-native fidelity.

## Claude Path

Keep the current Claude implementation, but move it behind `ClaudeEngine`.

It will continue to use:

- `@anthropic-ai/claude-agent-sdk`
- `systemPrompt: { preset: 'claude_code', append }`
- `settingSources: ['project', 'user']`
- `.claude` session directory and Claude settings

The current `runQuery()` body can largely be refactored rather than rewritten.

## Codex Path

Add a new `CodexEngine` based on `@openai/codex-sdk`.

### SDK Usage

Use:

```ts
const codex = new Codex({ apiKey, env, config });
const thread = sessionId
  ? codex.resumeThread(sessionId, threadOptions)
  : codex.startThread(threadOptions);
const { events } = await thread.runStreamed(prompt);
```

### Codex Thread Options

Map current container behavior to Codex options:

- `workingDirectory: '/workspace'`
- `additionalDirectories: extraDirs`
- `sandboxMode: 'danger-full-access'`
- `approvalPolicy: 'never'`
- `skipGitRepoCheck: true`

Optional initial config overrides:

```ts
config: {
  sandbox_workspace_write: { network_access: true },
  experimental_instructions_file: null
}
```

Only add overrides proven necessary during implementation.

### Event Mapping

Map Codex events to `NormalizedEvent` roughly as follows:

- `thread.started` -> `session.started`
- `item.completed` with `agent_message` -> `assistant.text` and `turn.result`
- `item.started` / `item.updated` / `item.completed` with `command_execution` -> `tool.started` / `tool.result`
- `item.started` / `item.completed` with `mcp_tool_call` -> `tool.started` / `tool.result`
- `turn.failed` or `error` -> `turn.error`

### Important Behavioral Difference

Claude currently accepts a live async iterable prompt stream, so AerArt can inject IPC messages while a turn is active.

Codex TS SDK is turn-oriented: one `runStreamed(input)` call processes one input. Because of that, the minimum-change Codex integration should **not** try to support mid-turn IPC injection.

Instead:

- Claude keeps current mid-turn IPC behavior
- Codex consumes one IPC message per turn
- after each Codex turn completes, the existing outer wait loop picks up the next IPC message

This is the biggest semantic difference in the minimum-change plan, but it is isolated to provider behavior inside the container.

## Memory And Project Instructions

Claude and Codex use different project-doc conventions.

- Claude path keeps current `CLAUDE.md` behavior
- Codex path should use `AGENTS.md`

For the first patch, do not attempt a fully shared memory abstraction. Instead:

### Claude

- keep `/workspace/global/CLAUDE.md`
- keep `.claude/settings.json`
- keep `.claude/skills`

### Codex

- mount a provider-specific home directory at `~/.codex`
- write a minimal `config.toml` only if needed
- if shared global guidance is required, materialize it as `/workspace/global/AGENTS.md`

This avoids mixing Claude-specific files into Codex home.

## Host-Side Changes

### `src/container-runner.ts`

Make the following small changes:

1. Extend `ContainerInput` to carry `provider`.
2. Build provider-specific session home directories:
   - Claude: `.../.claude`
   - Codex: `.../.codex`
3. Mount the correct home path in the container:
   - Claude: `/home/node/.claude` or `/root/.claude`
   - Codex: `/home/node/.codex` or `/root/.codex`
4. Only write Claude-specific `settings.json` when provider is Claude.
5. Keep shared IPC mounts unchanged.

Recommended helper extraction:

```ts
function buildProviderSessionMount(provider: AgentProvider, group: RegisteredGroup, runAsRoot: boolean): VolumeMount
```

### `container/Dockerfile`

Install both CLIs / SDKs needed by the runner:

- global: `agent-browser`, `@anthropic-ai/claude-code`, `@openai/codex`
- local dependency: `@openai/codex-sdk`

This preserves the current Claude flow and enables Codex in the same image.

## Authentication Choices

There are two realistic options.

### Option A: Fastest Implementation

Pass OpenAI credentials directly into the container for Codex only.

Pros:

- smallest patch
- no new proxy logic
- easiest to validate

Cons:

- weaker isolation than current Claude path
- provider behavior diverges

### Option B: Preserve Current Security Model

Add a provider-aware credential proxy that can front both Anthropic and OpenAI.

Pros:

- keeps "container never sees real secret" invariant
- cleaner long-term provider story

Cons:

- meaningfully larger patch
- requires new env naming and upstream routing rules

### Recommendation

For the first Codex support patch, use **Option A** if the goal is to prove runtime compatibility quickly.

If Codex becomes a supported production path, follow up immediately with Option B.

## File-Level Patch Plan

### Phase 1: Engine Adapter Refactor

Edit:

- `container/agent-runner/src/index.ts`
- `container/agent-runner/package.json`

Add:

- `container/agent-runner/src/engines/types.ts`
- `container/agent-runner/src/engines/claude-engine.ts`
- `container/agent-runner/src/engines/codex-engine.ts`

### Phase 2: Provider-Aware Session Mounting

Edit:

- `src/container-runner.ts`

Possible small follow-up:

- `src/types.ts` if provider is persisted in group/runtime config

### Phase 3: Container Image

Edit:

- `container/Dockerfile`

### Phase 4: Authentication

Minimal path:

- add OpenAI env plumbing where container env is assembled

Longer-term path:

- refactor `src/credential-proxy.ts`
- refactor `src/cli/auth.ts`

## Implementation Notes

### Keep The Host Output Contract Stable

Do not change these markers:

- `---AER_ART_OUTPUT_START---`
- `---AER_ART_OUTPUT_END---`
- `---AER_ART_TOOL_START---`
- `---AER_ART_TOOL_END---`

The host already knows how to parse them.

### Keep The Outer Query Loop

Do not rewrite the loop in `index.ts` that:

1. starts a turn
2. emits session update
3. waits for IPC
4. starts the next turn

Only swap the provider-specific turn executor under that loop.

### Avoid Premature Unification

Do not try in the first patch to unify:

- Claude `CLAUDE.md` and Codex `AGENTS.md`
- Claude skill packaging and Codex skills/plugins
- Anthropic and OpenAI credential handling
- all provider-native event details

Those are second-step cleanup tasks.

## Risks

1. Codex turn semantics differ from Claude stream semantics, so mid-turn IPC injection will not behave the same.
2. Codex may expect `AGENTS.md` and `.codex/config.toml` patterns that do not map cleanly from current Claude memory setup.
3. If we keep direct OpenAI key injection in the first patch, security posture temporarily differs by provider.
4. Some Claude-specific issue tracking logic based on `tool_use/tool_result` will need a simpler Codex mapping first, then refinement.

## Acceptance Criteria For The First Patch

The patch is good enough if all of the following work:

1. Claude path still runs unchanged.
2. A container can be started with `provider='codex'`.
3. Codex can start a new session and return a result through the existing output markers.
4. Codex can resume a session using the existing long-lived container loop.
5. MCP calls through `ipc-mcp-stdio.ts` still work from the Codex path.
6. Host-side code outside provider selection needs only small edits.

## Non-Goals For The First Patch

- identical behavior between Claude and Codex
- provider-independent auth abstraction
- provider-independent memory abstraction
- agent-team parity between Claude and Codex
- migrating the whole runtime to the Codex app-server protocol

## Suggested Next Step

Implement the refactor in this order:

1. extract current Claude logic into `ClaudeEngine`
2. add normalized event types
3. rewire `index.ts` to consume normalized events
4. add `CodexEngine`
5. add provider-aware session mounts in `src/container-runner.ts`
6. add container image dependencies
7. validate Claude regression before testing Codex
