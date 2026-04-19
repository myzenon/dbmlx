import * as vscode from 'vscode';

export class DbmlxFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    doc: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
    const original = doc.getText();
    const formatted = formatDbmlx(original, indent);
    if (formatted === original) return [];
    const full = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(original.length),
    );
    return [vscode.TextEdit.replace(full, formatted)];
  }
}

// ── Core formatter ─────────────────────────────────────────────────────────

export function formatDbmlx(source: string, indent = '  '): string {
  const rawLines = source.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let prevBlank = false;
  let prevTopLevel = false; // was the last non-blank line at depth 0?
  let prevTopLevelWasBlock = false; // did the previous top-level line open a block?

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const trimmed = normalizeInline(raw.trim());

    if (!trimmed) {
      prevBlank = true;
      continue;
    }

    // Count closing braces at the start of this line to outdent first
    const closingCount = leadingClosingBraces(trimmed);
    depth = Math.max(0, depth - closingCount);

    // Insert blank line between top-level items only when at least one side is a block.
    // This keeps consecutive !include / Ref lines together while still separating
    // Table/Enum/TableGroup blocks from everything around them.
    const isTopLevel = depth === 0;
    const isBlock = netOpeningBraces(trimmed) > 0;
    if (isTopLevel && out.length > 0 && prevTopLevel && (isBlock || prevTopLevelWasBlock)) {
      out.push('');
    } else if (!isTopLevel && prevBlank && out.length > 0) {
      // Preserve at most one blank line inside a block
      out.push('');
    }

    out.push(indent.repeat(depth) + trimmed);
    prevBlank = false;
    prevTopLevelWasBlock = isTopLevel && isBlock;
    prevTopLevel = depth === 0;

    // Count net opening braces to indent subsequent lines
    depth += netOpeningBraces(trimmed);
  }

  // Trim trailing blank lines, ensure single trailing newline
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  out.push('');

  return out.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a single already-trimmed line:
 * - ensure space before `{` (e.g. `Table foo{` → `Table foo {`)
 * - space after `,` inside `[…]` brackets
 * - collapse internal runs of spaces to single space (outside strings)
 */
function normalizeInline(line: string): string {
  if (!line) return line;

  let result = '';
  let inString = false;
  let stringChar = '';
  let inBracket = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];

    // Track string literals (single or double quote)
    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
      result += ch;
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === stringChar && line[i - 1] !== '\\') inString = false;
      continue;
    }

    // Track bracket context
    if (ch === '[') { inBracket = true; result += ch; continue; }
    if (ch === ']') { inBracket = false; result += ch; continue; }

    // Space before `{`
    if (ch === '{' && result.length > 0 && result[result.length - 1] !== ' ') {
      result += ' {';
      continue;
    }

    // Space after `,` inside brackets
    if (inBracket && ch === ',' && next !== ' ') {
      result += ', ';
      continue;
    }

    // Collapse multiple spaces outside strings (keep single)
    if (ch === ' ' && result[result.length - 1] === ' ') {
      continue;
    }

    result += ch;
  }

  return result;
}

/** Count how many `}` appear at the very start of the trimmed line. */
function leadingClosingBraces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === '}') n++;
    else break;
  }
  return n;
}

/**
 * Net `{` minus `}` in a line, ignoring those inside strings and `[…]`.
 * Used to determine how much to increase indent after this line.
 */
function netOpeningBraces(line: string): number {
  let opens = 0;
  let inStr = false;
  let strCh = '';
  let inBracket = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (!inStr && (ch === '"' || ch === "'")) { inStr = true; strCh = ch; continue; }
    if (inStr) { if (ch === strCh && line[i - 1] !== '\\') inStr = false; continue; }
    if (ch === '[') { inBracket = true; continue; }
    if (ch === ']') { inBracket = false; continue; }
    if (!inBracket) {
      if (ch === '{') opens++;
      else if (ch === '}') opens--;
    }
  }
  return Math.max(0, opens);
}
