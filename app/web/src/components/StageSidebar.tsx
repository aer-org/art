/**
 * StageSidebar — L2 of the visualizer UX (app/VISUALIZER-PLAN.md §2).
 *
 * Three accordion sections, all visible (scroll inside):
 *   Input    — prompt source, substitutions, initial preview, command,
 *              container summary
 *   Output   — outcome, matched marker, transition, retry/exit/duration,
 *              diff summary per mount
 *   Internal — turn count + aggregate, decision counts, stream sizes
 *
 * Each section's "View …" buttons currently emit a `View Y` placeholder
 * — wires into L3 panels in Phase E. The sidebar itself is fully usable
 * for at-a-glance triage today.
 */
import type { StageSidebarData } from '../hooks/useStageDetail.ts';

interface Props {
  nodeId: string;
  stageName: string;
  data: StageSidebarData;
  onClose: () => void;
  onOpenPanel?: (panel: L3PanelKind, mount?: string) => void;
}

export type L3PanelKind =
  | 'prompt'
  | 'initial'
  | 'command'
  | 'mounts'
  | 'diff'
  | 'turns'
  | 'decisions'
  | 'stream';

export function StageSidebar({
  nodeId,
  stageName,
  data,
  onClose,
  onOpenPanel,
}: Props) {
  const { stage, events, turns, diffSummary, loading, error } = data;
  const stageRec = stage?.stage as Record<string, unknown> | null;

  return (
    <aside className="stage-sidebar inspector">
      <header className="sidebar-header">
        <div>
          <div className="label">stage</div>
          <div className="value large">{stageName}</div>
          <div className="sub">
            <span className="muted">node </span>
            <code>{nodeId}</code>
          </div>
        </div>
        <button className="sidebar-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>

      {error && <div className="sidebar-error">{error}</div>}
      {loading && <div className="sidebar-loading">Loading…</div>}

      {!loading && !error && (
        <div className="sidebar-sections">
          <Section title="Input">
            <Field label="prompt source">
              {stage?.promptSource ? (
                <code>{stage.promptSource}</code>
              ) : (
                <span className="muted">—</span>
              )}
              {stage?.hasPrompt && (
                <BtnLink onClick={() => onOpenPanel?.('prompt')}>view</BtnLink>
              )}
            </Field>
            <Field label="initial handoff">
              {stage?.hasInitial ? (
                <BtnLink onClick={() => onOpenPanel?.('initial')}>view</BtnLink>
              ) : (
                <span className="muted">—</span>
              )}
            </Field>
            <Field label="command">
              {stage?.hasCommand ? (
                <BtnLink onClick={() => onOpenPanel?.('command')}>view</BtnLink>
              ) : (
                <span className="muted">agent mode</span>
              )}
            </Field>
            <Field label="substitutions">
              {stage?.substitutions ? (
                <SubsLine subs={stage.substitutions} />
              ) : (
                <span className="muted">—</span>
              )}
            </Field>
            <Field label="container">
              {stage?.container ? (
                <ContainerLine container={stage.container} />
              ) : (
                <span className="muted">—</span>
              )}
              {stage?.container && (
                <BtnLink onClick={() => onOpenPanel?.('mounts')}>view</BtnLink>
              )}
            </Field>
          </Section>

          <Section title="Output">
            <Field label="outcome">
              <OutcomeChip outcome={pickStr(stageRec, 'result')} />
            </Field>
            <Field label="matched marker">
              {pickStr(stageRec, 'matchedMarker') ? (
                <code>[{pickStr(stageRec, 'matchedMarker')}]</code>
              ) : (
                <span className="muted">—</span>
              )}
            </Field>
            <Field label="transition target">
              {fmtTarget(stageRec?.transitionTarget)}
            </Field>
            <Field label="duration">
              {fmtDuration(pickNum(stageRec, 'durationMs'))}
            </Field>
            <Field label="retry / exit">
              <RetryExit
                retryCount={pickNum(stageRec, 'retryCount')}
                exitCode={pickNum(stageRec, 'exitCode')}
              />
            </Field>
            <Field label="diff">
              <DiffSummaryLine
                summary={diffSummary}
                onView={(m) => onOpenPanel?.('diff', m)}
              />
            </Field>
            <Field label="payload">
              <PayloadLine len={pickNum(stageRec, 'payloadLen')} />
            </Field>
          </Section>

          <Section title="Internal">
            <Field label="turns">
              <TurnsLine turns={turns} />
              {turns.length > 0 && (
                <BtnLink onClick={() => onOpenPanel?.('turns')}>view</BtnLink>
              )}
            </Field>
            <Field label="decisions">
              <DecisionsLine events={events} />
              {events.length > 0 && (
                <BtnLink onClick={() => onOpenPanel?.('decisions')}>
                  view
                </BtnLink>
              )}
            </Field>
            <Field label="streams">
              <StreamsLine sizes={stage?.streamSizes} />
              {stage && hasAnyStream(stage.streamSizes) && (
                <BtnLink onClick={() => onOpenPanel?.('stream')}>view</BtnLink>
              )}
            </Field>
          </Section>
        </div>
      )}
    </aside>
  );
}

// --- Section + Field primitives ---------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sidebar-section">
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function BtnLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="link-btn" onClick={onClick}>
      {children}
    </button>
  );
}

// --- Tiny widgets ------------------------------------------------------

function OutcomeChip({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span className="muted">—</span>;
  const cls = outcome === 'success' ? 'outcome-success' : 'outcome-error';
  return <span className={`chip ${cls}`}>{outcome}</span>;
}

function RetryExit({
  retryCount,
  exitCode,
}: {
  retryCount?: number | null;
  exitCode?: number | null;
}) {
  const parts: React.ReactNode[] = [];
  if (typeof retryCount === 'number' && retryCount > 0) {
    parts.push(
      <span key="r" className="retry-inline">
        ↻{retryCount}
      </span>,
    );
  }
  if (typeof exitCode === 'number') {
    parts.push(
      <span key="e" className={exitCode === 0 ? 'muted' : 'exit-bad'}>
        exit {exitCode}
      </span>,
    );
  }
  return parts.length ? <>{parts}</> : <span className="muted">—</span>;
}

function SubsLine({ subs }: { subs: Record<string, unknown> }) {
  const insertId = typeof subs.insertId === 'string' ? subs.insertId : null;
  const index = typeof subs.index === 'number' ? subs.index : null;
  const payload =
    subs.substitutions &&
    typeof subs.substitutions === 'object' &&
    !Array.isArray(subs.substitutions)
      ? (subs.substitutions as Record<string, unknown>)
      : null;
  const payloadKeys =
    payload && Object.keys(payload).filter((k) => k !== 'insertId' && k !== 'index');
  return (
    <span className="subs-line">
      {insertId && <code>{insertId}</code>}
      {index !== null && <span className="muted">[{index}]</span>}
      {payloadKeys && payloadKeys.length > 0 && (
        <span className="muted"> · {payloadKeys.length} fields</span>
      )}
      {(!insertId && index === null) && <span className="muted">—</span>}
    </span>
  );
}

function ContainerLine({ container }: { container: Record<string, unknown> }) {
  const image = typeof container.image === 'string' ? container.image : '—';
  const mode = typeof container.mode === 'string' ? container.mode : null;
  const mounts = Array.isArray(container.mounts) ? container.mounts : [];
  const ro = mounts.filter(
    (m: unknown) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { readonly?: boolean }).readonly === true,
  ).length;
  const rw = mounts.length - ro;
  return (
    <span className="container-line">
      {mode && <span className="muted">{mode} · </span>}
      <code>{image}</code>
      {mounts.length > 0 && (
        <span className="muted">
          {' '}
          · {rw}rw / {ro}ro
        </span>
      )}
    </span>
  );
}

function DiffSummaryLine({
  summary,
  onView,
}: {
  summary: Record<string, unknown> | null;
  onView: (mount?: string) => void;
}) {
  if (!summary) return <span className="muted">no diff</span>;
  const mounts = Array.isArray(summary.mounts) ? summary.mounts : [];
  const changed = mounts.filter(
    (m: unknown) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { changed?: boolean }).changed === true,
  );
  if (changed.length === 0)
    return <span className="muted">{mounts.length} mounts, no changes</span>;
  return (
    <span className="diff-line">
      {changed.map((m: unknown) => {
        const mount = (m as { mount: string }).mount;
        const bytes = (m as { bytes?: number }).bytes ?? 0;
        return (
          <button
            key={mount}
            className="mount-chip"
            onClick={() => onView(mount)}
            title={`${bytes} bytes of diff`}
          >
            {mount}
          </button>
        );
      })}
    </span>
  );
}

function PayloadLine({ len }: { len?: number | null }) {
  if (typeof len !== 'number' || len === 0) return <span className="muted">—</span>;
  return <span>{len} chars</span>;
}

function TurnsLine({ turns }: { turns: Array<Record<string, unknown>> }) {
  if (turns.length === 0) return <span className="muted">no turns</span>;
  let tokensIn = 0;
  let tokensOut = 0;
  let latency = 0;
  for (const t of turns) {
    if (typeof t.tokensIn === 'number') tokensIn += t.tokensIn;
    if (typeof t.tokensOut === 'number') tokensOut += t.tokensOut;
    if (typeof t.latencyMs === 'number') latency += t.latencyMs;
  }
  return (
    <span>
      {turns.length}× <span className="muted">·</span> {tokensIn}→{tokensOut}{' '}
      tok{' '}
      {latency > 0 && (
        <>
          <span className="muted">·</span> {(latency / 1000).toFixed(1)}s
        </>
      )}
    </span>
  );
}

function DecisionsLine({
  events,
}: {
  events: Array<Record<string, unknown>>;
}) {
  if (events.length === 0) return <span className="muted">no events</span>;
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (typeof ev.type !== 'string') continue;
    if (!ev.type.startsWith('decision.')) continue;
    const key = ev.type.slice('decision.'.length);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0)
    return <span className="muted">{events.length} events</span>;
  return (
    <span className="dec-line">
      {[...counts.entries()].map(([k, v]) => (
        <span key={k}>
          <code>{k}</code>
          <span className="muted">:</span>
          {v}
        </span>
      ))}
    </span>
  );
}

function StreamsLine({
  sizes,
}: {
  sizes?: { agent: number; stdout: number; stderr: number };
}) {
  if (!sizes) return <span className="muted">—</span>;
  const parts: string[] = [];
  if (sizes.agent > 0) parts.push(`agent ${fmtBytes(sizes.agent)}`);
  if (sizes.stdout > 0) parts.push(`stdout ${fmtBytes(sizes.stdout)}`);
  if (sizes.stderr > 0) parts.push(`stderr ${fmtBytes(sizes.stderr)}`);
  if (parts.length === 0) return <span className="muted">empty</span>;
  return <span>{parts.join(' · ')}</span>;
}

// --- Formatters --------------------------------------------------------

function pickStr(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function pickNum(
  obj: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

function fmtDuration(ms: number | null): React.ReactNode {
  if (typeof ms !== 'number') return <span className="muted">—</span>;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtTarget(t: unknown): React.ReactNode {
  if (t === null || t === undefined) return <span className="muted">end</span>;
  if (typeof t === 'string') return <code>{t}</code>;
  if (Array.isArray(t)) return <code>{t.join(', ')}</code>;
  return <span className="muted">—</span>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function hasAnyStream(
  sizes?: { agent: number; stdout: number; stderr: number },
): boolean {
  if (!sizes) return false;
  return sizes.agent > 0 || sizes.stdout > 0 || sizes.stderr > 0;
}
