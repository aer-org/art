import fs from 'fs';
import path from 'path';

import { resolveRemoteWithAuth } from '../remote-config.js';
import { RegistryApi } from '../registry-api.js';
import {
  contentHash,
  saveBundleMeta,
  extractAgentPrompts,
  type BundleMetadata,
  type PipelineContentMinimal,
} from '../bundle.js';

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
    console.error(
      'Usage: art pull <pipeline> [--tag <tag>] [--remote <name>] [--project <project>]',
    );
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

  // Extract inline agent prompts from pipeline content
  const { stripped, agents: inlineAgents } = extractAgentPrompts(
    bundle.pipeline.content as PipelineContentMinimal,
  );

  // pipeline.json (with prompts stripped out)
  const pipelineContent = JSON.stringify(stripped, null, 2);
  fs.writeFileSync(path.join(outDir, 'pipeline.json'), pipelineContent);
  hashes['pipeline.json'] = contentHash(pipelineContent);

  // agents/ — registry agents + inline agents extracted from pipeline
  const allAgents = new Map<string, string>();
  for (const [name, agent] of Object.entries(bundle.agents)) {
    allAgents.set(name, agent.system_prompt);
  }
  for (const [name, prompt] of inlineAgents) {
    allAgents.set(name, prompt);
  }

  if (allAgents.size > 0) {
    fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
    for (const [name, prompt] of allAgents) {
      const relPath = `agents/${name}.md`;
      fs.writeFileSync(path.join(outDir, relPath), prompt);
      hashes[relPath] = contentHash(prompt);
    }
  }

  // templates/ (dict: { [name]: { content, ... } })
  const templateNames = Object.keys(bundle.templates);
  if (templateNames.length > 0) {
    fs.mkdirSync(path.join(outDir, 'templates'), { recursive: true });
    for (const [name, tpl] of Object.entries(bundle.templates)) {
      // Extract inline prompts from templates too
      const { stripped: tplStripped, agents: tplAgents } = extractAgentPrompts(
        tpl.content as PipelineContentMinimal,
      );
      for (const [aName, aPrompt] of tplAgents) {
        if (!allAgents.has(aName)) {
          const relPath = `agents/${aName}.md`;
          fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
          fs.writeFileSync(path.join(outDir, relPath), aPrompt);
          hashes[relPath] = contentHash(aPrompt);
          allAgents.set(aName, aPrompt);
        }
      }
      const tplContent = JSON.stringify(tplStripped, null, 2);
      const relPath = `templates/${name}.json`;
      fs.writeFileSync(path.join(outDir, relPath), tplContent);
      hashes[relPath] = contentHash(tplContent);
    }
  }

  // dockerfiles/ (dict: { [name]: { content, ... } })
  const dockerfileNames = Object.keys(bundle.dockerfiles);
  if (dockerfileNames.length > 0) {
    fs.mkdirSync(path.join(outDir, 'dockerfiles'), { recursive: true });
    for (const [name, df] of Object.entries(bundle.dockerfiles)) {
      const relPath = `dockerfiles/${name}.Dockerfile`;
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
  if (allAgents.size > 0)
    console.log(
      `  agents/ (${allAgents.size} agent${allAgents.size > 1 ? 's' : ''})`,
    );
  if (templateNames.length > 0)
    console.log(
      `  templates/ (${templateNames.length} template${templateNames.length > 1 ? 's' : ''})`,
    );
  if (dockerfileNames.length > 0)
    console.log(
      `  dockerfiles/ (${dockerfileNames.length} dockerfile${dockerfileNames.length > 1 ? 's' : ''})`,
    );
}
