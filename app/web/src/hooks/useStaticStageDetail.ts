/**
 * useStaticStageDetail — overview-mode counterpart to useStageDetail.
 *
 * No fetch: synthesizes a StageSidebarData from the locally-loaded
 * PIPELINE.json stage. Used by LivePage when there is no active run,
 * so the user can click a stage and see what was authored (prompt /
 * command / mounts) without waiting for execution.
 *
 * Output / Internal sections of StageSidebar end up empty — the
 * overview-mode sidebar hides them entirely via the `overview` prop.
 */
import { useMemo } from 'react';

import type { StageSidebarData } from './useStageDetail.ts';

interface StaticMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface StaticStage {
  name: string;
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
  gpu?: boolean;
  privileged?: boolean;
  runAsRoot?: boolean;
}

/**
 * Per-mount synthesis. We don't know the resolved host path pre-run
 * (it depends on the project root, sub-path overrides, etc.), so we
 * surface "(resolved at run time)" for hostPath. containerPath follows
 * the docs/PIPELINE-REFERENCE.md mount key conventions.
 */
function synthesizeMounts(
  stage: StaticStage,
): { mounts: StaticMount[]; hostMounts: StaticMount[] } {
  const mounts: StaticMount[] = [];
  for (const [key, mode] of Object.entries(stage.mounts ?? {})) {
    if (mode == null) continue; // hidden mount — skip
    const containerPath = key === 'project'
      ? '/workspace/project/'
      : key.startsWith('project:')
        ? `/workspace/project/${key.slice('project:'.length)}/`
        : key.includes(':')
          ? `/workspace/${key.split(':')[0]}/${key.split(':').slice(1).join(':')}/`
          : `/workspace/${key}/`;
    mounts.push({
      hostPath: '(resolved at run time)',
      containerPath,
      readonly: mode === 'ro',
    });
  }
  const hostMounts: StaticMount[] = (stage.hostMounts ?? []).map((m) => ({
    hostPath: m.hostPath,
    containerPath: `/workspace/extra/${m.containerPath ?? ''}`,
    readonly: m.readonly !== false,
  }));
  return { mounts, hostMounts };
}

export function useStaticStageDetail(
  stage: StaticStage | null,
): StageSidebarData {
  return useMemo(() => {
    if (!stage) {
      return {
        stage: null,
        events: [],
        turns: [],
        diffSummary: null,
        loading: false,
        error: null,
      };
    }
    const { mounts, hostMounts } = synthesizeMounts(stage);
    const hasMountsOrEnv =
      mounts.length > 0 || hostMounts.length > 0 || !!stage.image;
    const container = hasMountsOrEnv
      ? {
          image: stage.image,
          mode: stage.command ? 'command' : 'agent',
          gpu: stage.gpu ?? false,
          privileged: stage.privileged ?? false,
          runAsRoot: stage.runAsRoot ?? false,
          mounts: [...mounts, ...hostMounts],
          env: stage.env ?? {},
        }
      : null;
    return {
      stage: {
        nodeId: 'root',
        stageName: stage.name,
        // The raw stage record; sidebar uses it for matched marker /
        // transition target / etc. Overview hides those sections, so an
        // empty record is enough.
        stage: null,
        container,
        substitutions: null,
        promptSource: stage.promptSource ?? null,
        hasPrompt: !!stage.prompt,
        hasInitial: false,
        hasCommand: !!stage.command,
        hasDiff: false,
        hasTranscript: false,
        diffMounts: [],
        turnCount: 0,
        streamSizes: { agent: 0, stdout: 0, stderr: 0 },
      },
      events: [],
      turns: [],
      diffSummary: null,
      loading: false,
      error: null,
    };
  }, [stage]);
}
