/**
 * RetryEdge — curved arc for back-edges.
 *
 * Used by any edge that PipelineGraph's layout flagged as a back-edge
 * (source's laid-out x > target's x). Covers:
 *   - Authored self-stitch (`isRetry` set in data; e.g. fp-filter
 *     STAGE_ERROR → fp-init inside an expanded shrink-floorplan).
 *   - Cross-template back-stitch (e.g. ECO_review stitching back to
 *     shrink-floorplan after the forward chain has already placed
 *     it earlier). Detected post-layout from dagre x positions.
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
              background: 'var(--graph-bg)',
              color: '#1a1a1a',
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
