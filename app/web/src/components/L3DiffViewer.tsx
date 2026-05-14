/**
 * L3DiffViewer — renders the unified diff from /diff/<mount>.diff.
 *
 * Minimal in-house unified-diff parser instead of pulling react-diff-view.
 * Recognizes `diff --git`, `--- a/...`, `+++ b/...`, `@@ ...@@` hunk lines,
 * and `+`/`-`/` ` content lines. Color-coded per line type. Truncates very
 * long diffs to keep render fast; user can hit "raw" to dump the full text.
 */
import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
  nodeId: string;
  stageName: string;
  mounts: string[];
  summary: Record<string, unknown> | null;
  initialMount?: string;
}

const MAX_LINES = 4000;

export function L3DiffViewer({
  runId,
  nodeId,
  stageName,
  mounts,
  summary,
  initialMount,
}: Props) {
  const [mount, setMount] = useState<string | null>(
    initialMount && mounts.includes(initialMount)
      ? initialMount
      : (mounts[0] ?? null),
  );
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!mount) return;
    let cancelled = false;
    setText(null);
    api
      .stageDiff(runId, nodeId, stageName, mount)
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, stageName, mount]);

  const summaryMounts = Array.isArray(summary?.mounts)
    ? (summary!.mounts as Array<{
        mount: string;
        changed: boolean;
        bytes: number;
      }>)
    : [];
  const lookup = new Map(summaryMounts.map((m) => [m.mount, m]));

  return (
    <div className="l3-diff">
      <div className="l3-meta">
        <div className="mount-tabs">
          {mounts.length === 0 ? (
            <span className="muted">no mounts</span>
          ) : (
            mounts.map((m) => {
              const info = lookup.get(m);
              return (
                <button
                  key={m}
                  className={`mount-tab ${m === mount ? 'active' : ''}${info?.changed === false ? ' unchanged' : ''}`}
                  onClick={() => setMount(m)}
                >
                  {m}
                  {info && (
                    <span className="muted">
                      {' '}
                      · {info.changed ? `${fmtBytes(info.bytes)}` : 'unchanged'}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {text !== null && (
          <button
            className="link-btn"
            onClick={() => setRaw(!raw)}
            title="Toggle parsed vs raw"
          >
            {raw ? 'parsed' : 'raw'}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {text === null && !error && <p className="muted">Loading…</p>}
      {text !== null &&
        (text.length === 0 ? (
          <p className="muted">No changes for this mount.</p>
        ) : raw ? (
          <pre className="l3-pre">{text}</pre>
        ) : (
          <ParsedDiff text={text} />
        ))}
    </div>
  );
}

function ParsedDiff({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const truncated = lines.length > MAX_LINES;
  const display = truncated ? lines.slice(0, MAX_LINES) : lines;

  return (
    <div className="diff-block">
      {display.map((line, i) => {
        const kind = classify(line);
        return (
          <div key={i} className={`diff-line ${kind}`}>
            {line || ' '}
          </div>
        );
      })}
      {truncated && (
        <div className="diff-line muted">
          … truncated at {MAX_LINES} lines (use "raw" to view full)
        </div>
      )}
    </div>
  );
}

function classify(line: string): string {
  if (line.startsWith('diff --git') || line.startsWith('index '))
    return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('---') || line.startsWith('+++')) return 'fileheader';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
