import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { PipelineStage } from '../types';
import './StageNode.css';

type StageNodeType = Node<{ stage: PipelineStage; isEntry?: boolean; runStatus?: 'running' | 'completed' }>;

export function StageNode({ data, selected }: NodeProps<StageNodeType>) {
  const { stage, isEntry, runStatus } = data;

  const mountBadges = Object.entries(stage.mounts)
    .filter(([, v]) => v != null)
    .map(([k, v]) => (
      <span key={k} className={`mount-badge mount-${v}`}>
        {k}:{v}
      </span>
    ));

  const flagBadges = (
    <>
      {stage.devices && stage.devices.length > 0 && (
        <span className="flag-badge device">USB</span>
      )}
      {stage.runAsRoot && <span className="flag-badge root">root</span>}
      {stage.exclusive && <span className="flag-badge exclusive">{stage.exclusive}</span>}
    </>
  );

  const hasFooter = mountBadges.length > 0 || stage.devices?.length || stage.runAsRoot || stage.exclusive;

  // Build source handles from non-retry transitions
  const sourceTransitions = (stage.transitions || []).filter((t) => !t.retry);

  return (
    <div className={`stage-node ${selected ? 'selected' : ''} ${isEntry ? 'entry' : ''} ${runStatus ? `run-${runStatus}` : ''}`}>
      <div className="stage-title-bar">
        {isEntry && <span className="entry-badge">START</span>}
        {stage.name}
      </div>

      <div className="stage-sockets">
        {sourceTransitions.map((t, i) => {
          const isFirst = i === 0;
          return (
            <div className="socket-row" key={t.marker}>
              {isFirst && (
                <div className="socket-left">
                  <Handle type="target" position={Position.Left} id="in" className="handle-input" />
                  <span className="socket-label input-label">in</span>
                </div>
              )}
              {!isFirst && <div className="socket-left" />}
              <div className="socket-right">
                <span className={`socket-label ${isFirst ? 'complete-label' : 'error-label'}`}>
                  {t.marker}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={t.marker}
                  className={isFirst ? 'handle-complete' : 'handle-error'}
                />
              </div>
            </div>
          );
        })}
        {sourceTransitions.length === 0 && (
          <div className="socket-row">
            <div className="socket-left">
              <Handle type="target" position={Position.Left} id="in" className="handle-input" />
              <span className="socket-label input-label">in</span>
            </div>
            <div className="socket-right" />
          </div>
        )}
      </div>

      {hasFooter && (
        <div className="stage-footer">
          {mountBadges}
          {flagBadges}
        </div>
      )}
    </div>
  );
}
