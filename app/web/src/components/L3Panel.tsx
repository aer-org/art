/**
 * L3Panel — slide-in container for the "view X" stage detail panels.
 *
 * Sits to the right of StageSidebar (grid-push); closing returns to
 * sidebar-only. Renders the right sub-component based on `kind`. Each
 * sub-component fetches its own data lazily.
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
import type { StageDetail } from '../lib/api.ts';

interface Props {
  runId: string;
  nodeId: string;
  stageName: string;
  kind: L3PanelKind;
  mount?: string;
  stage: StageDetail | null;
  events: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  diffSummary: Record<string, unknown> | null;
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

export function L3Panel({
  runId,
  nodeId,
  stageName,
  kind,
  mount,
  stage,
  events,
  turns,
  diffSummary,
  onClose,
}: Props) {
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
          <L3PromptViewer
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            promptSource={stage?.promptSource ?? null}
          />
        )}
        {kind === 'initial' && (
          <L3PromptViewer
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            initial
          />
        )}
        {kind === 'command' && (
          <L3CommandViewer
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
          />
        )}
        {kind === 'mounts' && <L3ContainerInfo container={stage?.container ?? null} />}
        {kind === 'diff' && (
          <L3DiffViewer
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            mounts={stage?.diffMounts ?? []}
            summary={diffSummary}
            initialMount={mount}
          />
        )}
        {kind === 'turns' && <L3TurnsTable turns={turns} />}
        {kind === 'transcript' && (
          <L3TranscriptViewer
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
          />
        )}
        {kind === 'decisions' && <L3DecisionsList events={events} />}
        {kind === 'stream' && (
          <L3StreamTail
            runId={runId}
            nodeId={nodeId}
            stageName={stageName}
            sizes={stage?.streamSizes ?? null}
          />
        )}
      </div>
    </aside>
  );
}
