/**
 * Pure helpers for the dbmlx completion provider — no `vscode` imports so they
 * can be unit-tested in a Node environment.
 *
 * See `specs/09-autocomplete.md` for the requirements driving these.
 */

// ── B13/B14: comment / string-value detection ─────────────────────────────

/**
 * True if `linePrefix` ends inside a `// comment`, a single-quoted string
 * literal `'…'`, or a backtick expression `` `…` ``.
 *
 * dbmlx uses `"…"` for *quoted identifiers* (table/column names with spaces),
 * NOT for string values — so an unbalanced `"` is NOT a "string context" here.
 * Single-quote and backtick regions ARE string-like and suppress completions.
 */
export function isInsideStringOrComment(linePrefix: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < linePrefix.length; i++) {
    const ch = linePrefix[i];
    if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
    else if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle;
    else if (!inDouble && !inSingle && ch === '`') inBacktick = !inBacktick;
    else if (
      !inDouble && !inSingle && !inBacktick &&
      ch === '/' && linePrefix[i + 1] === '/'
    ) return true;
  }
  return inSingle || inBacktick;
}

// ── A1/A4: quote-token replace range detection ────────────────────────────

/**
 * Locate an *unclosed* `"` in `linePrefix`. The opening quote is identified
 * by parity: every additional `"` toggles whether the cursor is inside a
 * quoted token.
 *
 *   `Ref: "pub`           → { openCol: 5 }
 *   `Ref: "public".`      → null  (closed)
 *   `Ref: "public"."pu`   → { openCol: 14 }
 */
export function findUnclosedQuoteOpen(linePrefix: string): { openCol: number } | null {
  let openCol = -1;
  for (let i = 0; i < linePrefix.length; i++) {
    if (linePrefix[i] === '"') openCol = openCol < 0 ? i : -1;
  }
  return openCol >= 0 ? { openCol } : null;
}

/**
 * Compute the replace range for a completion item whose `insertText` begins
 * with `"`. Covers the unclosed quote token plus the auto-inserted closing
 * `"` (if VS Code added one) — so accepting `"public".` doesn't produce
 * `""public"".` or leave a dangling `"`.
 *
 * Returns `null` when there is no unclosed quote at the cursor.
 */
export function computeQuoteReplaceRange(
  lineText: string,
  cursor: number,
): { startCol: number; endCol: number } | null {
  const linePrefix = lineText.substring(0, cursor);
  const open = findUnclosedQuoteOpen(linePrefix);
  if (!open) return null;
  const endCol = lineText[cursor] === '"' ? cursor + 1 : cursor;
  return { startCol: open.openCol, endCol };
}

/** Same as {@link computeQuoteReplaceRange} but extends past a trailing `.`. */
export function computeQuoteReplaceRangeDot(
  lineText: string,
  cursor: number,
): { startCol: number; endCol: number } | null {
  const base = computeQuoteReplaceRange(lineText, cursor);
  if (!base) return null;
  const charAfter = lineText[base.endCol];
  return charAfter === '.' ? { ...base, endCol: base.endCol + 1 } : base;
}

// ── B5/B7: bracket [...] classification ───────────────────────────────────

export type BracketState =
  | { kind: 'modify-keys' }
  | { kind: 'ref-operator' }
  | { kind: 'ref-table-column' }
  | { kind: 'settings' };

/**
 * Given the text between the most recent `[` and the cursor, decide what
 * completions to offer.
 *
 *   `[modify: n`              → modify-keys
 *   `[pk, modify: name="x", ` → modify-keys (still inside modify args)
 *   `[ref:`                   → ref-operator
 *   `[ref: > `                → ref-table-column
 *   `[ref: > a.b, `           → settings (cursor is past the ref item)
 *   `[pk, `                   → settings
 *   `[add ref:`               → ref-operator (the `ref:` prefix wins)
 */
export function classifyBracket(bracketContent: string): BracketState {
  let lastModify = -1, lastRef = -1;
  let m: RegExpExecArray | null;
  const modRe = /\bmodify\s*:/gi;
  const refRe = /\bref\s*:/gi;
  while ((m = modRe.exec(bracketContent))) lastModify = m.index;
  while ((m = refRe.exec(bracketContent))) lastRef = m.index;

  if (lastModify >= 0 && lastModify > lastRef) return { kind: 'modify-keys' };

  if (lastRef >= 0) {
    const afterRef = bracketContent.slice(lastRef);
    const hasOperator = /(?:<>|[<>-])/.test(afterRef);
    // A target is one or more dotted identifier segments — handles 2-segment
    // (`table.col`) and 3-segment (`schema.table.col`) qualifications equally.
    const targetRe = /(?:<>|[<>-])\s*(?:"[^"]+"|\w+)(?:\.(?:"[^"]*"|\w+))+/;
    const targetCommaRe = /(?:<>|[<>-])\s*(?:"[^"]+"|\w+)(?:\.(?:"[^"]*"|\w+))+\s*,/;
    const refIsComplete = hasOperator && targetRe.test(afterRef);
    const commaAfterRef = refIsComplete && targetCommaRe.test(afterRef);
    if (commaAfterRef) return { kind: 'settings' };
    if (hasOperator) return { kind: 'ref-table-column' };
    return { kind: 'ref-operator' };
  }
  return { kind: 'settings' };
}

// ── C: ref chain step detection ───────────────────────────────────────────

export type RefStep =
  | { kind: 'left-empty' }            // `Ref: ` — schemas + unqualified tables
  | { kind: 'left-after-dot'; schema: string } // `Ref: schema.` — handled by dotMatch
  | { kind: 'operator' }              // `Ref: a.b ` — operators
  | { kind: 'right-empty' }           // `Ref: a.b > ` — schemas + unqualified tables
  | null;

/**
 * Classify the cursor's position relative to a Ref expression. The caller
 * passes everything *after* the `Ref [name]: ` prefix (or after `[ref: ` for
 * inline refs) and gets back one of the steps above.
 *
 * Returns `null` if the prefix is mid-token in a way the dotMatch path will
 * handle (e.g. `schema.`, `schema.table.`, `> schema.`).
 */
export function classifyRefStep(refPrefix: string): RefStep {
  // Normalise: trim leading whitespace
  const trimmed = refPrefix.replace(/^\s+/, '');

  // Past an operator
  const opMatch = /(<>|[<>-])\s*([^<>-].*)?$/.exec(trimmed);
  if (opMatch) {
    const after = opMatch[2] ?? '';
    if (after === '' || after === '"') return { kind: 'right-empty' };
    if (/\.$/.test(after) || /\.[\w"]+$/.test(after)) return null; // dotMatch handles
    if (/^"?[\w]*$/.test(after)) return { kind: 'right-empty' };
    return null;
  }

  // No operator — left side
  if (trimmed === '' || trimmed === '"') return { kind: 'left-empty' };

  // `table.col` or `schema.table.col` (and any further dotted segments) —
  // trailing whitespace optional.
  const tableCol = /^(?:"[^"]+"|\w+)(?:\.(?:"[^"]*"|\w+))+\s*$/;
  if (tableCol.test(trimmed)) return { kind: 'operator' };

  return null;
}

// ── D4: dedupe used columns in indexes line ───────────────────────────────

/**
 * Extract bare column-name tokens already mentioned earlier on the same
 * indexes line — used to filter them out of further suggestions on the line.
 *
 *   `(domain_id, user_id, ` → ['domain_id', 'user_id']
 *   `domain_id, ` → ['domain_id']
 *   `(name, ` → ['name']
 */
export function usedColumnsOnLine(linePrefix: string): string[] {
  // Strip leading `(` if present (composite tuple); collect identifier tokens
  // separated by commas. Stop at any `[` (entering settings bracket).
  const beforeBracket = linePrefix.split('[')[0]!;
  const out: string[] = [];
  // Match identifiers (with optional quotes) followed by `,` or `)`
  const re = /(?:"([^"]+)"|(\w+))\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(beforeBracket))) {
    const tok = m[1] ?? m[2]!;
    if (tok) out.push(tok);
  }
  return out;
}

// ── B6: detect a top-level Ref line ───────────────────────────────────────

// Top-level `Ref [name]: …` at line start (case-insensitive — the existing
// codebase historically accepts `Ref` and `ref` interchangeably here).
const REF_LINE_PREFIX_RE = /^\s*[Rr]ef\b(?:\s+(?:"[^"]+"|[\w]+))?\s*:\s*/;

/** True if `linePrefix` is positioned inside a `Ref [name]: …` line. */
export function isRefLine(linePrefix: string): boolean {
  return REF_LINE_PREFIX_RE.test(linePrefix);
}

/** Returns everything after the `Ref [name]: ` prefix, or `null` if not a Ref line. */
export function extractRefPrefix(linePrefix: string): string | null {
  const m = REF_LINE_PREFIX_RE.exec(linePrefix);
  return m ? linePrefix.substring(m[0].length) : null;
}
