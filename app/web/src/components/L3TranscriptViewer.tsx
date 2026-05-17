/**
 * L3TranscriptViewer — full agent thought log for a stage.
 *
 * The file is `transcript.jsonl` archived at stage finalize (see
 * src/pipeline-runner.ts:archiveStageTranscript). One JSON record per
 * line. We normalize the codex layout (response_item + payload.type)
 * and the claude layout (role + content[]) into a single sequence of
 * NormalEntry items so the renderer stays simple.
 *
 * Entry kinds after normalization:
 *   - user / developer message  → input block
 *   - assistant message         → markdown-ish body
 *   - reasoning / thinking      → "thought" block (default open)
 *   - tool                      → call + matched result paired into
 *                                  one entry (matched via call_id /
 *                                  tool_use_id)
 *   - meta                      → session_meta, turn_context, event_msg
 *
 * Filter controls let the user hide noisy kinds (reasoning / tool /
 * meta) to focus on the user↔assistant exchange.
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
  | 'tool'
  | 'meta'
  | 'other';

interface NormalEntry {
  kind: EntryKind;
  ts?: string;
  body: string;
  // tool-only: arguments (call side) and output (result side). Paired
  // by call_id / tool_use_id during normalize.
  detail?: string;
  result?: string;
  callId?: string;
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
    tool: true,
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
  return (
    <div className={`transcript-entry kind-${entry.kind}`}>
      <div className="transcript-entry-head">
        <span className={`transcript-tag tag-${entry.kind}`}>
          {LABEL[entry.kind]}
        </span>
        {entry.kind === 'tool' && (
          <span style={{ fontSize: 11, color: 'var(--fg)' }}>{entry.body}</span>
        )}
        {entry.ts && (
          <span className="muted" style={{ fontSize: 10 }}>
            {formatTs(entry.ts)}
          </span>
        )}
        <button
          className="mount-tab"
          onClick={() => setOpen((v) => !v)}
          style={{ marginLeft: 'auto', fontSize: 10 }}
        >
          {open ? 'hide' : 'show'}
        </button>
      </div>
      {open && entry.kind !== 'tool' && (
        <pre className="transcript-body-text">{entry.body}</pre>
      )}
      {open && entry.detail && (
        <div className="transcript-section">
          <div className="transcript-section-label">
            {entry.kind === 'tool' ? 'args' : 'detail'}
          </div>
          <pre className="transcript-detail-text">{entry.detail}</pre>
        </div>
      )}
      {open && entry.result !== undefined && (
        <div className="transcript-section">
          <div className="transcript-section-label">result</div>
          <pre className="transcript-detail-text">
            {entry.result || '(empty)'}
          </pre>
        </div>
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
  tool: 'tool',
  meta: 'meta',
  other: 'other',
};

function defaultOpen(kind: EntryKind): boolean {
  // Reasoning gets opened by default — the user mostly wants to see
  // the model's thinking inline with the message turns. Tool calls
  // stay collapsed because their args/results can be very long.
  return kind === 'user' || kind === 'assistant' || kind === 'reasoning';
}

function formatTs(ts: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}

// ---- Normalization (codex + claude) ----

function normalizeTranscript(
  records: Array<Record<string, unknown>>,
): NormalEntry[] {
  const out: NormalEntry[] = [];
  // Pair tool calls with their results. The result attaches to the
  // call entry that came earlier in the stream, so the in-stream
  // position of the merged entry is the *call* position — that's
  // when the model decided to invoke the tool, which is the natural
  // anchor when reading the transcript top-to-bottom.
  const pendingByCallId = new Map<string, NormalEntry>();

  function emit(entry: NormalEntry | null): void {
    if (!entry) return;
    if (entry.kind === 'tool' && entry.callId) {
      // If this is a result and there's a pending call, attach.
      if (entry.result !== undefined && pendingByCallId.has(entry.callId)) {
        const call = pendingByCallId.get(entry.callId)!;
        call.result = entry.result;
        pendingByCallId.delete(entry.callId);
        return;
      }
      // Otherwise it's a call (or an orphan result). Push and
      // remember for future pairing.
      pendingByCallId.set(entry.callId, entry);
    }
    out.push(entry);
  }

  for (const r of records) {
    const entries = normalizeOne(r);
    for (const e of entries) emit(e);
  }
  return out;
}

function normalizeOne(rec: Record<string, unknown>): NormalEntry[] {
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;

  // Codex shape.
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
      return [{ kind, ts, body, raw: rec }];
    }
    if (pt === 'reasoning') {
      // Codex / GPT-5 reasoning models keep the actual chain-of-thought
      // encrypted (`encrypted_content`) and only surface a plain
      // `summary` when explicitly requested. When neither summary nor
      // content is present we surface a placeholder so the reader can
      // tell reasoning happened, just that the content is opaque.
      const text = renderCodexContent(p.summary ?? p.content);
      const enc = typeof p.encrypted_content === 'string'
        ? p.encrypted_content
        : '';
      const body = text
        ? text
        : enc
          ? `(encrypted reasoning · ${enc.length} bytes — content not exposed by the provider)`
          : '(reasoning record, no content)';
      return [{ kind: 'reasoning', ts, body, raw: rec }];
    }
    if (pt === 'function_call') {
      const name = (p.name as string | undefined) ?? 'call';
      const args = typeof p.arguments === 'string' ? p.arguments : '';
      return [
        {
          kind: 'tool',
          ts,
          body: name,
          detail: prettyJson(args),
          callId: (p.call_id as string | undefined) ?? (p.id as string | undefined),
          raw: rec,
        },
      ];
    }
    if (pt === 'function_call_output') {
      const out = (p.output as Record<string, unknown> | string | undefined) ??
        '';
      const result =
        typeof out === 'string' ? out : prettyJson(JSON.stringify(out));
      return [
        {
          kind: 'tool',
          ts,
          body: '',
          result,
          callId: (p.call_id as string | undefined) ?? (p.id as string | undefined),
          raw: rec,
        },
      ];
    }
  }

  if (rec.type === 'session_meta' || rec.type === 'turn_context') {
    return [
      {
        kind: 'meta',
        ts,
        body: String(rec.type),
        detail: prettyJson(JSON.stringify(rec.payload ?? {})),
        raw: rec,
      },
    ];
  }
  if (rec.type === 'event_msg') {
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const pt = typeof p.type === 'string' ? p.type : 'event';
    return [{ kind: 'meta', ts, body: `event: ${pt}`, raw: rec }];
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
    return renderClaudeContent(message.content, ts);
  }

  return [{ kind: 'other', ts, body: prettyJson(JSON.stringify(rec)), raw: rec }];
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

function renderClaudeContent(content: unknown, ts: string | undefined): NormalEntry[] {
  if (!Array.isArray(content)) {
    return [
      {
        kind: 'assistant',
        ts,
        body:
          typeof content === 'string' ? content : prettyJson(JSON.stringify(content)),
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
        ts,
        body: (item.text as string | undefined) ?? '',
        raw: item,
      });
    } else if (t === 'thinking') {
      out.push({
        kind: 'reasoning',
        ts,
        body: (item.thinking as string | undefined) ?? '',
        raw: item,
      });
    } else if (t === 'tool_use') {
      const name = (item.name as string | undefined) ?? 'tool';
      const input = item.input;
      out.push({
        kind: 'tool',
        ts,
        body: name,
        detail: prettyJson(JSON.stringify(input)),
        callId: item.id as string | undefined,
        raw: item,
      });
    } else if (t === 'tool_result') {
      const body =
        typeof item.content === 'string'
          ? item.content
          : prettyJson(JSON.stringify(item.content));
      out.push({
        kind: 'tool',
        ts,
        body: '',
        result: body,
        callId: item.tool_use_id as string | undefined,
        raw: item,
      });
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
