// Minimal shell-script tokenizer for syntax highlighting in L3CommandViewer.
// Not a full bash parser — handles the common cases (comments, strings,
// variables, keywords, builtins, operators, numbers) well enough to make
// scripts readable at a glance. Heredocs and command substitution bodies
// are rendered as plain text.

export type ShTokenType =
  | 'shebang'
  | 'comment'
  | 'string'
  | 'var'
  | 'keyword'
  | 'builtin'
  | 'op'
  | 'number'
  | 'plain';

export interface ShToken {
  type: ShTokenType;
  text: string;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'in',
  'do',
  'done',
  'while',
  'until',
  'case',
  'esac',
  'function',
  'return',
  'break',
  'continue',
  'select',
  'time',
]);

const BUILTINS = new Set([
  'echo',
  'printf',
  'cd',
  'pwd',
  'export',
  'unset',
  'set',
  'source',
  'eval',
  'exec',
  'exit',
  'read',
  'test',
  'true',
  'false',
  'let',
  'local',
  'declare',
  'typeset',
  'readonly',
  'shift',
  'umask',
  'trap',
  'wait',
  'jobs',
  'kill',
  'alias',
  'unalias',
  'getopts',
  'command',
  'type',
  'hash',
  'mapfile',
  'readarray',
]);

const isWordChar = (c: string) => /[A-Za-z0-9_./\-]/.test(c);
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);

export function tokenizeShell(src: string): ShToken[] {
  const out: ShToken[] = [];
  const n = src.length;
  let i = 0;

  const push = (type: ShTokenType, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  // Shebang line
  if (src.startsWith('#!')) {
    const eol = src.indexOf('\n');
    const end = eol === -1 ? n : eol;
    push('shebang', src.slice(0, end));
    i = end;
  }

  // Track whether we're at a position where a word would be in
  // "command position" — used to gate builtin highlighting and #-comments.
  let atCmdStart = true;

  while (i < n) {
    const ch = src[i];

    // Newline
    if (ch === '\n') {
      push('plain', '\n');
      i++;
      atCmdStart = true;
      continue;
    }

    // Whitespace
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      push('plain', src.slice(i, j));
      i = j;
      continue;
    }

    // Comment: # only at start-of-word (after whitespace / newline / op)
    if (ch === '#' && atCmdStart) {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }

    // Single-quoted string — no escapes inside in bash
    if (ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'") j++;
      if (j < n) j++;
      push('string', src.slice(i, j));
      i = j;
      atCmdStart = false;
      continue;
    }

    // Double-quoted string — supports backslash escapes; embedded $vars are
    // not split out for simplicity (the whole quoted span renders as string).
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        const c = src[j];
        if (c === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (c === '"') {
          j++;
          break;
        }
        j++;
      }
      push('string', src.slice(i, j));
      i = j;
      atCmdStart = false;
      continue;
    }

    // Variable: $WORD, ${...}, $1, $@, $?, etc.
    if (ch === '$') {
      const next = src[i + 1];
      if (next === '{') {
        let j = i + 2;
        let depth = 1;
        while (j < n && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
          j++;
        }
        push('var', src.slice(i, j));
        i = j;
        atCmdStart = false;
        continue;
      }
      if (next && isIdentStart(next)) {
        let j = i + 1;
        while (j < n && isIdent(src[j])) j++;
        push('var', src.slice(i, j));
        i = j;
        atCmdStart = false;
        continue;
      }
      if (next && /[0-9@?$#*!\-]/.test(next)) {
        push('var', src.slice(i, i + 2));
        i += 2;
        atCmdStart = false;
        continue;
      }
      push('plain', ch);
      i++;
      atCmdStart = false;
      continue;
    }

    // Multi/single-char operators
    if (ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>') {
      const two = src.slice(i, i + 2);
      if (
        two === '&&' ||
        two === '||' ||
        two === '>>' ||
        two === '<<' ||
        two === '|&' ||
        two === '>&' ||
        two === '<&'
      ) {
        push('op', two);
        i += 2;
      } else {
        push('op', ch);
        i++;
      }
      atCmdStart = true;
      continue;
    }

    // (...) and { ... } parens — treat as ops; reset cmd-start so the next
    // word in `( cmd; cmd )` highlights as a builtin/keyword.
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      push('op', ch);
      i++;
      atCmdStart = true;
      continue;
    }

    // Word
    if (isWordChar(ch)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      // Don't grab a trailing '-' that starts a flag of the next token — fine here.
      const word = src.slice(i, j);

      if (KEYWORDS.has(word)) {
        push('keyword', word);
      } else if (atCmdStart && BUILTINS.has(word)) {
        push('builtin', word);
      } else if (/^-?[0-9]+(\.[0-9]+)?$/.test(word)) {
        push('number', word);
      } else {
        push('plain', word);
      }
      i = j;
      atCmdStart = false;
      continue;
    }

    // Fallback
    push('plain', ch);
    i++;
    atCmdStart = false;
  }

  return out;
}
