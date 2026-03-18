import JSZip from 'jszip';
import type { AgentConfig, PipelineConfig } from '../types';
import { serializeTeam } from './serialize';
import { deserializeTeam } from './deserialize';

export async function exportTeamZip(agents: AgentConfig[]): Promise<void> {
  const zip = new JSZip();
  const { teamJson, pipelines } = serializeTeam(agents);

  zip.file('AGENT_TEAM.json', teamJson);

  for (const agent of agents) {
    const pipelineJson = pipelines.get(agent.folder);
    if (pipelineJson) {
      zip.file(`${agent.folder}/PIPELINE.json`, pipelineJson);
    }

    // Plan file
    if (agent.files.plan) {
      zip.file(`${agent.folder}/plan/PLAN.md`, agent.files.plan);
    }

    // Src files
    for (const file of agent.files.src) {
      zip.file(`${agent.folder}/src/${agent.folder}/${file.name}`, file);
    }

    // Tb files
    for (const file of agent.files.tb) {
      zip.file(`${agent.folder}/tb/${file.name}`, file);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'team-project.zip';
  a.click();
  URL.revokeObjectURL(url);
}

export async function importTeamFolder(files: FileList): Promise<AgentConfig[]> {
  // Build a map of relative paths (strip the root folder name) to Files
  const fileMap = new Map<string, File>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = file.webkitRelativePath;
    // Strip the first segment (selected folder name)
    const idx = rel.indexOf('/');
    if (idx >= 0) {
      fileMap.set(rel.slice(idx + 1), file);
    }
  }

  // Read AGENT_TEAM.json
  const teamFile = fileMap.get('AGENT_TEAM.json');
  if (!teamFile) throw new Error('AGENT_TEAM.json not found in folder');
  const teamJson = JSON.parse(await teamFile.text());

  // Read each agent's PIPELINE.json
  const pipelines = new Map<string, PipelineConfig>();
  for (const entry of teamJson.agents) {
    const pipelineFile = fileMap.get(`${entry.folder}/PIPELINE.json`);
    if (pipelineFile) {
      pipelines.set(entry.folder, JSON.parse(await pipelineFile.text()));
    }
  }

  const agents = deserializeTeam(teamJson, pipelines);

  // Restore files from folder
  for (const agent of agents) {
    // Plan
    const planFile = fileMap.get(`${agent.folder}/plan/PLAN.md`);
    if (planFile) {
      agent.files.plan = new File([await planFile.arrayBuffer()], 'PLAN.md');
    }

    // Src files
    const srcPrefix = `${agent.folder}/src/${agent.folder}/`;
    agent.files.src = [];
    for (const [path, file] of fileMap) {
      if (path.startsWith(srcPrefix)) {
        const name = path.slice(srcPrefix.length);
        agent.files.src.push(new File([await file.arrayBuffer()], name));
      }
    }

    // Tb files
    const tbPrefix = `${agent.folder}/tb/`;
    agent.files.tb = [];
    for (const [path, file] of fileMap) {
      if (path.startsWith(tbPrefix)) {
        const name = path.slice(tbPrefix.length);
        agent.files.tb.push(new File([await file.arrayBuffer()], name));
      }
    }
  }

  return agents;
}

export async function importTeamZip(file: File): Promise<AgentConfig[]> {
  const zip = await JSZip.loadAsync(file);

  // Read AGENT_TEAM.json
  const teamFile = zip.file('AGENT_TEAM.json');
  if (!teamFile) throw new Error('AGENT_TEAM.json not found in ZIP');
  const teamJson = JSON.parse(await teamFile.async('string'));

  // Read each agent's PIPELINE.json
  const pipelines = new Map<string, PipelineConfig>();
  for (const entry of teamJson.agents) {
    const pipelineFile = zip.file(`${entry.folder}/PIPELINE.json`);
    if (pipelineFile) {
      pipelines.set(entry.folder, JSON.parse(await pipelineFile.async('string')));
    }
  }

  const agents = deserializeTeam(teamJson, pipelines);

  // Restore files from ZIP
  for (const agent of agents) {
    // Plan
    const planFile = zip.file(`${agent.folder}/plan/PLAN.md`);
    if (planFile) {
      const content = await planFile.async('blob');
      agent.files.plan = new File([content], 'PLAN.md');
    }

    // Src files
    const srcPrefix = `${agent.folder}/src/${agent.folder}/`;
    const srcFiles: File[] = [];
    zip.forEach((path, entry) => {
      if (path.startsWith(srcPrefix) && !entry.dir) {
        srcFiles.push({ path, entry } as any);
      }
    });
    agent.files.src = [];
    for (const { path, entry } of srcFiles as any[]) {
      const content = await entry.async('blob');
      const name = path.slice(srcPrefix.length);
      agent.files.src.push(new File([content], name));
    }

    // Tb files
    const tbPrefix = `${agent.folder}/tb/`;
    const tbFiles: File[] = [];
    zip.forEach((path, entry) => {
      if (path.startsWith(tbPrefix) && !entry.dir) {
        tbFiles.push({ path, entry } as any);
      }
    });
    agent.files.tb = [];
    for (const { path, entry } of tbFiles as any[]) {
      const content = await entry.async('blob');
      const name = path.slice(tbPrefix.length);
      agent.files.tb.push(new File([content], name));
    }
  }

  return agents;
}
