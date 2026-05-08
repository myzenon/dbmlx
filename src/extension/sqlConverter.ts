// TODO: lazy-load @dbml/core here instead of at module load time.
// The ANTLR SQL parsers (MSSQL 3.8MB, PG 2.6MB, Snowflake 2.4MB, MySQL 2MB) are bundled
// eagerly and inflate the extension to ~10MB, even though importFromSql is rarely used.
// Fix: dynamic import('@dbml/core') inside importFromSql() + split into a separate esbuild
// entry point so the parsers are only loaded when the command actually fires.
import * as vscode from 'vscode';
import { importer, exporter } from '@dbml/core';
import type { WorkspaceIndex } from './workspaceIndex';
import { stripDbmlxExtensions } from './parser';

type SqlEngine = 'mysql' | 'postgres' | 'mssql';

const ENGINE_ITEMS: Array<{ label: string; description: string; id: SqlEngine }> = [
  { label: 'MySQL',      description: 'MySQL / MariaDB',   id: 'mysql'    },
  { label: 'PostgreSQL', description: 'PostgreSQL',        id: 'postgres' },
  { label: 'SQL Server', description: 'Microsoft SQL Server (T-SQL)', id: 'mssql' },
];

export function registerSqlConverterCommands(
  index: WorkspaceIndex,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dbmlx.exportToSql', () => exportToSql(index)),
    vscode.commands.registerCommand('dbmlx.importFromSql', () => importFromSql()),
  );
}

// ── Export: .dbmlx → SQL ──────────────────────────────────────────────────

async function exportToSql(index: WorkspaceIndex): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.dbmlx')) {
    vscode.window.showErrorMessage('DBMLX: open a .dbmlx file first.');
    return;
  }

  const engine = await pickEngine();
  if (!engine) return;

  // Prefer the stitched content (resolved !includes); fall back to raw file text
  const raw = index.getStitchedContent(editor.document.uri) ?? editor.document.getText();
  const dbml = stripDbmlxExtensions(raw);

  let sql: string;
  try {
    sql = exporter.export(dbml, engine.id);
  } catch (err) {
    vscode.window.showErrorMessage(`DBMLX: export failed — ${errorMessage(err)}`);
    return;
  }

  const langId = engine.id === 'mssql' ? 'sql' : engine.id === 'postgres' ? 'sql' : 'sql';
  const doc = await vscode.workspace.openTextDocument({ language: langId, content: sql });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ── Import: SQL → .dbmlx ──────────────────────────────────────────────────

async function importFromSql(): Promise<void> {
  const engine = await pickEngine();
  if (!engine) return;

  // Use active editor if it looks like SQL; otherwise show file picker
  let sqlContent: string | undefined;
  const active = vscode.window.activeTextEditor;
  if (active && (active.document.languageId === 'sql' || active.document.fileName.endsWith('.sql'))) {
    sqlContent = active.document.getText();
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'SQL files': ['sql'] },
      title: `Pick SQL file to import (${engine.label})`,
    });
    if (!uris || uris.length === 0) return;
    const bytes = await vscode.workspace.fs.readFile(uris[0]!);
    sqlContent = Buffer.from(bytes).toString('utf8');
  }

  const sanitized = sanitizeSqlForImport(sqlContent, engine.id);

  let dbml: string;
  try {
    dbml = importer.import(sanitized, engine.id);
  } catch (err) {
    vscode.window.showErrorMessage(`DBMLX: import failed — ${errorMessage(err)}`);
    return;
  }

  if (!dbml.trim()) {
    vscode.window.showErrorMessage('DBMLX: import produced no output — the SQL may contain unsupported syntax.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument({ language: 'dbmlx', content: dbml });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ── SQL sanitizer ─────────────────────────────────────────────────────────

/**
 * Strip SQL constructs that @dbml/core cannot parse.
 * For postgres: keeps only CREATE TABLE, ALTER TABLE...FOREIGN KEY, and CREATE TYPE...ENUM.
 * Removes pg_dump boilerplate: SET, ALTER ROLE, GRANT, REVOKE, COMMENT, sequences,
 * partition definitions, identity columns, ATTACH PARTITION, etc.
 */
function sanitizeSqlForImport(sql: string, engine: SqlEngine): string {
  if (engine !== 'postgres') return sql;

  const statements = splitSqlStatements(sql);
  const kept: string[] = [];

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    // Strip leading comment lines — pg_dump embeds "-- Name: ...; Type: TABLE" comments
    // inside the same semicolon-delimited block as the following DDL statement.
    const stripped = trimmed.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (!stripped) continue;

    const upper = stripped.toUpperCase().replace(/\s+/g, ' ');

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE UNLOGGED TABLE')) {
      kept.push(sanitizeCreateTable(stripped));
      continue;
    }

    if (upper.startsWith('ALTER TABLE') && upper.includes('FOREIGN KEY')) {
      kept.push(stripped);
      continue;
    }

    if (upper.startsWith('CREATE TYPE') && upper.includes('AS ENUM')) {
      kept.push(stripped);
      continue;
    }

    if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
      kept.push(stripped);
      continue;
    }

    // Skip everything else: SET, ALTER ROLE, GRANT, REVOKE, COMMENT, CREATE SEQUENCE,
    // ALTER SEQUENCE, CREATE INDEX, CREATE EXTENSION, ATTACH PARTITION, etc.
  }

  return kept.join(';\n\n') + (kept.length > 0 ? ';' : '');
}

/**
 * Split a SQL string into individual statements by semicolons,
 * respecting single-quoted strings and dollar-quoted blocks ($$).
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDollarQuote = false;
  let inLineComment = false;
  let dollarTag = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    // Detect -- line comments before any other check so semicolons inside them are ignored
    if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }

    if (inDollarQuote) {
      current += ch;
      if (ch === '$') {
        // Check if closing tag matches opening tag
        const end = sql.indexOf('$', i + 1);
        if (end !== -1) {
          const tag = sql.slice(i, end + 1);
          if (tag === dollarTag) {
            current += sql.slice(i + 1, end + 1);
            i = end;
            inDollarQuote = false;
            dollarTag = '';
          }
        }
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && sql[i + 1] === "'") { current += "'"; i++; } // escaped quote
      else if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (ch === "'") { inSingleQuote = true; current += ch; continue; }

    // Detect dollar-quote opening: $tag$ or $$
    if (ch === '$') {
      const end = sql.indexOf('$', i + 1);
      if (end !== -1 && /^[A-Za-z0-9_]*$/.test(sql.slice(i + 1, end))) {
        dollarTag = sql.slice(i, end + 1);
        inDollarQuote = true;
        current += dollarTag;
        i = end;
        continue;
      }
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Remove PostgreSQL clauses from a CREATE TABLE statement that @dbml/core cannot parse:
 * - PARTITION BY ... at the end of the table definition
 * - INHERITS (...) clause
 */
function sanitizeCreateTable(stmt: string): string {
  // Remove PARTITION BY ... after the closing paren of column list
  // Pattern: ) PARTITION BY ... at end of statement
  stmt = stmt.replace(/\)\s*PARTITION\s+BY\s+\w+\s*\([^)]*\)\s*$/i, ')');

  // Remove INHERITS (...) clause
  stmt = stmt.replace(/\)\s*INHERITS\s*\([^)]*\)\s*$/i, ')');

  // Remove GENERATED ALWAYS AS IDENTITY (...) from column definitions
  // These appear as: col_name type GENERATED ALWAYS AS IDENTITY (...)
  stmt = stmt.replace(/\bGENERATED\s+ALWAYS\s+AS\s+IDENTITY\s*(?:\([^)]*\))?/gi, '');

  // Remove GENERATED BY DEFAULT AS IDENTITY (...)
  stmt = stmt.replace(/\bGENERATED\s+BY\s+DEFAULT\s+AS\s+IDENTITY\s*(?:\([^)]*\))?/gi, '');

  // Normalize PostgreSQL multi-word types to simpler equivalents @dbml/core handles
  stmt = stmt.replace(/\bcharacter\s+varying\b/gi, 'varchar');
  stmt = stmt.replace(/\btimestamp\s+without\s+time\s+zone\b/gi, 'timestamp');
  stmt = stmt.replace(/\btimestamp\s+with\s+time\s+zone\b/gi, 'timestamptz');
  stmt = stmt.replace(/\btime\s+without\s+time\s+zone\b/gi, 'time');
  stmt = stmt.replace(/\bdouble\s+precision\b/gi, 'float8');

  // Strip PostgreSQL type cast syntax (::type) — @dbml/core cannot parse these.
  // Matches :: followed by a type name (one or two non-keyword words) with optional (n) or (n,m).
  stmt = stmt.replace(
    /::[a-zA-Z][a-zA-Z0-9_]*(?:\s+(?!NOT\b|NULL\b|DEFAULT\b|CHECK\b|REFERENCES\b|UNIQUE\b|PRIMARY\b|FOREIGN\b)[a-zA-Z][a-zA-Z0-9_]*)*(?:\(\d+(?:,\s*\d+)?\))?/g,
    '',
  );

  return stmt.trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function pickEngine(): Promise<{ label: string; id: SqlEngine } | undefined> {
  const pick = await vscode.window.showQuickPick(ENGINE_ITEMS, {
    title: 'Select SQL engine',
    placeHolder: 'MySQL · PostgreSQL · SQL Server',
  });
  return pick;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    if (Array.isArray(e.diags) && e.diags.length > 0) {
      const d = e.diags[0] as Record<string, unknown>;
      if (typeof d.message === 'string') return d.message;
    }
  }
  return String(err);
}
