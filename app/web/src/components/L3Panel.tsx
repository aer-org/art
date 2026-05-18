/**
 * L3Panel — slide-in container for the "view X" stage detail panels.
 *
 * Sits to the right of StageSidebar (grid-push); closing returns to
 * sidebar-only. Renders the right sub-component based on `kind`. Each
 * sub-component fetches its own data lazily.
 *
 * Data sources (single rule, no caller flag):
 *   - `prompt` / `command` / `mounts`: prefer per-run archive when
 *     `execution.stage` is available; otherwise fall back to the
 *     authored config. Other panel kinds (initial, diff, turns,
 *     transcript, decisions, stream) are execution-only.
 */
import { L3PromptViewer } from './L3PromptViewer.tsx';
import { L3CommandViewer } from './L3CommandViewer.tsx';
import { L3ContainerInfo } from './L3ContainerInfo.tsx';
import { L3DiffViewer } from './L3DiffViewer.tsx';
import { L3TurnsTable } from './L3TurnsTable.tsx';
import { L3DecisionsList } from './L3DecisionsList.tsx';
import { L3StreamTail } from './L3StreamTail.tsx';
import { L3TranscriptViewer } from './L3TranscriptViewer.tsx';
import type { L3PanelKind } from './StageSidebar.tsx';
import type { StageSidebarData } from '../hooks/useStageDetail.ts';
import type { AuthoredStage } from '../lib/api.ts';

interface Props {
  // What this panel applies to.
  nodeId: string;
  stageName: string;
  // null when the user is browsing without a run in scope (overview).
  runId: string | null;
  // The two sources. Either may be null; the panel picks based on
  // what's available for the requested `kind`.
  authored: AuthoredStage | null;
  execution: StageSidebarData | null;
  kind: L3PanelKind;
  mount?: string;
  onClose: () => void;
}

const TITLES: Record<L3PanelKind, string> = {
  prompt: 'Prompt',
  initial: 'Initial handoff',
  command: 'Command',
  mounts: 'Container mounts',
  diff: 'Artifact diff',
  turns: 'Turns',
  transcript: 'Transcript',
  decisions: 'Decisions',
  stream: 'Stream tail',
};

/**
 * Synthesize a container-shaped record from an AuthoredStage so
 * L3ContainerInfo can render the authored declaration when no
 * execution container.json exists.
 */
function authoredContainerView(
  authored: AuthoredStage,
): Record<string, unknown> {
  const mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];
  for (const [key, mode] of Object.entries(authored.mounts ?? {})) {
    if (mode == null) continue;
    const containerPath =
      key === 'project'
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
  for (const m of authored.hostMounts ?? []) {
    mounts.push({
      hostPath: m.hostPath,
      containerPath: `/workspace/extra/${m.containerPath ?? ''}`,
      readonly: m.readonly !== false,
    });
  }
  return {
    mode: authored.kind,
    image: authored.image,
    privileged: authored.privileged ?? false,
    runAsRoot: authored.runAsRoot ?? false,
    mounts,
    env: authored.env ?? {},
  };
}

export function L3Panel({
  nodeId,
  stageName,
  runId,
  authored,
  execution,
  kind,
  mount,
  onClose,
}: Props) {
  const exec = execution?.stage ?? null;

  return (
    <aside className="l3-panel inspector">
      <header className="l3-header">
        <div>
          <div className="label">view</div>
          <div className="value large">{TITLES[kind]}</div>
        </div>
        <button className="sidebar-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="l3-body">
        {kind === 'prompt' && (
          <PromptPanel
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            authored={authored}
            executionPromptSource={exec?.promptSource ?? null}
            executionHasPrompt={exec?.hasPrompt === true}
          />
        )}
        {kind === 'initial' && (
          <InitialPanel
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            available={exec?.hasInitial === true}
          />
        )}
        {kind === 'command' && (
          <CommandPanel
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            authored={authored}
            executionHasCommand={exec?.hasCommand === true}
          />
        )}
        {kind === 'mounts' && (
          <MountsPanel exec={exec} authored={authored} />
        )}
        {kind === 'diff' && (
          <DiffPanel
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            diffMounts={exec?.diffMounts ?? []}
            summary={execution?.diffSummary ?? null}
            initialMount={mount}
          />
        )}
        {kind === 'turns' && (
          <L3TurnsTable turns={execution?.turns ?? []} />
        )}
        {kind === 'transcript' &&
          (runId && exec?.hasTranscript ? (
            <L3TranscriptViewer
              runId={runId}
              nodeId={nodeId}
              stageName={stageName}
            />
          ) : (
            <NoExecution label="transcript" />
          ))}
        {kind === 'decisions' && (
          <L3DecisionsList events={execution?.events ?? []} />
        )}
        {kind === 'stream' &&
          (runId && exec ? (
            <L3StreamTail
              runId={runId}
              nodeId={nodeId}
              stageName={stageName}
              sizes={exec.streamSizes}
            />
          ) : (
            <NoExecution label="stream" />
          ))}
      </div>
    </aside>
  );
}

// --- Per-kind panels ---------------------------------------------------

function PromptPanel(props: {
  runId: string | null;
  nodeId: string;
  stageName: string;
  authored: AuthoredStage | null;
  executionPromptSource: string | null;
  executionHasPrompt: boolean;
}) {
  // Prefer the per-run archive (might differ from authored if the
  // pipeline file was edited between this run and now). Fall back to
  // the authored body for un-executed lanes.
  if (props.runId && props.executionHasPrompt) {
    return (
      <L3PromptViewer
        runId={props.runId}
        nodeId={props.nodeId}
        stageName={props.stageName}
        promptSource={props.executionPromptSource}
      />
    );
  }
  if (props.authored?.prompt != null) {
    return (
      <L3PromptViewer
        text={props.authored.prompt}
        promptSource={props.authored.promptSource ?? null}
      />
    );
  }
  return <NoExecution label="prompt" />;
}

function InitialPanel(props: {
  runId: string | null;
  nodeId: string;
  stageName: string;
  available: boolean;
}) {
  if (!props.runId || !props.available) return <NoExecution label="initial" />;
  return (
    <L3PromptViewer
      runId={props.runId}
      nodeId={props.nodeId}
      stageName={props.stageName}
      initial
    />
  );
}

function CommandPanel(props: {
  runId: string | null;
  nodeId: string;
  stageName: string;
  authored: AuthoredStage | null;
  executionHasCommand: boolean;
}) {
  if (props.runId && props.executionHasCommand) {
    return (
      <L3CommandViewer
        runId={props.runId}
        nodeId={props.nodeId}
        stageName={props.stageName}
      />
    );
  }
  if (props.authored?.kind === 'command') {
    if (props.authored.scriptStageName) {
      return (
        <L3CommandViewer
          scriptStageName={props.authored.scriptStageName}
          meta={authoredCommandMeta(props.authored)}
        />
      );
    }
    return (
      <L3CommandViewer
        text={props.authored.command ?? ''}
        meta={authoredCommandMeta(props.authored)}
      />
    );
  }
  return <NoExecution label="command" />;
}

function MountsPanel(props: {
  exec: { container: Record<string, unknown> | null } | null;
  authored: AuthoredStage | null;
}) {
  if (props.exec?.container) {
    return <L3ContainerInfo container={props.exec.container} />;
  }
  if (props.authored) {
    return <L3ContainerInfo container={authoredContainerView(props.authored)} />;
  }
  return <NoExecution label="container" />;
}

function DiffPanel(props: {
  runId: string | null;
  nodeId: string;
  stageName: string;
  diffMounts: string[];
  summary: Record<string, unknown> | null;
  initialMount?: string;
}) {
  if (!props.runId) return <NoExecution label="diff" />;
  return (
    <L3DiffViewer
      runId={props.runId}
      nodeId={props.nodeId}
      stageName={props.stageName}
      mounts={props.diffMounts}
      summary={props.summary}
      initialMount={props.initialMount}
    />
  );
}

function NoExecution({ label }: { label: string }) {
  return (
    <p className="muted">
      No {label} archived for this stage — it hasn’t been executed yet in
      this run.
    </p>
  );
}

function authoredCommandMeta(
  authored: AuthoredStage,
): Record<string, unknown> {
  return {
    shell: 'sh -c',
    timeoutMs: authored.timeout,
    successMarker: authored.successMarker,
    errorMarker: authored.errorMarker,
    env: authored.env ?? {},
  };
}
