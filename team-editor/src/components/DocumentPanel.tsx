import { useState, useCallback } from 'react';
import { useDocumentPoller } from '../hooks/useDocumentPoller';
import './DocumentPanel.css';

// ── Simple markdown rendering ──

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\d+\. (.+)$/gm, '<div class="doc-list-item">$&</div>')
    .replace(/^- (.+)$/gm, '<div class="doc-list-item">$&</div>')
    .replace(/\n/g, '<br/>');
}

// ── Diff types and utilities ──

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

interface DiffSection {
  kind: 'context' | 'hunk';
  lines: DiffLine[];
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === undefined) {
      result.push({ type: 'added', text: newLine! });
    } else if (newLine === undefined) {
      result.push({ type: 'removed', text: oldLine });
    } else if (oldLine !== newLine) {
      result.push({ type: 'removed', text: oldLine });
      result.push({ type: 'added', text: newLine });
    } else {
      result.push({ type: 'unchanged', text: newLine });
    }
  }

  return result;
}

function groupIntoSections(lines: DiffLine[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;

  for (const line of lines) {
    const kind = line.type === 'unchanged' ? 'context' : 'hunk';
    if (!current || current.kind !== kind) {
      current = { kind, lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }

  return sections;
}

// ── Diff Review Component ──

function DiffReview({
  oldText,
  newText,
  onResolve,
  onDismiss,
}: {
  oldText: string;
  newText: string;
  onResolve: (finalContent: string | null) => void;
  onDismiss: () => void;
}) {
  const lines = computeDiff(oldText, newText);
  const sections = groupIntoSections(lines);
  const hunkCount = sections.filter((s) => s.kind === 'hunk').length;

  const [decisions, setDecisions] = useState<Record<number, boolean>>({});

  const setDecision = useCallback((idx: number, approved: boolean) => {
    setDecisions((prev) => ({ ...prev, [idx]: approved }));
  }, []);

  const setAll = useCallback(
    (approved: boolean) => {
      const d: Record<number, boolean> = {};
      let i = 0;
      for (const s of sections) {
        if (s.kind === 'hunk') {
          d[i] = approved;
          i++;
        }
      }
      setDecisions(d);
    },
    [sections],
  );

  const allDecided = Object.keys(decisions).length === hunkCount;

  const handleApply = useCallback(() => {
    const resultLines: string[] = [];
    let hi = 0;
    for (const section of sections) {
      if (section.kind === 'context') {
        for (const line of section.lines) resultLines.push(line.text);
      } else {
        const approved = decisions[hi] ?? true;
        for (const line of section.lines) {
          if (approved) {
            // Keep added lines, drop removed lines
            if (line.type === 'added' || line.type === 'unchanged')
              resultLines.push(line.text);
          } else {
            // Keep removed lines (revert), drop added lines
            if (line.type === 'removed' || line.type === 'unchanged')
              resultLines.push(line.text);
          }
        }
        hi++;
      }
    }

    const finalContent = resultLines.join('\n');
    // If all approved, no file write needed (content already matches)
    onResolve(finalContent === newText ? null : finalContent);
  }, [sections, decisions, newText, onResolve]);

  let hunkIdx = 0;

  return (
    <div className="doc-diff-review">
      <div className="doc-diff-toolbar">
        <button
          className="doc-diff-btn doc-diff-btn--approve-all"
          onClick={() => setAll(true)}
        >
          Y All
        </button>
        <button
          className="doc-diff-btn doc-diff-btn--discard-all"
          onClick={() => setAll(false)}
        >
          N All
        </button>
        <button
          className="doc-diff-btn doc-diff-btn--apply"
          onClick={handleApply}
          disabled={!allDecided}
        >
          Apply
        </button>
        <button
          className="doc-diff-btn doc-diff-btn--close"
          onClick={onDismiss}
          title="Close diff review"
        >
          &times;
        </button>
      </div>
      <div className="doc-diff">
        {sections.map((section, si) => {
          if (section.kind === 'context') {
            return (
              <div key={si}>
                {section.lines.map((line, li) => (
                  <div
                    key={li}
                    className="doc-diff-line doc-diff-line--unchanged"
                  >
                    <span className="doc-diff-prefix"> </span>
                    <span>{line.text || '\u00A0'}</span>
                  </div>
                ))}
              </div>
            );
          }

          const idx = hunkIdx++;
          const decision = decisions[idx];
          const hunkClass =
            decision === true
              ? 'doc-diff-hunk--approved'
              : decision === false
                ? 'doc-diff-hunk--discarded'
                : '';

          return (
            <div key={si} className={`doc-diff-hunk ${hunkClass}`}>
              <div className="doc-diff-hunk-actions">
                <button
                  className={`doc-diff-hunk-btn doc-diff-hunk-btn--y ${decision === true ? 'active' : ''}`}
                  onClick={() => setDecision(idx, true)}
                >
                  Y
                </button>
                <button
                  className={`doc-diff-hunk-btn doc-diff-hunk-btn--n ${decision === false ? 'active' : ''}`}
                  onClick={() => setDecision(idx, false)}
                >
                  N
                </button>
              </div>
              {section.lines.map((line, li) => (
                <div
                  key={li}
                  className={`doc-diff-line doc-diff-line--${line.type}`}
                >
                  <span className="doc-diff-prefix">
                    {line.type === 'added'
                      ? '+'
                      : line.type === 'removed'
                        ? '-'
                        : ' '}
                  </span>
                  <span>{line.text || '\u00A0'}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Component ──

export function DocumentPanel({
  title,
  path,
}: {
  title: string;
  path: string;
}) {
  const { content, prevContent, hasChanged, isLoading, pendingReview, resolveReview } =
    useDocumentPoller(path);

  return (
    <div className="doc-panel">
      <div className="doc-panel-header">
        <span className="doc-panel-title">{title}</span>
        {hasChanged && <span className="doc-panel-badge">Updated</span>}
      </div>
      <div className="doc-panel-body">
        {isLoading ? (
          <div className="doc-placeholder">Loading...</div>
        ) : content === null ? (
          <div className="doc-placeholder">Waiting for agent...</div>
        ) : pendingReview && prevContent !== null ? (
          <DiffReview
            oldText={prevContent}
            newText={content}
            onResolve={resolveReview}
            onDismiss={() => resolveReview(null)}
          />
        ) : (
          <div
            className="doc-rendered"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>
    </div>
  );
}
