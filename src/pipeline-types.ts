import type { AdditionalMount } from './types.js';

// --- Pipeline JSON Schema ---

export interface PipelineTransition {
  marker?: string; // Marker name (e.g. "STAGE_COMPLETE"). Required unless `afterTimeout` is true.
  next?: string | string[] | null; // Downstream stage in the current scope, or null to end the current scope. Arrays are runtime-only fan-out targets.
  template?: string; // Template name to stitch before continuing to `next`.
  count?: number; // With `template`: insert N copies in parallel + synthesized join. Requires `template`. Mutually exclusive with `countFrom`.
  countFrom?: 'payload'; // Derive lane count from marker payload (JSON array length). Requires `template`. Mutually exclusive with `count`.
  substitutionsFrom?: 'payload'; // Per-lane substitution map comes from payload[i] object fields. Requires `countFrom: "payload"`.
  joinPolicy?: JoinPolicy; // With `template`: how the spawned copies decide whether to continue to `next`.
  outcome?: TransitionOutcome; // Optional explicit outcome classification for this transition.
  afterTimeout?: boolean; // Command mode only: fire this transition only after the command is terminated for timeout.
  prompt?: string; // Description for the agent on when to use this marker
}

export type StageKind = 'agent' | 'command';
export type TransitionOutcome = 'success' | 'error';
export type JoinPolicy = 'all_success' | 'any_success' | 'all_settled';

export interface PipelineStage {
  name: string;
  kind?: StageKind; // Explicit stage kind. Default: inferred (command if `command` set, else agent).
  agent?: string; // Registry ref like "builder:latest". Resolved to prompt/mcp at run start.
  prompt?: string;
  image?: string; // Registry key (agent mode) or image name (command mode)
  command?: string; // Shell command mode (runs sh -c, no agent)
  successMarker?: string; // Command mode: stdout substring that indicates success -> STAGE_COMPLETE
  errorMarker?: string; // Command mode: stdout substring that indicates failure -> STAGE_ERROR (resolves immediately)
  timeout?: number; // Command mode only: max runtime in milliseconds before the process is terminated.
  chat?: boolean; // Interactive chatting stage (agent + user conversation via stdin)
  mounts: Record<string, 'ro' | 'rw' | null | undefined>;
  devices?: string[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean; // Run container with --privileged flag
  env?: Record<string, string>; // Environment variables passed to container
  exclusive?: string;
  hostMounts?: AdditionalMount[]; // Host path mounts validated against allowlist
  mcpAccess?: string[]; // External MCP registry refs available to this stage
  resumeSession?: boolean; // false = always start fresh session. default true = resume
  fan_in?: 'all'; // Fan-in mode: waits for all predecessors. Reserved for future alternatives.
  join?: {
    policy: JoinPolicy;
    expectedCopies: number;
    copyPrefixes: string[];
  }; // Runtime-generated join stage metadata. Not allowed in authored config.
  transitions: PipelineTransition[];
}

/**
 * Resolve the effective stage kind - explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export function resolveStageKind(stage: PipelineStage): StageKind {
  if (stage.kind) return stage.kind;
  return stage.command ? 'command' : 'agent';
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}
