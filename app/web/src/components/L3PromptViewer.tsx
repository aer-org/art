import { useEffect, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
  nodeId: string;
  stageName: string;
  promptSource?: string | null;
  initial?: boolean;
}

export function L3PromptViewer({
  runId,
  nodeId,
  stageName,
  promptSource,
  initial,
}: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetcher = initial
      ? api.stageInitial(runId, nodeId, stageName)
      : api.stagePrompt(runId, nodeId, stageName);
    fetcher
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, stageName, initial]);

  if (error) return <p className="error">{error}</p>;
  if (text === null) return <p className="muted">Loading…</p>;

  return (
    <div className="l3-text">
      {!initial && promptSource && (
        <div className="l3-meta">
          <span className="muted">source </span>
          <code>{promptSource}</code>
          <span className="muted"> · {text.length} chars</span>
          <button
            className="link-btn"
            onClick={() => navigator.clipboard?.writeText(text)}
            title="Copy"
          >
            copy
          </button>
        </div>
      )}
      <pre className="l3-pre">{text}</pre>
    </div>
  );
}
