// Mirrors enough of src/pipeline-runner.ts shapes to render and validate.
// Kept loose on purpose — we accept any extra fields and pass them through.

export interface PipelineTransition {
  marker?: string;
  next?: string | string[] | null;
  template?: string;
  count?: number;
  countFrom?: 'payload';
  substitutionsFrom?: 'payload';
  joinPolicy?: 'all_success' | 'any_success' | 'all_settled';
  outcome?: 'success' | 'error';
  afterTimeout?: boolean;
  prompt?: string;
  retry?: boolean;
}

export interface PipelineStage {
  name: string;
  kind?: 'agent' | 'command';
  agent?: string;
  prompt?: string;
  prompts?: string[];
  prompt_append?: string;
  image?: string;
  command?: string;
  successMarker?: string;
  errorMarker?: string;
  timeout?: number;
  chat?: boolean;
  mounts?: Record<string, 'ro' | 'rw' | null>;
  devices?: string[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean;
  env?: Record<string, string>;
  exclusive?: string;
  hostMounts?: unknown[];
  mcpAccess?: string[];
  resumeSession?: boolean;
  fan_in?: 'all';
  transitions?: PipelineTransition[];
  // pass-through anything else
  [extra: string]: unknown;
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}

export interface PipelineDispatchNode {
  id: string;
  parentId: string | null;
  originStage: string | null;
  template: string | null;
  copyIndex: number | null;
  entryStage: string | null;
  stageNames: string[];
  childIds: string[];
  status: 'pending' | 'running' | 'success' | 'error';
  config: PipelineConfig;
}

export interface PipelineDispatchBarrier {
  id: string;
  ownerNodeId: string;
  originStage: string;
  originTransitionIdx: number;
  template: string;
  childNodeIds: string[];
  joinPolicy: 'all_success' | 'any_success' | 'all_settled';
  downstreamNext: string | null;
  settlements: Record<string, 'success' | 'error'>;
  status: 'pending' | 'running' | 'success' | 'error';
}

export interface PipelineState {
  version?: number;
  currentStage: string | string[] | null;
  completedStages: string[];
  lastUpdated: string;
  status: 'running' | 'error' | 'success';
  activations?: Record<string, number>;
  completions?: Record<string, number>;
  insertedStages?: PipelineStage[];
  joinSettlements?: Record<string, Record<string, 'success' | 'error'>>;
  dispatchTree?: Record<string, PipelineDispatchNode>;
  dispatchBarriers?: Record<string, PipelineDispatchBarrier>;
}

export interface RunManifest {
  runId: string;
  pid: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stages: Array<{ name: string; status: string; duration?: number }>;
  logFile?: string;
  outputLogFile?: string;
}

export interface NodeLogLine {
  stage: string;
  kind: 'stdout' | 'stderr';
  line: string;
  sourceFile?: string;
}

export interface GraphRunContext {
  isRunning: boolean;
  isRunStarting?: boolean;
  activeRunStartedAt?: string | number | null;
}

export type GraphNodeStatus = 'pending' | 'running' | 'success' | 'error' | 'unknown';

export interface GraphNode {
  id: string;
  name: string;
  kind: 'agent' | 'command' | 'barrier' | 'template';
  status: GraphNodeStatus;
  isStitched: boolean;
  isTemplatePlaceholder: boolean;
  templateName?: string;
  // Transparency layer (run-detail view only).
  retryCount?: number;
  nodeId?: string; // dispatch node ('root' or 'd_…')
  exitCode?: number | null;
  // Barrier-only fields.
  barrierId?: string;
  ownerNodeId?: string;
  joinPolicy?: 'all_success' | 'any_success' | 'all_settled';
  downstreamNext?: string | null;
  childNodeIds?: string[];
  // Template-overview-only fields (kind === 'template').
  templateStageCount?: number;
  templateSelfStitches?: number; // count of retry edges back to itself
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  marker?: string;
  isTemplate?: boolean;
  // Retry self-stitches loop back to the template's entry from a
  // stage inside the same template. Tagged so the renderer can route
  // them around the lane instead of slicing through it.
  isRetry?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
