import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { GraphNode } from '../lib/api.ts';

interface NodeData {
  stage: GraphNode;
  revealIndex?: number;
}

const KIND_GLYPH: Record<'agent' | 'command' | 'barrier' | 'template', string> =
  {
    agent: '●',
    command: '▢',
    barrier: '⋈',
    template: '⌬',
  };

export function StageNode({ data }: { data: NodeData }) {
  const { stage, revealIndex } = data;

  if (stage.kind === 'barrier') {
    return <BarrierNode stage={stage} revealIndex={revealIndex} />;
  }
  if (stage.kind === 'template') {
    return <TemplateNode stage={stage} revealIndex={revealIndex} />;
  }

  const cls = [
    'stage-node-v2',
    stage.status,
    stage.isTemplatePlaceholder ? 'template-placeholder' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style: CSSProperties =
    typeof revealIndex === 'number'
      ? ({
          ['--reveal-delay' as never]: `${Math.min(revealIndex, 20) * 30}ms`,
        } as CSSProperties)
      : {};

  return (
    <div className={cls} style={style}>
      <Handle type="target" position={Position.Left} />
      <div className="stage-name">
        <span className="kind-glyph">
          {stage.isTemplatePlaceholder ? '◇' : (KIND_GLYPH[stage.kind] ?? '·')}
        </span>
        <span className="name-text">{stage.name}</span>
      </div>
      <div className="sub">
        {stage.isTemplatePlaceholder
          ? `template · ${stage.templateName ?? ''}`
          : stage.isStitched
            ? `${stage.kind} · stitched`
            : stage.kind}
      </div>
      {stage.retryCount && stage.retryCount > 0 ? (
        <span className="retry-pip" title={`${stage.retryCount} retries`}>
          ↻{stage.retryCount}
        </span>
      ) : stage.status === 'error' ? (
        <span className="err-glyph" title="error">
          ⚠
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function TemplateNode({
  stage,
  revealIndex,
}: {
  stage: GraphNode;
  revealIndex?: number;
}) {
  const style: CSSProperties =
    typeof revealIndex === 'number'
      ? ({
          ['--reveal-delay' as never]: `${Math.min(revealIndex, 20) * 30}ms`,
        } as CSSProperties)
      : {};
  const stageN = stage.templateStageCount ?? 0;
  const retries = stage.templateSelfStitches ?? 0;
  return (
    <div className="template-node" style={style} title={stage.templateName}>
      <Handle type="target" position={Position.Left} />
      <div className="template-glyph">⌬</div>
      <div className="template-meta">
        <div className="template-name">{stage.templateName}</div>
        <div className="template-sub">
          template · {stageN} stage{stageN === 1 ? '' : 's'}
          {retries > 0 ? ` · retry ×${retries}` : ''}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function BarrierNode({
  stage,
  revealIndex,
}: {
  stage: GraphNode;
  revealIndex?: number;
}) {
  const cls = ['barrier-node', stage.status].filter(Boolean).join(' ');
  const style: CSSProperties =
    typeof revealIndex === 'number'
      ? ({
          ['--reveal-delay' as never]: `${Math.min(revealIndex, 20) * 30}ms`,
        } as CSSProperties)
      : {};
  // Compact "sync point" rendering — the barrier shouldn't read as a
  // full stage node (which it isn't). Just a glyph + template name on
  // one short line. The full metadata (joinPolicy, stage/lane counts,
  // barrier id) lives in the tooltip.
  const fanCount = stage.childNodeIds?.length ?? 0;
  const stageN = stage.templateStageCount ?? 0;
  const retries = stage.templateSelfStitches ?? 0;
  const policy = stage.joinPolicy ?? 'all_success';
  const detail =
    fanCount > 0
      ? `${fanCount} lane${fanCount === 1 ? '' : 's'}`
      : stageN > 0
        ? `${stageN} stage${stageN === 1 ? '' : 's'}${retries > 0 ? ` · ↻${retries}` : ''}`
        : '';
  const tooltip = [stage.templateName, policy, detail, stage.barrierId]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={cls} style={style} title={tooltip}>
      <Handle type="target" position={Position.Left} />
      <span className="barrier-glyph">⋈</span>
      <span className="barrier-name">{stage.templateName}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
