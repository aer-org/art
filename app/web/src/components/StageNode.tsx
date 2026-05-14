import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { GraphNode } from '../lib/api.ts';

interface NodeData {
  stage: GraphNode;
  revealIndex?: number;
}

const KIND_GLYPH: Record<'agent' | 'command', string> = {
  agent: '●',
  command: '▢',
};

export function StageNode({ data }: { data: NodeData }) {
  const { stage, revealIndex } = data;
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
