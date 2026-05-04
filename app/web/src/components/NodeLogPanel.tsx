import { useEffect, useRef, useState } from 'react';
import type { GraphNode, NodeLogLine } from '../lib/api.ts';

interface Props {
  node: GraphNode | null;
  lines: NodeLogLine[];
  onClear: (stage: string) => void;
  onClose: () => void;
  onDetails: (stage: string) => void;
}

export function NodeLogPanel({ node, lines, onClear, onClose, onDetails }: Props) {
  const [open, setOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [lines.length, open, node?.id]);

  return (
    <div className="node-log-panel">
      <div className="node-log-header" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▼' : '▶'}</span>
        <span className="label">Inside Node</span>
        {node && <span className={`node-log-status ${node.status}`}>{node.status}</span>}
        <span className="node-log-name" title={node?.name ?? 'No node selected'}>
          {node?.name ?? 'No node selected'}
        </span>
        {lines.length > 0 && <span className="badge">{lines.length}</span>}
        <button
          disabled={!node}
          onClick={(e) => {
            e.stopPropagation();
            if (node) onDetails(node.name);
          }}
        >
          Details
        </button>
        {lines.length > 0 && (
          <button
            disabled={!node}
            onClick={(e) => {
              e.stopPropagation();
              if (node) onClear(node.name);
            }}
          >
            Clear
          </button>
        )}
        <button
          disabled={!node}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          Close
        </button>
      </div>
      {open && (
        <div className="node-log-content">
          {lines.length === 0 && (
            <span className="node-log-empty">
              {!node
                ? 'Click a node to inspect its container-side logs.'
                : node.status === 'pending'
                  ? ''
                  : 'No node output found.'}
            </span>
          )}
          {lines.map((line, i) => (
            <div key={`${line.sourceFile ?? 'log'}-${i}`} className={line.kind === 'stderr' ? 'stderr' : ''}>
              {line.line}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
