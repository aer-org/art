import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  const [raw, setRaw] = useState(false);

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
      <div className="l3-meta">
        {!initial && promptSource && (
          <>
            <span className="muted">source </span>
            <code>{promptSource}</code>
            <span className="muted"> · </span>
          </>
        )}
        <span className="muted">{text.length} chars</span>
        <span style={{ flex: 1 }} />
        <button
          className={`mount-tab ${raw ? '' : 'active'}`}
          onClick={() => setRaw(false)}
          title="Render markdown"
        >
          md
        </button>
        <button
          className={`mount-tab ${raw ? 'active' : ''}`}
          onClick={() => setRaw(true)}
          title="Show raw text"
        >
          raw
        </button>
        <button
          className="link-btn"
          onClick={() => navigator.clipboard?.writeText(text)}
          title="Copy"
        >
          copy
        </button>
      </div>
      {raw ? (
        <pre className="l3-pre">{text}</pre>
      ) : (
        <div className="l3-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
