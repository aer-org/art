/**
 * Server-side template loading for the visualizer.
 *
 * Walks `template:` transitions transitively from the base pipeline and
 * returns the raw template files. The client (web/src/lib/templateOverview.ts)
 * is the sole graph builder for the template-overview view — this module
 * supplies the raw inputs.
 *
 * The post-stitch live/sealed graph still lives in pipeline-graph.ts;
 * only the "space of possible flows" graph is purely client-side.
 */
import fs from 'fs';
import path from 'path';

import type { PipelineConfig, PipelineStage } from './types.ts';

export interface TemplateFile {
  entry?: string;
  stages: PipelineStage[];
}

/**
 * Walk pipeline.stages, follow every `template:` reference transitively,
 * and return the raw template files. Used so the client can expand a
 * template inline without round-tripping to the server. Same containment
 * check as readTemplate.
 */
export function collectReferencedTemplates(
  config: PipelineConfig | null,
  artDir: string,
): Record<string, TemplateFile> {
  const out: Record<string, TemplateFile> = {};
  const queue: string[] = [];
  const seen = new Set<string>();
  function enqueue(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    queue.push(name);
  }
  for (const s of config?.stages ?? []) {
    for (const t of s.transitions ?? []) {
      if (t.template) enqueue(t.template);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    const tpl = readTemplate(artDir, name);
    if (!tpl) continue;
    out[name] = tpl;
    for (const s of tpl.stages ?? []) {
      for (const t of s.transitions ?? []) {
        if (t.template) enqueue(t.template);
      }
    }
  }
  return out;
}

const AGENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function readTemplate(
  artDir: string,
  name: string,
): TemplateFile | null {
  // Mirrors src/pipeline-template.ts:resolveTemplatePath containment check.
  const dir = path.join(artDir, 'templates');
  const resolved = path.resolve(dir, `${name}.json`);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
  try {
    const tpl = JSON.parse(raw) as TemplateFile;
    // Resolve agent-ref prompts inline so the client can render the
    // authored text directly. Matches the pipeline-watcher behavior for
    // the base pipeline file.
    for (const stage of tpl.stages ?? []) {
      const ref = (stage as { agent?: string }).agent;
      if (!ref || stage.prompt) continue;
      if (!AGENT_REF_PATTERN.test(ref)) continue;
      const aPath = path.join(artDir, 'agents', `${ref}.md`);
      try {
        stage.prompt = fs.readFileSync(aPath, 'utf-8');
        (stage as { promptSource?: string }).promptSource = `agents/${ref}.md`;
      } catch {
        /* missing agent file — leave empty */
      }
    }
    return tpl;
  } catch {
    return null;
  }
}
