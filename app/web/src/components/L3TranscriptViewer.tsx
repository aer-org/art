/**
 * L3TranscriptViewer — full agent thought log for a stage.
 *
 * The file is `transcript.jsonl` archived at stage finalize (see
 * src/pipeline-runner.ts:archiveStageTranscript). One JSON record per
 * line. We normalize the codex layout (response_item + payload.type)
 * and the claude layout (role + content[]) into a single sequence of
 * NormalEntry items so the renderer stays simple.
 *
 * Each entry kind has its own visual:
 *   - user / developer message  → input block
 *   - assistant message         → markdown-ish body
 *   - reasoning / thinking      → collapsible "thought" block
 *   - tool call                 → tool name + args (collapsible)
 *   - tool result               → result body (collapsible)
 *
 * Filter controls let the user hide reasoning/tool noise to focus on
 * the user↔assistant exchange.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';

interface Props {
  runId: string;
  nodeId: string;
  stageName: string;
}

type EntryKind =
  | 'user'
  | 'developer'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'meta'
  | 'other';

interface NormalEntry {
  kind: EntryKind;
  ts?: string;
  // Display text. For tool_call, this is `<name>(<args summary>)`.
  // For tool_result, this is the result body.
  body: string;
  // Optional secondary text (e.g. tool call arguments JSON).
  detail?: string;
  // Pass-through raw record for the "raw" toggle.
  raw: Record<string, unknown>;
}

export function L3TranscriptViewer({ runId, nodeId, stageName }: Props) {
  const [records, setRecords] = useState<Array<Record<string, unknown>> | null>(
    null,
  );
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    user: true,
    developer: false,
    assistant: true,
    reasoning: true,
    tool_call: true,
    tool_result: true,
    meta: false,
    other: false,
  });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .stageTranscript(runId, nodeId, stageName)
      .then((r) => {
        if (cancelled) return;
        setRecords(r.records);
        setBytes(r.bytes);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, stageName]);

  const entries = useMemo(
    () => (records ? normalizeTranscript(records) : []),
    [records],
  );
  const filtered = useMemo(
    () => entries.filter((e) => filters[e.kind] ?? true),
    [entries, filters],
  );

  if (error) return <p className="error">Failed to load transcript: {error}</p>;
  if (records === null) return <p className="muted">Loading transcript…</p>;
  if (records.length === 0) return <p className="muted">Empty transcript.</p>;

  return (
    <div className="transcript-viewer">
      <div className="transcript-toolbar">
        <span className="muted" style={{ fontSize: 11 }}>
          {records.length} records · {(bytes / 1024).toFixed(1)} KB
        </span>
        <span style={{ flex: 1 }} />
        {(Object.keys(filters) as EntryKind[]).map((k) => (
          <button
            key={k}
            className={`mount-tab ${filters[k] ? 'active' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
          >
            {k}
          </button>
        ))}
        <button
          className={`mount-tab ${showRaw ? 'active' : ''}`}
          onClick={() => setShowRaw((v) => !v)}
          title="Show the underlying jsonl record under each entry"
        >
          raw
        </button>
      </div>
      <div className="transcript-body">
        {filtered.map((entry, i) => (
          <TranscriptEntry key={i} entry={entry} showRaw={showRaw} />
        ))}
      </div>
    </div>
  );
}

function TranscriptEntry({
  entry,
  showRaw,
}: {
  entry: NormalEntry;
  showRaw: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen(entry.kind));
  const collapsible = COLLAPSIBLE_KINDS.has(entry.kind);
  return (
    <div className={`transcript-entry kind-${entry.kind}`}>
      <div className="transcript-entry-head">
        <span className={`transcript-tag tag-${entry.kind}`}>{LABEL[entry.kind]}</span>
        {entry.ts && (
          <span className="muted" style={{ fontSize: 10 }}>
            {formatTs(entry.ts)}
          </span>
        )}
        {collapsible && (
          <button
            className="mount-tab"
            onClick={() => setOpen((v) => !v)}
            style={{ marginLeft: 'auto', fontSize: 10 }}
          >
            {open ? 'hide' : 'show'}
          </button>
        )}
      </div>
      {(open || !collapsible) && (
        <pre className="transcript-body-text">{entry.body}</pre>
      )}
      {(open || !collapsible) && entry.detail && (
        <pre className="transcript-detail-text">{entry.detail}</pre>
      )}
      {showRaw && (
        <pre className="transcript-raw">{JSON.stringify(entry.raw, null, 2)}</pre>
      )}
    </div>
  );
}

const LABEL: Record<EntryKind, string> = {
  user: 'user',
  developer: 'developer',
  assistant: 'assistant',
  reasoning: 'reasoning',
  tool_call: 'tool ▶',
  tool_result: 'tool ◀',
  meta: 'meta',
  other: 'other',
};

const COLLAPSIBLE_KINDS = new Set<EntryKind>([
  'reasoning',
  'tool_call',
  'tool_result',
  'developer',
  'meta',
  'other',
]);

function defaultOpen(kind: EntryKind): boolean {
  return kind === 'user' || kind === 'assistant';
}

function formatTs(ts: string): string {
  // ISO → HH:MM:SS for tighter columns.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}

// ---- Normalization (codex + claude) ----

function normalizeTranscript(
  records: Array<Record<string, unknown>>,
): NormalEntry[] {
  const out: NormalEntry[] = [];
  for (const r of records) {
    const entry = normalizeOne(r);
    if (entry) out.push(entry);
  }
  return out;
}

function normalizeOne(rec: Record<string, unknown>): NormalEntry | null {
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;

  // Codex shape: `{type: 'response_item', payload: {type, role, content}}` etc.
  if (typeof rec.type === 'string' && rec.type === 'response_item') {
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const pt = typeof p.type === 'string' ? p.type : '';

    if (pt === 'message') {
      const role = (p.role as string | undefined) ?? 'user';
      const body = renderCodexContent(p.content);
      const kind: EntryKind =
        role === 'assistant'
          ? 'assistant'
          : role === 'developer'
            ? 'developer'
            : 'user';
      return { kind, ts, body, raw: rec };
    }
    if (pt === 'reasoning') {
      const body = renderCodexContent(p.summary ?? p.content);
      return { kind: 'reasoning', ts, body, raw: rec };
    }
    if (pt === 'function_call') {
      const name = (p.name as string | undefined) ?? 'call';
      const args = typeof p.arguments === 'string' ? p.arguments : '';
      return {
        kind: 'tool_call',
        ts,
        body: `${name}`,
        detail: prettyJson(args),
        raw: rec,
      };
    }
    if (pt === 'function_call_output') {
      const out = (p.output as Record<string, unknown> | string | undefined) ??
        '';
      const body =
        typeof out === 'string' ? out : prettyJson(JSON.stringify(out));
      return { kind: 'tool_result', ts, body, raw: rec };
    }
  }

  // Codex meta-events that aren't response_item.
  if (rec.type === 'session_meta' || rec.type === 'turn_context') {
    return {
      kind: 'meta',
      ts,
      body: String(rec.type),
      detail: prettyJson(JSON.stringify(rec.payload ?? {})),
      raw: rec,
    };
  }
  if (rec.type === 'event_msg') {
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const pt = typeof p.type === 'string' ? p.type : 'event';
    return {
      kind: 'meta',
      ts,
      body: `event: ${pt}`,
      raw: rec,
    };
  }

  // Claude shape: `{type: 'user'|'assistant'|'system', message: {role, content: [...]}}`.
  const claudeRole =
    rec.type === 'user' ||
    rec.type === 'assistant' ||
    rec.type === 'system'
      ? (rec.type as string)
      : null;
  if (claudeRole) {
    const message = (rec.message ?? rec) as Record<string, unknown>;
    const content = message.content;
    const parts = renderClaudeContent(content);
    if (parts.length === 0) return null;
    const first = parts[0];
    return { ...first, ts, raw: rec };
  }

  return { kind: 'other', ts, body: prettyJson(JSON.stringify(rec)), raw: rec };
}

function renderCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (typeof item.text === 'string') parts.push(item.text);
    else if (typeof item.input_text === 'string') parts.push(item.input_text);
    else parts.push(prettyJson(JSON.stringify(item)));
  }
  return parts.join('\n');
}

function renderClaudeContent(content: unknown): NormalEntry[] {
  if (!Array.isArray(content)) {
    return [
      {
        kind: 'assistant',
        body: typeof content === 'string' ? content : prettyJson(JSON.stringify(content)),
        raw: {},
      },
    ];
  }
  const out: NormalEntry[] = [];
  for (const item of content as Array<Record<string, unknown>>) {
    const t = item.type as string | undefined;
    if (t === 'text') {
      out.push({
        kind: 'assistant',
        body: (item.text as string | undefined) ?? '',
        raw: item,
      });
    } else if (t === 'thinking') {
      out.push({
        kind: 'reasoning',
        body: (item.thinking as string | undefined) ?? '',
        raw: item,
      });
    } else if (t === 'tool_use') {
      const name = (item.name as string | undefined) ?? 'tool';
      const input = item.input;
      out.push({
        kind: 'tool_call',
        body: name,
        detail: prettyJson(JSON.stringify(input)),
        raw: item,
      });
    } else if (t === 'tool_result') {
      const body = typeof item.content === 'string'
        ? item.content
        : prettyJson(JSON.stringify(item.content));
      out.push({ kind: 'tool_result', body, raw: item });
    }
  }
  return out;
}

function prettyJson(s: string): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
