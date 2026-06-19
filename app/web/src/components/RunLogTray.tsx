import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RunLogLine } from '../hooks/usePipelineState.ts';

interface Props {
  lines: RunLogLine[];
  onClear: () => void;
}

// Fixed line geometry — must match the .run-log-content line CSS
// (12px mono / 1.4 line-height ≈ 17px). Off-screen lines are not
// rendered; only the visible window + a small overscan are mounted,
// so the DOM stays small no matter how many lines the run produces.
const LINE_HEIGHT = 17;
const OVERSCAN = 20;
const AT_BOTTOM_EPSILON = 4;

export function RunLogTray({ lines, onClear }: Props) {
  const [open, setOpen] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Whether the user is currently scrolled to the bottom. We auto-scroll
  // on append only while this is true so a user reading older lines
  // isn't yanked back to the tail every time a new line arrives.
  const stuckToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (stuckToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [lines.length, open]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    stuckToBottomRef.current =
      el.scrollHeight - (el.scrollTop + el.clientHeight) <= AT_BOTTOM_EPSILON;
  };

  if (lines.length === 0 && !open) return null;

  const totalHeight = lines.length * LINE_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    lines.length,
    Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN,
  );
  const visibleLines = lines.slice(startIdx, endIdx);

  return (
    <div className="run-log-tray" style={open ? {} : { maxHeight: 'auto' }}>
      <div
        className="run-log-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span className="label">Run log</span>
        {lines.length > 0 && <span className="badge">{lines.length}</span>}
        {lines.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            style={{ padding: '2px 8px', fontSize: 11 }}
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div
          ref={scrollerRef}
          className="run-log-content"
          onScroll={onScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            position: 'relative',
          }}
        >
          {lines.length === 0 && (
            <span style={{ color: 'var(--fg-dim)' }}>
              (no output yet — press Run)
            </span>
          )}
          {lines.length > 0 && (
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  top: startIdx * LINE_HEIGHT,
                  left: 0,
                  right: 0,
                }}
              >
                {visibleLines.map((l, i) => (
                  <div
                    key={l.seq ?? startIdx + i}
                    className={l.kind === 'stderr' ? 'stderr' : ''}
                    style={{
                      height: LINE_HEIGHT,
                      lineHeight: `${LINE_HEIGHT}px`,
                    }}
                  >
                    {l.line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
