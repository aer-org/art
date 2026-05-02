import fs from 'fs';
import path from 'path';

import type { PipelineStage } from './pipeline-types.js';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function resolveAgentRefs(
  stages: PipelineStage[],
  bundleDir: string,
): void {
  for (const stage of stages) {
    const isCommand = typeof stage.command === 'string';
    if (isCommand) continue;

    if (stage.agent && stage.prompt) {
      throw new Error(
        `Stage "${stage.name}": cannot specify both "agent" and inline "prompt"`,
      );
    }

    if (!stage.agent) continue;

    if (!AGENT_NAME_PATTERN.test(stage.agent)) {
      throw new Error(
        `Stage "${stage.name}": agent name "${stage.agent}" must match ${AGENT_NAME_PATTERN}`,
      );
    }

    const agentPath = path.join(bundleDir, 'agents', `${stage.agent}.md`);
    if (!fs.existsSync(agentPath)) {
      throw new Error(
        `Stage "${stage.name}": agent file not found: ${agentPath}`,
      );
    }

    stage.prompt = fs.readFileSync(agentPath, 'utf-8');
  }
}
