# Codex Phase 2 Auth Plan

## Goal

Remove direct container access to Codex auth material while preserving the current user flow:

- host is logged into Codex via OAuth
- user runs `art run --codex .`
- container can execute Codex turns
- stage prompts and transition markers still work

Phase 1 achieved this with `.codex/auth.json` passthrough. Phase 2 replaces that with host-managed auth and host-owned Codex execution.

## Chosen Design

Use a host-side Codex gateway instead of exposing raw Codex auth or a raw app-server transport to the container.

The gateway will:

1. start `codex app-server` on the host over `stdio`
2. initialize the app-server connection
3. inject external ChatGPT auth using `account/login/start` with `chatgptAuthTokens`
4. answer `account/chatgptAuthTokens/refresh` requests from the app-server
5. create or resume a thread
6. start a turn
7. normalize streamed app-server events into the event model already used by `container/agent-runner`
8. stream those normalized events back to the container over a simple HTTP streaming API

This is intentionally different from the Phase 1 `@openai/codex-sdk` local-exec path:

- the container no longer runs Codex directly
- the container no longer needs `auth.json`
- the host owns the app-server lifecycle and auth refresh logic

## Why This Design

There were two realistic Phase 2 options:

1. expose a remote Codex app-server transport directly to the container
2. hide app-server behind an ART-specific host gateway

We choose option 2.

Reasons:

- Codex websocket app-server transport is explicitly experimental
- the container only needs normalized turn events, not the full Codex protocol
- auth refresh is simpler when the host terminates the app-server protocol locally
- the security boundary is cleaner because the container never speaks auth-related Codex RPC methods
- we can reuse the current ART host-to-container model, where the host exposes narrow services and the container consumes them

## Target Architecture

### Host

- `CodexTurnProxyServer`
  - HTTP server bound to loopback / host gateway only
  - accepts a single turn request from a container
  - returns newline-delimited JSON events

- `CodexAppServerClient`
  - spawns `codex app-server --listen stdio://`
  - speaks JSON-RPC over stdio
  - handles initialize, login, thread start/resume, turn start, interrupt, shutdown

- `CodexExternalAuthManager`
  - reads host OAuth state
  - extracts access token and workspace/account id
  - refreshes host auth when needed
  - serves app-server refresh requests during active turns

### Container

- `CodexEngine`
  - stops using local `@openai/codex-sdk`
  - calls host `CodexTurnProxyServer`
  - consumes normalized event stream
  - keeps the rest of the container query loop unchanged

### Session Persistence

- thread ids continue to be stored as the session id in ART
- the host app-server uses a stable host-side Codex home for thread persistence
- external auth tokens remain ephemeral and are re-injected per turn

## Request/Response Contract

### Container -> Host request

Single HTTP POST:

- provider metadata
- ART session id if present
- prompt
- ephemeral append
- working directory
- additional directories
- sandbox/approval settings

### Host -> Container stream

NDJSON stream using the existing normalized event model:

- `session.started`
- `assistant.text`
- `assistant.checkpoint`
- `tool.started`
- `tool.result`
- `turn.result`
- `turn.error`

This avoids teaching the container the raw app-server protocol.

## Auth Model

### Source of truth

Host OAuth state remains the source of truth. The host may still read `~/.codex/auth.json`, but only on the host.

### External auth mode

The host logs the app-server in using:

- `account/login/start`
- `type: "chatgptAuthTokens"`
- `accessToken`
- `chatgptAccountId`

During the turn, if the app-server sends `account/chatgptAuthTokens/refresh`, the host refreshes the token and updates the app-server with a new `account/login/start(chatgptAuthTokens)` call.

### Security effect

After the switch:

- container no longer mounts `.codex/auth.json`
- container no longer reads OAuth material
- container only receives streamed turn events

## Patch Sequence

### Step 1: foundation

- add design doc
- add host-side `CodexAppServerClient` skeleton
- add minimal JSON-RPC types/helpers for app-server stdio
- keep runtime behavior unchanged

### Step 2: host auth manager

- add `CodexExternalAuthManager`
- move host auth parsing and refresh behavior out of passthrough helper
- expose:
  - `getExternalLoginParams()`
  - `refreshExternalLoginParams()`

### Step 3: host turn proxy

- add `CodexTurnProxyServer`
- implement one-turn HTTP streaming endpoint
- implement app-server lifecycle per request
- map app-server notifications to normalized ART events

### Step 4: container remote engine

- switch `container/agent-runner/src/engines/codex-engine.ts` from local SDK to host proxy
- keep current normalized event handling intact

### Step 5: runtime integration

- start the Codex turn proxy in `run-engine.ts` when provider is `codex`
- pass proxy host/port into the container
- stop mounting `.codex/auth.json` into the container for Codex Phase 2 mode

### Step 6: default flip and cleanup

- make host-managed mode the default Codex path
- keep passthrough behind an explicit fallback flag until confidence is high
- remove unused Phase 1-only code after rollout

## Rollout Strategy

Do not replace the working passthrough path immediately.

Introduce a feature flag first:

- `ART_CODEX_AUTH_MODE=passthrough|host-managed`

Initial rollout:

- default: `passthrough`
- CI / manual validation: `host-managed`

After validation:

- default: `host-managed`
- keep `passthrough` as emergency fallback

Final cleanup:

- remove passthrough mode if it no longer provides operational value

## Verification

### Functional

1. `art run --codex .` returns the expected stage completion marker
2. resumed Codex session continues across turns
3. command/tool progress still appears in ART logs
4. turn completion still emits the final ART output envelope

### Security

1. container no longer mounts `.codex/auth.json`
2. container env contains no Codex API key or OAuth token
3. host proxy rejects non-local callers

### Failure handling

1. expired host OAuth triggers refresh and the turn still succeeds
2. refresh failure surfaces as a normal turn error
3. app-server crash during a turn fails the stage once and exits cleanly

## Non-goals for this phase

- replacing Claude auth flow
- exposing the full Codex app-server protocol to containers
- supporting arbitrary remote websocket clients
