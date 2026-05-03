import type { ReactNode } from 'react';

interface Props {
  text: string;
}

function isSafeHref(href: string): boolean {
  if (href.startsWith('#')) return true;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function nextSpecialIndex(text: string, start: number): number {
  const indexes = ['`', '[', '*']
    .map((token) => text.indexOf(token, start))
    .filter((idx) => idx !== -1);
  return indexes.length ? Math.min(...indexes) : text.length;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  function pushText(end: number) {
    if (end > i) nodes.push(text.slice(i, end));
    i = end;
  }

  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        nodes.push(<code key={`${keyPrefix}-code-${key++}`}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        nodes.push(
          <strong key={`${keyPrefix}-strong-${key++}`}>
            {renderInline(text.slice(i + 2, end), `${keyPrefix}-strong-${key}`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        nodes.push(
          <em key={`${keyPrefix}-em-${key++}`}>
            {renderInline(text.slice(i + 1, end), `${keyPrefix}-em-${key}`)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }

    if (text[i] === '[') {
      const labelEnd = text.indexOf(']', i + 1);
      const hrefStart = labelEnd !== -1 && text[labelEnd + 1] === '(' ? labelEnd + 2 : -1;
      const hrefEnd = hrefStart !== -1 ? text.indexOf(')', hrefStart) : -1;
      if (hrefEnd !== -1) {
        const label = text.slice(i + 1, labelEnd);
        const href = text.slice(hrefStart, hrefEnd).trim();
        if (isSafeHref(href)) {
          nodes.push(
            <a key={`${keyPrefix}-link-${key++}`} href={href} target="_blank" rel="noreferrer">
              {renderInline(label, `${keyPrefix}-link-${key}`)}
            </a>,
          );
        } else {
          nodes.push(`[${label}](${href})`);
        }
        i = hrefEnd + 1;
        continue;
      }
    }

    pushText(nextSpecialIndex(text, i + 1));
  }

  return nodes;
}

function collectParagraph(lines: string[], start: number): { text: string; next: number } {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('```') ||
      /^#{1,6}\s+/.test(trimmed) ||
      /^>\s?/.test(trimmed) ||
      /^([-*])\s+/.test(trimmed) ||
      /^\d+[.)]\s+/.test(trimmed)
    ) {
      break;
    }
    parts.push(lines[i].trim());
    i += 1;
  }
  return { text: parts.join(' '), next: i };
}

function collectList(lines: string[], start: number, ordered: boolean): { items: string[]; next: number } {
  const items: string[] = [];
  let i = start;
  const pattern = ordered ? /^\d+[.)]\s+(.*)$/ : /^[-*]\s+(.*)$/;
  while (i < lines.length) {
    const match = pattern.exec(lines[i].trim());
    if (!match) break;
    items.push(match[1]);
    i += 1;
  }
  return { items, next: i };
}

export function MarkdownMessage({ text }: Props) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre key={`block-${key++}`} className="md-code-block">
          <code data-language={language || undefined}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`block-${key++}`}>{renderInline(heading[2], `h-${key}`)}</Tag>);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={`block-${key++}`}>{renderInline(quote.join(' '), `q-${key}`)}</blockquote>);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const { items, next } = collectList(lines, i, false);
      blocks.push(
        <ul key={`block-${key++}`}>
          {items.map((item, idx) => <li key={idx}>{renderInline(item, `ul-${key}-${idx}`)}</li>)}
        </ul>,
      );
      i = next;
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const { items, next } = collectList(lines, i, true);
      blocks.push(
        <ol key={`block-${key++}`}>
          {items.map((item, idx) => <li key={idx}>{renderInline(item, `ol-${key}-${idx}`)}</li>)}
        </ol>,
      );
      i = next;
      continue;
    }

    const paragraph = collectParagraph(lines, i);
    blocks.push(<p key={`block-${key++}`}>{renderInline(paragraph.text, `p-${key}`)}</p>);
    i = paragraph.next;
  }

  return <div className="markdown-body">{blocks}</div>;
}
