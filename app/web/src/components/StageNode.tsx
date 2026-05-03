import { Handle, Position } from '@xyflow/react';
import type { GraphNode } from '../lib/api.ts';

interface NodeData {
  stage: GraphNode;
}

export function StageNode({ data }: { data: NodeData }) {
  const { stage } = data;
  const cls = `stage-node ${stage.status}${stage.isTemplatePlaceholder ? ' template-placeholder' : ''}`;
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} />
      <div className="name">{stage.name}</div>
      <div className="kind">
        {stage.isTemplatePlaceholder ? `template: ${stage.templateName}` : stage.kind}
        {stage.isStitched && !stage.isTemplatePlaceholder ? ' · stitched' : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
