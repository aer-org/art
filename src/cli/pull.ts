import fs from 'fs';
import path from 'path';

import { resolveRemoteWithAuth } from '../remote-config.js';
import { RegistryApi } from '../registry-api.js';
import { contentHash, saveBundleMeta, type BundleMetadata } from '../bundle.js';

function parseArgs(args: string[]): {
  pipeline: string;
  tag: string;
  remote?: string;
  project?: string;
} {
  let pipeline = '';
  let tag = 'latest';
  let remote: string | undefined;
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      tag = args[++i];
    } else if (args[i] === '--remote' && args[i + 1]) {
      remote = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      project = args[++i];
    } else if (!args[i].startsWith('--')) {
      pipeline = args[i];
    }
  }

  if (!pipeline) {
    console.error('Usage: art pull <pipeline> [--tag <tag>] [--remote <name>] [--project <project>]');
    process.exit(1);
  }
  return { pipeline, tag, remote, project };
}

export async function pull(args: string[]): Promise<void> {
  const { pipeline, tag, remote: remoteName, project } = parseArgs(args);
  const { name: rName, url, token } = resolveRemoteWithAuth(remoteName);
  const api = new RegistryApi(url, token);

  console.log(`Pulling ${pipeline}:${tag} from ${rName}...`);

  const bundle = await api.fetchBundle(pipeline, tag, project);
  const outDir = path.resolve(pipeline);
  const hashes: Record<string, string> = {};

  fs.mkdirSync(outDir, { recursive: true });

  // pipeline.json
  const pipelineContent = JSON.stringify(bundle.pipeline.config, null, 2);
  fs.writeFileSync(path.join(outDir, 'pipeline.json'), pipelineContent);
  hashes['pipeline.json'] = contentHash(pipelineContent);

  // agents/
  if (bundle.agents.length > 0) {
    fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
    for (const agent of bundle.agents) {
      const relPath = `agents/${agent.name}.md`;
      fs.writeFileSync(path.join(outDir, relPath), agent.system_prompt);
      hashes[relPath] = contentHash(agent.system_prompt);
    }
  }

  // templates/
  if (bundle.templates.length > 0) {
    fs.mkdirSync(path.join(outDir, 'templates'), { recursive: true });
    for (const tpl of bundle.templates) {
      const content = JSON.stringify(tpl.config, null, 2);
      const relPath = `templates/${tpl.name}.json`;
      fs.writeFileSync(path.join(outDir, relPath), content);
      hashes[relPath] = contentHash(content);
    }
  }

  // dockerfiles/
  if (bundle.dockerfiles.length > 0) {
    fs.mkdirSync(path.join(outDir, 'dockerfiles'), { recursive: true });
    for (const df of bundle.dockerfiles) {
      const relPath = `dockerfiles/${df.image_name}.Dockerfile`;
      fs.writeFileSync(path.join(outDir, relPath), df.content);
      hashes[relPath] = contentHash(df.content);
    }
  }

  // .art-bundle.json
  const meta: BundleMetadata = {
    remote: rName,
    pipeline_name: pipeline,
    tag,
    project,
    pulled_at: new Date().toISOString(),
    hashes,
  };
  saveBundleMeta(outDir, meta);

  console.log(`\nPulled to ./${pipeline}/`);
  console.log(`  pipeline.json`);
  if (bundle.agents.length > 0)
    console.log(`  agents/ (${bundle.agents.length} agent${bundle.agents.length > 1 ? 's' : ''})`);
  if (bundle.templates.length > 0)
    console.log(`  templates/ (${bundle.templates.length} template${bundle.templates.length > 1 ? 's' : ''})`);
  if (bundle.dockerfiles.length > 0)
    console.log(`  dockerfiles/ (${bundle.dockerfiles.length} dockerfile${bundle.dockerfiles.length > 1 ? 's' : ''})`);
}
