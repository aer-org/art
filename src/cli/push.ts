import fs from 'fs';
import path from 'path';

import { resolveRemoteWithAuth } from '../remote-config.js';
import { RegistryApi } from '../registry-api.js';
import {
  loadBundleMeta,
  saveBundleMeta,
  readBundleFiles,
  classifyFile,
  assembleAgentPrompts,
} from '../bundle.js';

function parseArgs(args: string[]): {
  dir: string;
  remote?: string;
  name?: string;
  project?: string;
} {
  let dir = '.';
  let remote: string | undefined;
  let name: string | undefined;
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--remote' && args[i + 1]) {
      remote = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      project = args[++i];
    } else if (!args[i].startsWith('--')) {
      dir = args[i];
    }
  }
  return { dir, remote, name, project };
}

function findPipelineJson(dir: string): string | null {
  for (const candidate of ['pipeline.json', 'PIPELINE.json']) {
    if (fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

export async function push(args: string[]): Promise<void> {
  const {
    dir: rawDir,
    remote: remoteName,
    name: nameFlag,
    project: projectFlag,
  } = parseArgs(args);
  const dir = path.resolve(rawDir);

  let meta = loadBundleMeta(dir);

  if (!meta) {
    const pipelineFile = findPipelineJson(dir);
    if (!pipelineFile) {
      console.error(`No pipeline.json or PIPELINE.json found in ${dir}.`);
      process.exit(1);
    }

    const pipelineName =
      nameFlag ?? path.basename(dir === '.' ? process.cwd() : dir);
    const { name: rName } = resolveRemoteWithAuth(remoteName);

    meta = {
      remote: rName,
      pipeline_name: pipelineName,
      tag: 'latest',
      project: projectFlag,
      pulled_at: new Date().toISOString(),
      hashes: {},
    };
    console.log(
      `No .art-bundle.json found — initial push as "${pipelineName}" to ${rName}`,
    );
  }

  const effectiveRemote = remoteName ?? meta.remote;
  const { name: rName, url, token } = resolveRemoteWithAuth(effectiveRemote);
  const api = new RegistryApi(url, token);

  const files = readBundleFiles(dir);
  const newHashes: Record<string, string> = {};
  const agentsDir = path.join(dir, 'agents');

  // Pass 1: classify all files, detect changes
  let anyAgentChanged = false;
  const classified = files.map((file) => {
    let { kind, name } = classifyFile(file.relPath);
    if (kind === 'unknown' && file.relPath.toUpperCase() === 'PIPELINE.JSON') {
      kind = 'pipeline';
      name = 'pipeline';
    }
    const originalHash = meta!.hashes[file.relPath];
    const changed = !originalHash || originalHash !== file.hash;
    if (changed && kind === 'agent') anyAgentChanged = true;
    return { file, kind, name, changed };
  });

  // Pass 2: push changed resources
  // If any agent changed, force re-push pipeline+templates (prompts are assembled into them)
  const counts = {
    agents: 0,
    pipelines: 0,
    dockerfiles: 0,
    templates: 0,
    unchanged: 0,
  };

  for (const { file, kind, name, changed } of classified) {
    const forcePush =
      !changed &&
      anyAgentChanged &&
      (kind === 'pipeline' || kind === 'template');

    if (!changed && !forcePush) {
      console.log(`  ${file.relPath}  unchanged → skip`);
      counts.unchanged++;
      newHashes[file.relPath] = file.hash;
      continue;
    }

    const label = !meta!.hashes[file.relPath]
      ? 'new'
      : forcePush
        ? 'reassemble'
        : 'changed';

    switch (kind) {
      case 'agent':
        await api.pushAgent({
          name,
          system_prompt: file.content,
          dockerfile: { name: 'vcs-agent' },
          project: meta!.project,
        });
        console.log(`  ${file.relPath}  ${label} → pushed`);
        counts.agents++;
        newHashes[file.relPath] = file.hash;
        break;

      case 'pipeline': {
        const raw = JSON.parse(file.content);
        const content = assembleAgentPrompts(raw, agentsDir);
        await api.pushPipeline({
          name: meta!.pipeline_name,
          content: content as Record<string, unknown>,
          kind: 'pipeline',
          project: meta!.project,
        });
        console.log(`  ${file.relPath}  ${label} → pushed`);
        counts.pipelines++;
        newHashes[file.relPath] = file.hash;
        break;
      }

      case 'template': {
        const raw = JSON.parse(file.content);
        const content = assembleAgentPrompts(raw, agentsDir);
        await api.pushPipeline({
          name,
          content: content as Record<string, unknown>,
          kind: 'template',
          project: meta!.project,
        });
        console.log(`  ${file.relPath}  ${label} → pushed`);
        counts.templates++;
        newHashes[file.relPath] = file.hash;
        break;
      }

      case 'dockerfile':
        await api.pushDockerfile({ name, content: file.content });
        console.log(`  ${file.relPath}  ${label} → pushed`);
        counts.dockerfiles++;
        newHashes[file.relPath] = file.hash;
        break;

      default:
        console.log(`  ${file.relPath}  skipped (unknown type)`);
    }
  }

  const parts: string[] = [];
  if (counts.agents > 0)
    parts.push(`${counts.agents} agent${counts.agents > 1 ? 's' : ''}`);
  if (counts.pipelines > 0)
    parts.push(
      `${counts.pipelines} pipeline${counts.pipelines > 1 ? 's' : ''}`,
    );
  if (counts.templates > 0)
    parts.push(
      `${counts.templates} template${counts.templates > 1 ? 's' : ''}`,
    );
  if (counts.dockerfiles > 0)
    parts.push(
      `${counts.dockerfiles} dockerfile${counts.dockerfiles > 1 ? 's' : ''}`,
    );

  if (parts.length === 0) {
    console.log(`\nNothing to push — all files unchanged.`);
  } else {
    meta!.hashes = newHashes;
    meta!.pulled_at = new Date().toISOString();
    saveBundleMeta(dir, meta!);
    console.log(`\n✓ Published to ${rName}: ${parts.join(', ')} updated`);
  }
}
