import { useEffect, useRef, useState } from 'react';
import type { RunLogLine } from '../hooks/usePipelineState.ts';

interface Props {
  lines: RunLogLine[];
  onClear: () => void;
}

export function RunLogTray({ lines, onClear }: Props) {
  const [open, setOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [lines.length, open]);

  if (lines.length === 0 && !open) return null;

  return (
    <div className="run-log-tray" style={open ? {} : { maxHeight: 'auto' }}>
      <div className="run-log-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{open ? '▼' : '▶'}</span>
        <span className="label">Run log</span>
        {lines.length > 0 && <span className="badge">{lines.length}</span>}
        {lines.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            style={{ padding: '2px 8px', fontSize: 11 }}
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="run-log-content" style={{ flex: 1, minHeight: 0 }}>
          {lines.length === 0 && <span style={{ color: 'var(--fg-dim)' }}>(no output yet — press Run)</span>}
          {lines.map((l, i) => (
            <div key={i} className={l.kind === 'stderr' ? 'stderr' : ''}>{l.line}</div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
