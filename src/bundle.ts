import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface BundleMetadata {
  remote: string;
  pipeline_name: string;
  tag: string;
  project?: string;
  pulled_at: string;
  hashes: Record<string, string>;
}

const BUNDLE_META = '.art-bundle.json';

export function contentHash(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

export function loadBundleMeta(dir: string): BundleMetadata | null {
  const p = path.join(dir, BUNDLE_META);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BundleMetadata;
  } catch {
    return null;
  }
}

export function saveBundleMeta(dir: string, meta: BundleMetadata): void {
  fs.writeFileSync(path.join(dir, BUNDLE_META), JSON.stringify(meta, null, 2));
}

export function relativeBundlePath(dir: string, filePath: string): string {
  return path.relative(dir, filePath).replace(/\\/g, '/');
}

export interface BundleFile {
  relPath: string;
  absPath: string;
  content: string;
  hash: string;
}

export function readBundleFiles(dir: string): BundleFile[] {
  const files: BundleFile[] = [];

  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === BUNDLE_META || entry.name === '.art-bundle.json')
        continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const content = fs.readFileSync(full, 'utf8');
        files.push({
          relPath: relativeBundlePath(dir, full),
          absPath: full,
          content,
          hash: contentHash(content),
        });
      }
    }
  }

  walk(dir);
  return files;
}

export interface PipelineStageMinimal {
  name: string;
  kind?: string;
  command?: string;
  prompt?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface PipelineContentMinimal {
  stages?: PipelineStageMinimal[];
  [key: string]: unknown;
}

export function extractAgentPrompts(
  pipelineContent: PipelineContentMinimal,
): { stripped: PipelineContentMinimal; agents: Map<string, string> } {
  const agents = new Map<string, string>();
  if (!pipelineContent.stages) return { stripped: pipelineContent, agents };

  const strippedStages = pipelineContent.stages.map((stage) => {
    const isCommand = stage.kind === 'command' || typeof stage.command === 'string';
    if (isCommand || !stage.prompt || stage.agent) return stage;

    agents.set(stage.name, stage.prompt);
    const { prompt: _, ...rest } = stage;
    return rest;
  });

  return {
    stripped: { ...pipelineContent, stages: strippedStages },
    agents,
  };
}

export function assembleAgentPrompts(
  pipelineContent: PipelineContentMinimal,
  agentsDir: string,
): PipelineContentMinimal {
  if (!pipelineContent.stages || !fs.existsSync(agentsDir))
    return pipelineContent;

  const assembledStages = pipelineContent.stages.map((stage) => {
    const agentFile = path.join(agentsDir, `${stage.name}.md`);
    if (!fs.existsSync(agentFile)) return stage;

    const prompt = fs.readFileSync(agentFile, 'utf8');
    return { ...stage, prompt };
  });

  return { ...pipelineContent, stages: assembledStages };
}

export function classifyFile(relPath: string): {
  kind: 'agent' | 'pipeline' | 'template' | 'dockerfile' | 'unknown';
  name: string;
} {
  if (relPath.startsWith('agents/') && relPath.endsWith('.md')) {
    return { kind: 'agent', name: path.basename(relPath, '.md') };
  }
  if (relPath.startsWith('templates/') && relPath.endsWith('.json')) {
    return { kind: 'template', name: path.basename(relPath, '.json') };
  }
  if (relPath.startsWith('dockerfiles/') && relPath.endsWith('.Dockerfile')) {
    return { kind: 'dockerfile', name: path.basename(relPath, '.Dockerfile') };
  }
  if (relPath === 'pipeline.json') {
    return { kind: 'pipeline', name: 'pipeline' };
  }
  return { kind: 'unknown', name: path.basename(relPath) };
}
