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
  kind: 'agent' | 'command';
  status: GraphNodeStatus;
  isStitched: boolean;
  isTemplatePlaceholder: boolean;
  templateName?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  marker?: string;
  isTemplate?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
