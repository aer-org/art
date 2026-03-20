---
name: add-compact
description: Add /compact command for manual context compaction. Solves context rot in long sessions by forwarding the SDK's built-in /compact slash command. Main-group or trusted sender only.
---

# Add /compact Command

Adds a `/compact` session command that compacts conversation history to fight context rot in long-running sessions. Uses the Claude Agent SDK's built-in `/compact` slash command — no synthetic system prompts.

**Session contract:** `/compact` keeps the same logical session alive. The SDK returns a new session ID after compaction (via the `init` system message), which the agent-runner forwards to the orchestrator as `newSessionId`. No destructive reset occurs — the agent retains summarized context.

## Phase 1: Pre-flight

Check if `src/session-commands.ts` exists:

```bash
test -f src/session-commands.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/compact
git merge upstream/skill/compact
```

> **Note:** `upstream` is the remote pointing to `aer-org/art`. If using a different remote name, substitute accordingly.

This adds:
- `src/session-commands.ts` (extract and authorize session commands)
- `src/session-commands.test.ts` (unit tests for command parsing and auth)
- Session command interception in `src/index.ts` (both `processGroupMessages` and `startMessageLoop`)
- Slash command handling in `container/agent-runner/src/index.ts`

### Validate

```bash
npm test
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

## Phase 3: Verify

### Validate

```bash
npm run build
npm test
./container/build.sh
```

### Integration Test

1. Run `art compose` and start the agent
2. Send `/compact` in the chat
3. Verify:
   - The agent acknowledges compaction
   - The session continues — send a follow-up message and verify the agent responds coherently
   - Container logs show `Compact boundary observed` (confirms SDK actually compacted)

## Notes

- **Session continues after compaction.** This is not a destructive reset. The conversation continues with summarized context.
- **No auto-compaction.** This skill implements manual compaction only.
- **No changes to the container image, Dockerfile, or build script.**
