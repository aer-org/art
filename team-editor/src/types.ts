// Mirrors PipelineStage/PipelineConfig from src/pipeline-runner.ts

export interface PipelineTransition {
  marker: string;
  next?: string | null;
  retry?: boolean;
  prompt?: string;
}

export interface PipelineStage {
  name: string;
  prompt: string;
  image?: string; // Registry key (agent mode) or image name (command mode)
  command?: string; // Shell command mode (runs sh -c, no agent)
  mounts: Record<string, 'ro' | 'rw' | null | undefined>;
  devices?: string[];
  runAsRoot?: boolean;
  exclusive?: string;
  transitions: PipelineTransition[];
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
  errorPolicy: {
    maxConsecutive: number;
    debugOnMaxErrors: boolean;
  };
}

// Default mount keys and their allowed modes for the UI (fallback when dirs not available).
export const DEFAULT_MOUNT_OPTIONS: Record<string, string[]> = {
  plan: ['ro', 'null'],
  src: ['rw', 'ro', 'null'],
  tb: ['ro', 'null'],
  build: ['rw', 'null'],
  sim: ['rw', 'null'],
};

/** Build mount options map from actual __art__/ directories + any extra keys from the stage */
export function getMountOptions(
  stage: PipelineStage,
  artDirs?: string[],
): Record<string, string[]> {
  const opts: Record<string, string[]> = {};
  // If we have actual directory list, use those as the base
  if (artDirs && artDirs.length > 0) {
    for (const dir of artDirs) {
      opts[dir] = ['rw', 'ro', 'null'];
    }
  } else {
    Object.assign(opts, DEFAULT_MOUNT_OPTIONS);
  }
  // Also include any extra keys already in the stage's mounts (skip project:* sub-mounts)
  for (const key of Object.keys(stage.mounts)) {
    if (key.startsWith('project:') || key.startsWith('art:')) continue; // handled by MountOverlay
    if (!opts[key]) {
      opts[key] = ['rw', 'ro', 'null'];
    }
  }
  // Project mount (parent of __art__/) — always available
  opts['project'] = ['ro', 'rw', 'null'];
  return opts;
}

export const DEFAULT_TRANSITIONS: PipelineTransition[] = [
  { marker: 'STAGE_COMPLETE', next: null, prompt: '작업이 성공적으로 완료됨' },
  { marker: 'STAGE_ERROR', retry: true, prompt: '환경/도구/설정 에러' },
  { marker: 'STAGE_ERROR_CODE', next: null, prompt: '코드 수정이 필요한 에러' },
];

export const DEFAULT_STAGE: PipelineStage = {
  name: 'new_stage',
  prompt:
    'Describe what this stage should do. The agent will follow these instructions.',
  mounts: {},
  transitions: DEFAULT_TRANSITIONS.map((t) => ({ ...t })),
};

// Team editor types

export interface AgentFiles {
  plan: File | null;
  src: File[];
  tb: File[];
}

export interface AgentConfig {
  name: string;
  folder: string;
  pipeline: PipelineConfig;
  files: AgentFiles;
}

export interface TeamProject {
  agents: AgentConfig[];
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  stages: [],
  errorPolicy: { maxConsecutive: 3, debugOnMaxErrors: true },
};

export const DEFAULT_AGENT_FILES: AgentFiles = {
  plan: null,
  src: [],
  tb: [],
};
