/**
 * RetryEdge — curved arc for back-edges in the template DAG.
 *
 * Used for `isRetry` edges. Two cases:
 *   1. Self-stitch (origin inside the same template, e.g.
 *      `fp-filter STAGE_ERROR → fp-init`) — arcs below the expanded
 *      lane so it doesn't slice through the intermediate stages.
 *   2. Cross-template back-stitch (origin in a template that sits
 *      *later* in topological order than the target) — arcs below
 *      the row of templates so the back-reference doesn't look like
 *      another forward transition.
 *
 * The arc drops to a depth proportional to horizontal distance
 * between source and target so longer back-edges arc further down.
 */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

const MIN_DROP = 60;
const MAX_DROP = 180;

export function RetryEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  label,
  style,
}: EdgeProps) {
  const dx = Math.abs(sourceX - targetX);
  const drop = Math.min(MAX_DROP, Math.max(MIN_DROP, dx * 0.25));
  const baseY = Math.max(sourceY, targetY);
  const midX = (sourceX + targetX) / 2;
  const labelY = baseY + drop;
  // Cubic bezier that exits source going right-down, swings under,
  // and re-enters target going up-right.
  const path = `M ${sourceX},${sourceY} C ${sourceX + 40},${baseY + drop}, ${targetX - 40},${baseY + drop}, ${targetX},${targetY}`;
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${midX}px, ${labelY}px)`,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'var(--bg)',
              color: 'var(--accent)',
              fontFamily: 'var(--mono)',
              pointerEvents: 'none',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
