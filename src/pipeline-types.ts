import type { AdditionalMount } from './types.js';

// --- Pipeline JSON Schema ---

export interface PipelineTransition {
  marker?: string; // Marker name (e.g. "STAGE_COMPLETE"). Required unless `afterTimeout` is true.
  next?: string | string[] | null; // Downstream stage(s) in the current scope, or null to end the current scope. Array form is heterogeneous fan-out (each target spawns in parallel); cannot combine with `template`.
  template?: string; // Template name to stitch before continuing to `next`.
  count?: number; // With `template`: insert N copies in parallel + synthesized join. Requires `template`. Mutually exclusive with `countFrom`.
  countFrom?: 'payload'; // Derive lane count from marker payload (JSON array length). Requires `template`. Mutually exclusive with `count`.
  substitutionsFrom?: 'payload'; // Per-lane substitution map comes from payload[i] object fields. Requires `countFrom: "payload"`.
  joinPolicy?: JoinPolicy; // With `template`: how the spawned copies decide whether to continue to `next`.
  outcome?: TransitionOutcome; // Optional explicit outcome classification for this transition.
  afterTimeout?: boolean; // Command mode only: fire this transition only after the command is terminated for timeout.
  prompt?: string; // Description for the agent on when to use this marker
}

export type TransitionOutcome = 'success' | 'error';
export type JoinPolicy = 'all_success' | 'any_success' | 'all_settled';

export type DispatchNodeStatus = 'pending' | 'running' | 'success' | 'error';

export interface PipelineDispatchNode {
  id: string;
  parentId: string | null;
  originStage: string | null;
  template: string | null;
  copyIndex: number | null;
  entryStage: string | null;
  stageNames: string[];
  childIds: string[];
  status: DispatchNodeStatus;
  config: PipelineConfig;
}

export interface PipelineDispatchBarrier {
  id: string;
  ownerNodeId: string;
  originStage: string;
  originTransitionIdx: number;
  template: string;
  childNodeIds: string[];
  joinPolicy: JoinPolicy;
  downstreamNext: string | null;
  settlements: Record<string, TransitionOutcome>;
  status: DispatchNodeStatus;
}

export interface PipelineStageDispatch {
  nodeId: string;
  parentNodeId: string | null;
  invocationId: string;
  copyIndex?: number;
  localName: string;
  /**
   * The full substitution map applied to this stage at stitch time
   * (insertId, index, plus any per-lane payload fields). Captured for L1
   * provenance so a reader can answer "why did this lane differ from its
   * siblings". Runtime-only.
   */
  substitutions?: Record<string, unknown>;
}

export interface PipelineStage {
  name: string;
  agent?: string; // Local agents/<name>.md prompt ref. Resolved while loading config.
  promptSource?: string; // Runtime-only. Set by resolveAgentRefs to `agents/<name>.md` (or omitted for inline prompts) for L1 provenance.
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
  dispatch?: PipelineStageDispatch; // Runtime-generated dispatch tree metadata.
  transitions: PipelineTransition[];
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}
