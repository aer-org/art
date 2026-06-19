/**
 * useAuthoredStage — derive an AuthoredStage (Tier 1) from a graph node.
 *
 * Looks up the authored stage config in either the base pipeline or
 * the referenced template. The graph node carries everything needed
 * for a single lookup path:
 *   - n.templateName + n.localName → templates[templateName].stages[localName]
 *   - else (base stage)            → pipeline.stages[localName]
 *
 * Returns null when the snapshot doesn't carry enough info yet to
 * resolve the config (no project loaded, templates not shipped, etc.).
 */
import { useMemo } from 'react';

import type {
  AuthoredStage,
  GraphNode,
  PipelineSnapshot,
} from '../lib/api.ts';

interface RawStage {
  name: string;
  kind?: 'agent' | 'command';
  agent?: string;
  prompt?: string;
  promptSource?: string;
  command?: string;
  image?: string;
  mounts?: Record<string, 'ro' | 'rw' | null | undefined>;
  hostMounts?: Array<{
    hostPath: string;
    containerPath?: string;
    readonly?: boolean;
  }>;
  env?: Record<string, string>;
  successMarker?: string;
  errorMarker?: string;
  timeout?: number;
  privileged?: boolean;
  runAsRoot?: boolean;
  transitions?: Array<{
    marker?: string;
    next?: string | string[] | null;
    template?: string;
  }>;
  [extra: string]: unknown;
}

function inferKind(s: RawStage): 'agent' | 'command' {
  return s.kind ?? (typeof s.command === 'string' ? 'command' : 'agent');
}

function rawToAuthored(
  raw: RawStage,
  templateName: string | undefined,
  localName: string,
): AuthoredStage {
  const kind = inferKind(raw);
  return {
    name: raw.name,
    kind,
    agent: raw.agent,
    prompt: raw.prompt,
    promptSource: raw.promptSource,
    command: raw.command,
    scriptStageName: kind === 'command' ? localName : undefined,
    image: raw.image,
    mounts: raw.mounts,
    hostMounts: raw.hostMounts,
    env: raw.env,
    successMarker: raw.successMarker,
    errorMarker: raw.errorMarker,
    timeout: raw.timeout,
    privileged: raw.privileged,
    runAsRoot: raw.runAsRoot,
    transitions: raw.transitions,
    templateName,
    localName,
  };
}

export function useAuthoredStage(
  snapshot: PipelineSnapshot,
  node: GraphNode | null,
): AuthoredStage | null {
  return useMemo(() => {
    if (!node) return null;
    // The graph node carries templateName + localName as proper
    // fields (set by both the server-built live graph and the
    // client-built overview graph). One lookup, two sources.
    const localName = node.localName ?? node.name;
    if (node.templateName) {
      const tpl = snapshot.templates?.[node.templateName];
      const found = (tpl?.stages ?? []).find(
        (s) => (s as RawStage).name === localName,
      ) as RawStage | undefined;
      if (found) return rawToAuthored(found, node.templateName, localName);
      return null;
    }
    const stages = (snapshot.pipeline?.stages ?? []) as RawStage[];
    const found = stages.find((s) => s.name === localName);
    if (found) return rawToAuthored(found, undefined, localName);
    return null;
  }, [snapshot.pipeline, snapshot.templates, node]);
}
