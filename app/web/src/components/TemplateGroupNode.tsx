/**
 * Containment box for an inline-expanded template. Renders the dashed
 * accent border + template name in the corner. Provides Handles so the
 * post-stitch return edge (`group:X → Y`) can attach to the box edge —
 * those hops are scope-level (mediated by the barrier), not transitions
 * of any one lane stage, so we draw them from the container itself.
 */
import { Handle, Position } from '@xyflow/react';

interface NodeData {
  templateName: string;
}

export function TemplateGroupNode({ data }: { data: NodeData }) {
  return (
    <div className="template-group">
      <div className="template-group-label">{data.templateName}</div>
      <Handle type="target" position={Position.Left} className="group-handle" />
      <Handle type="source" position={Position.Right} className="group-handle" />
    </div>
  );
}
