# AerArt Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Host process | Trusted | Runs on the user's machine, manages containers and credentials |
| Container agents | Untrusted | Isolated execution; constrained by mounts and credential proxy |
| User input (prompts, PIPELINE.json) | Trusted | Written by the pipeline author |

The core security boundary is **host vs container**. The host controls what each container can see (mounts), what credentials it can use (credential proxy), and how long it runs (timeouts).

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security (Permission Boundary)

Mount permissions control what each stage can access. This is the main mechanism for constraining agent behavior.

**External Allowlist** - Mount permissions stored at `~/.config/aer-art/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)

**Read-Only Project Root:**

The project root is mounted read-only. Writable paths the agent needs (`__art__/` subdirectories, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

**Per-Stage Mount Policies:**

Each stage declares which `__art__/` subdirectories are rw, ro, or hidden (not mounted). Stage templates enforce default policies; `PIPELINE.json` can override them. This provides adversarial separation — build agents cannot see test scripts, test agents cannot see plans.

### 3. Credential Isolation (Auth Boundary)

Real API credentials **never enter containers**. Instead, the host runs an HTTP credential proxy that injects authentication headers transparently.

**How it works:**
1. Host starts a credential proxy on `CREDENTIAL_PROXY_PORT` (default: 3001)
2. Containers receive `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>` and `ANTHROPIC_API_KEY=placeholder`
3. The SDK sends API requests to the proxy with the placeholder key
4. The proxy strips placeholder auth, injects real credentials (`x-api-key` or `Authorization: Bearer`), and forwards to `api.anthropic.com`
5. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**NOT Mounted:**
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 4. Pipeline Stage Isolation

Each pipeline stage runs in its own ephemeral container with independent mount configuration:

- **Per-stage mounts**: Each stage declares which `__art__/` subdirectories are rw, ro, or hidden
- **Adversarial separation**: Build agents cannot see test scripts; test agents cannot see plans
- **Stage templates** enforce mount policies by default (overridable in `PIPELINE.json`)
- **Command mode** stages (`sh -c`) get the same mount isolation as agent-mode stages

### 5. Run ID Container Cleanup

Each container spawned during a pipeline run is labeled with `art-run-id={runId}`:
- On normal completion, containers are auto-removed (`--rm`)
- On abnormal termination (SIGKILL, crash), orphan containers are bulk-cleaned by label via `cleanupRunContainers()`
- `_current.json` tracks the active run's PID; stale PIDs are detected and cleaned up automatically

### 6. Dynamic Port Allocation

The credential proxy and editor server use dynamic port allocation (binding to port 0) to avoid `EADDRINUSE` conflicts. The actual port is read back after binding and passed to containers via environment variables.

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Pipeline FSM (stage transitions)                              │
│  • Mount validation (external allowlist)                         │
│  • Container lifecycle management                                │
│  • Credential proxy (injects auth headers)                       │
│  • Output streaming and marker parsing                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/UNTRUSTED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through credential proxy                     │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```
