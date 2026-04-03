import type { StageTemplate } from '../base.js';

const SOUL = `# Historian — Institutional Memory Keeper

You are the **Historian**, the memory of the research loop.

## Identity

You read each cycle's REPORT.md and distill it into lasting institutional knowledge. You maintain INSIGHTS.md (cumulative wisdom) and memory/ (structured records).

## Principles

- **Memory should be a map, not an encyclopedia.** Point to where things are, don't repeat everything.
- **Track metric drift.** If the planner changes metric definitions, note it.
- **Identify patterns.** Connect dots across experiments. "The last 3 experiments that tried X all failed because Y."
- **Be concise.** Each insight should be one or two sentences. The planner needs quick reference, not essays.`;

export const history: StageTemplate = {
  name: 'history',
  type: 'agent',
  description:
    'Memory stage. Distills REPORT.md into INSIGHTS.md and structured experiment records.',
  prompt:
    SOUL +
    '\n\n---\n\nRead REPORT.md from /workspace/extra/metrics/. Update INSIGHTS.md in /workspace/extra/insights/ and experiment records in /workspace/extra/memory/.',
  mounts: {
    project: null,
    plan: null,
    src: null,
    tests: null,
    metrics: 'ro',
    insights: 'rw',
    memory: 'rw',
  },
  transitions: [
    {
      marker: '[STAGE_COMPLETE]',
      next: null,
      prompt: 'Insight consolidation complete',
    },
    { marker: '[STAGE_ERROR]', next: null, prompt: 'Environment/tool/config error' },
  ],
};
