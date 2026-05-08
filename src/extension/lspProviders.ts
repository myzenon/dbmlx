import * as vscode from 'vscode';
import * as nodePath from 'path';
import type { WorkspaceIndex } from './workspaceIndex';
import type { QualifiedName, Table } from '../shared/types';
import { DbmlxFormattingProvider } from './formatter';
import {
  isInsideStringOrComment,
  computeQuoteReplaceRange,
  computeQuoteReplaceRangeDot,
  classifyBracket,
  classifyRefStep,
  usedColumnsOnLine,
  isRefLine as isRefLineExpr,
  extractRefPrefix,
} from './completionContext';

const INCLUDE_LINE_RE = /^(?:\/\/|!)include\s+"([^"]*)"/;
const INCLUDE_PREFIX_RE = /^(?:\/\/|!)include\s+"([^"]*)$/;

// ── Hover docs ─────────────────────────────────────────────────────────────

const KEYWORD_HOVER: Record<string, { title: string; body: string }> = {
  table: {
    title: 'Table',
    body: 'Defines a database table.\n\n```dbmlx\nTable table_name [as alias] {\n  column_name type [settings]\n  indexes { ... }\n  Note: \'description\'\n}\n```',
  },
  ref: {
    title: 'Ref',
    body: 'Defines a foreign-key relationship.\n\n```dbmlx\nRef: a.col > b.col   // many-to-one\nRef: a.col < b.col   // one-to-many\nRef: a.col - b.col   // one-to-one\nRef: a.col <> b.col  // many-to-many\n```\n\nSupports `delete` / `update` actions: `cascade`, `restrict`, `set null`, `set default`, `no action`.',
  },
  enum: {
    title: 'Enum',
    body: 'Defines an enumerated type.\n\n```dbmlx\nEnum job_status {\n  created\n  running\n  done [note: \'Completed\']\n  failure\n}\n```',
  },
  tablegroup: {
    title: 'TableGroup',
    body: 'Groups tables into a bounded context (DDD aggregate).\n\n```dbmlx\nTableGroup billing {\n  orders\n  invoices\n}\n```',
  },
  diagramview: {
    title: 'DiagramView',
    body: 'Defines a named, filterable view of the diagram.\n\n```dbmlx\nDiagramView my_view {\n  Tables { table1, table2 }\n  TableGroups { billing }\n  Schemas { public }\n}\n```\n\nUse `*` as a wildcard to include everything on that axis. Omit an axis to exclude it entirely. Multiple axes combine with OR logic.',
  },
  project: {
    title: 'Project',
    body: 'Project-level metadata block.\n\n```dbmlx\nProject my_app {\n  database_type: \'PostgreSQL\'\n  Note: \'Description\'\n}\n```',
  },
  indexes: {
    title: 'indexes',
    body: 'Defines indexes for the enclosing table.\n\n```dbmlx\nindexes {\n  col                         // simple index\n  (col1, col2)                // composite\n  col [unique]                // unique\n  col [type: hash]            // hash index\n  col [name: \'idx_name\', pk]  // named / primary\n  `lower(name)` [type: btree] // expression index\n}\n```',
  },
  note: {
    title: 'note / Note',
    body: 'Attaches a human-readable description.\n\n```dbmlx\nNote: \'Table-level note\'\n// or in column settings:\nid int [note: \'Primary identifier\']\n```',
  },
};

const DIFF_ANNOTATION_HOVER: Record<string, { title: string; body: string }> = {
  add: {
    title: 'add — New in Migration',
    body: 'Marks this column **or table** as **added** in the current migration.\n\n**Column:** Renders with a green ➕ accent.\n```dbmlx\ncreated_at timestamp [add]\n```\n\n**Table:** Renders with a green border and `+NEW` badge.\n```dbmlx\nTable audit_log [add] {\n  id int [pk]\n}\n```',
  },
  drop: {
    title: 'drop — Dropped in Migration',
    body: 'Marks this column **or table** as **dropped** in the current migration.\n\n**Column:** Renders with a red strikethrough accent.\n```dbmlx\nlegacy_id int [drop]\n```\n\n**Table:** Renders with a red border, dimmed columns, and `DROP` badge.\n```dbmlx\nTable old_sessions [drop] {\n  id int [pk]\n}\n```',
  },
  modify: {
    title: 'modify — Modified Column or Renamed Table',
    body: 'Marks this **column** as modified, or a **table** as renamed, in the current migration.\n\n**Column:** Write the new name/type on the line; record originals in `modify:`.\n```dbmlx\nuser_login text [modify: name="username", type="varchar(50)"]\nemail varchar(255) [modify: type="varchar(100)"]\n```\n\n**Table rename:** Write the new table name; record the old name with `name=`.\n```dbmlx\nTable new_users [modify: name="users"] {\n  id int [pk]\n}\n```\nRenders with an amber border and a before→after name diff in the header.',
  },
  before: {
    title: 'before — Modified Column or Renamed Table (explicit)',
    body: 'Clearer alias for `modify:`. Records the **old** (before-migration) values for a modified column or renamed table.\n\n**Column:** Write the new name/type on the line; record the old values in `before:`.\n```dbmlx\nuser_login text [before: name="username", type="varchar(50)"]\nemail varchar(255) [before: type="varchar(100)"]\n```\n\n**Table rename:** Write the new table name; record the old name with `name=`.\n```dbmlx\nTable new_users [before: name="users"] {\n  id int [pk]\n}\n```\nRenders with an amber border and a before→after name diff in the header.',
  },
};

const SETTING_HOVER: Record<string, { title: string; body: string }> = {
  pk: {
    title: 'pk — Primary Key',
    body: 'Marks the column as the primary key. Implies `not null` and `unique`.',
  },
  'primary key': {
    title: 'primary key — Primary Key (verbose)',
    body: 'Marks the column as the primary key. Implies `not null` and `unique`.',
  },
  'not null': {
    title: 'not null',
    body: 'The column cannot contain `NULL` values.',
  },
  null: {
    title: 'null',
    body: 'The column allows `NULL` values (permissive; this is the default in most databases).',
  },
  unique: {
    title: 'unique',
    body: 'All values in this column must be unique across rows.',
  },
  increment: {
    title: 'increment',
    body: 'Auto-increment (serial) — the database automatically assigns a monotonically increasing value.',
  },
  default: {
    title: 'default',
    body: 'Fallback value used when no value is supplied on `INSERT`.\n\nAccepts: numbers, strings (`\'text\'`), expressions (`` `now()` ``), `true`, `false`, `null`.',
  },
  ref: {
    title: 'ref — Inline Reference',
    body: 'Declares a foreign-key relationship inline.\n\n```dbmlx\ncol int [ref: > other_table.col]\n```\n\n`>` many-to-one · `<` one-to-many · `-` one-to-one · `<>` many-to-many',
  },
};

const INDEX_SETTING_HOVER: Record<string, { title: string; body: string }> = {
  unique: { title: 'unique index', body: 'Creates a unique index — no two rows may have the same value(s) for the indexed column(s).' },
  pk: { title: 'pk — Primary Key index', body: 'Marks the index as the table\'s primary key.' },
  name: { title: 'name', body: 'Assigns an explicit name to the index.\n\n```dbmlx\ncol [name: \'idx_orders_created_at\']\n```' },
  type: { title: 'type', body: 'Index access method.\n\n- `btree` — balanced tree, supports range queries (default)\n- `hash` — equality lookups only, faster for `=`\n- `gin` — Generalized Inverted Index; arrays, JSONB, full-text search\n- `gist` — Generalized Search Tree; geometric types, full-text\n- `spgist` — Space-Partitioned GiST; non-balanced structures\n- `brin` — Block Range Index; large tables with natural ordering' },
  note: { title: 'note', body: 'Human-readable description for the index.' },
};

// ── Hover ──────────────────────────────────────────────────────────────────

class DbmlxHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const lineText = doc.lineAt(pos).text;
    const linePrefix = lineText.substring(0, pos.character);

    // ── !include hover ──────────────────────────────────────────────────────
    const incMatch = INCLUDE_LINE_RE.exec(lineText);
    if (incMatch) {
      const openQuote = lineText.indexOf('"');
      const closeQuote = lineText.indexOf('"', openQuote + 1);
      const col = pos.character;

      if (col < openQuote) {
        // Hovering the `!include` keyword
        const md = new vscode.MarkdownString();
        md.appendMarkdown('**!include**\n\nIncludes another dbmlx file into this schema.\n\n```dbmlx\n!include "relative/path/to/file.dbmlx"\n```\n\nAll tables, refs, and enums from the target file are merged into the combined schema.');
        return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, openQuote - 1));
      }

      if (col >= openQuote && col <= closeQuote) {
        // Hovering the file path
        const relPath = incMatch[1]!;
        const targetUri = vscode.Uri.joinPath(doc.uri, '..', relPath);
        const tables = this.index.getTablesInFile(targetUri);
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`**${relPath}**`);
        if (tables.length > 0) {
          md.appendMarkdown(`\n\n${tables.length} table${tables.length !== 1 ? 's' : ''}: ${tables.map(t => `\`${t.name}\``).join(', ')}`);
        }
        md.appendMarkdown(`\n\n[Open file](${targetUri.toString()})`);
        return new vscode.Hover(md, new vscode.Range(pos.line, openQuote + 1, pos.line, closeQuote));
      }
    }

    // ── keyword hover ───────────────────────────────────────────────────────
    const wordRange = doc.getWordRangeAtPosition(pos, /(?:"[^"]+"|[\w.])+/);
    if (wordRange) {
      const word = doc.getText(wordRange).replace(/"/g, '').toLowerCase();

      // "not null" / "not" before "null"
      if (word === 'not') {
        const after = lineText.substring(wordRange.end.character);
        if (/^\s+null\b/i.test(after)) {
          const info = SETTING_HOVER['not null']!;
          return this.keywordHover(info.title, info.body, wordRange);
        }
      }
      // "primary key" / "primary" before "key"
      if (word === 'primary') {
        const after = lineText.substring(wordRange.end.character);
        if (/^\s+key\b/i.test(after)) {
          const info = SETTING_HOVER['primary key']!;
          return this.keywordHover(info.title, info.body, wordRange);
        }
      }

      // Inside [...] → column or index settings
      if (/\[[^\]]*$/.test(linePrefix)) {
        // Distinguish index settings vs column settings by checking broader context
        const ctx = this.getContext(doc, pos);
        const insideIndexBlock = ctx.block === 'indexes';
        if (!insideIndexBlock) {
          const diffInfo = DIFF_ANNOTATION_HOVER[word];
          if (diffInfo) return this.keywordHover(diffInfo.title, diffInfo.body, wordRange);
        }
        const settingMap = insideIndexBlock ? INDEX_SETTING_HOVER : SETTING_HOVER;
        const info = settingMap[word];
        if (info) return this.keywordHover(info.title, info.body, wordRange);
      }

      // Top-level keyword
      const kwInfo = KEYWORD_HOVER[word];
      if (kwInfo) return this.keywordHover(kwInfo.title, kwInfo.body, wordRange);
    }

    // ── table hover (existing) ──────────────────────────────────────────────
    if (!wordRange) return;
    const table = this.resolveTable(doc.getText(wordRange));
    if (!table) return;
    return new vscode.Hover(this.tableMarkdown(table), wordRange);
  }

  private keywordHover(title: string, body: string, range: vscode.Range): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${title}**\n\n${body}`);
    md.isTrusted = true;
    return new vscode.Hover(md, range);
  }

  private tableMarkdown(table: Table): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Table** \`${table.name}\``);
    if (table.note) md.appendMarkdown(`\n\n*${table.note}*`);
    md.appendMarkdown('\n\n| Column | Type | Constraints |\n|--------|------|-------------|\n');
    for (const col of table.columns) {
      const change = table.columnChanges?.[col.name];
      const diffBadge = change
        ? change.kind === 'add' ? ' `+add`'
        : change.kind === 'drop' ? ' `~drop`'
        : ` \`~modify\``
        : '';
      const constraints = [
        col.pk ? 'PK' : '',
        col.notNull ? 'NOT NULL' : '',
        col.unique ? 'UNIQUE' : '',
        col.increment ? 'AUTOINCREMENT' : '',
        change?.kind === 'modify' && change.fromName ? `was \`${change.fromName}\`` : '',
        change?.kind === 'modify' && change.fromType ? `was \`${change.fromType}\`` : '',
        change?.kind === 'modify' && change.fromPk !== undefined ? (change.fromPk ? 'was pk' : 'pk added') : '',
        change?.kind === 'modify' && change.fromNotNull !== undefined ? (change.fromNotNull ? 'was not null' : 'not null added') : '',
        change?.kind === 'modify' && change.fromUnique !== undefined ? (change.fromUnique ? 'was unique' : 'unique added') : '',
        change?.kind === 'modify' && change.fromDefault !== undefined ? `default was \`${change.fromDefault}\`` : '',
        change?.kind === 'modify' && change.fromIncrement !== undefined ? (change.fromIncrement ? 'was autoincrement' : 'autoincrement added') : '',
      ].filter(Boolean).join(', ');
      md.appendMarkdown(`| \`${col.name}\`${diffBadge} | \`${col.type}\` | ${constraints} |\n`);
    }
    return md;
  }

  private resolveTable(word: string): Table | undefined {
    const w = word.replace(/"/g, '');
    const candidates: string[] = [w];
    if (w.includes('.')) {
      const parts = w.split('.');
      candidates.push(parts.slice(0, -1).join('.'));
      candidates.push(parts[0]!);
    }
    for (const c of candidates) {
      const t = this.index.getTable(c) ?? this.index.getTable(`public.${c}`);
      if (t) return t;
    }
    return undefined;
  }

  // Thin wrapper reused from completion provider
  private getContext(doc: vscode.TextDocument, pos: vscode.Position): BlockContext {
    return getContext(doc, pos);
  }
}

// ── Document Symbols ───────────────────────────────────────────────────────

class DbmlxDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    return this.index.getTablesInFile(doc.uri).map(({ name, line }) => {
      const table = this.index.getTable(name);
      const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
      const sym = new vscode.DocumentSymbol(
        name,
        table ? `${table.columns.length} columns` : '',
        vscode.SymbolKind.Class,
        range,
        range,
      );
      if (table) {
        sym.children = table.columns.map((col) => {
          const colSym = new vscode.DocumentSymbol(
            col.name,
            col.type,
            col.pk ? vscode.SymbolKind.Key : vscode.SymbolKind.Field,
            range,
            range,
          );
          return colSym;
        });
      }
      return sym;
    });
  }
}

// ── Go-to-Definition ───────────────────────────────────────────────────────

class DbmlxDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
    // !include "file.dbmlx" → open the file
    const incMatch = INCLUDE_LINE_RE.exec(doc.lineAt(pos).text);
    if (incMatch) {
      const targetUri = vscode.Uri.joinPath(doc.uri, '..', incMatch[1]!);
      return new vscode.Location(targetUri, new vscode.Position(0, 0));
    }

    const wordRange = doc.getWordRangeAtPosition(pos, /(?:"[^"]+"|[\w.])+/);
    if (!wordRange) return;
    const word = doc.getText(wordRange).replace(/"/g, '');

    // "table.column" → jump to column definition line
    if (word.includes('.')) {
      const lastDot = word.lastIndexOf('.');
      const tablePart = word.substring(0, lastDot);
      const colPart = word.substring(lastDot + 1);
      const tableQn = this.index.getTableLocation(tablePart)
        ? tablePart as QualifiedName
        : this.index.getTableLocation(`public.${tablePart}`)
          ? `public.${tablePart}` as QualifiedName
          : undefined;
      if (tableQn && colPart) {
        const colLoc = this.index.getColumnLocation(tableQn, colPart);
        if (colLoc) return new vscode.Location(colLoc.uri, new vscode.Position(colLoc.line, 0));
      }
      // Fall back to table jump
      const tableLoc = (tableQn && this.index.getTableLocation(tableQn))
        ?? this.index.getTableLocation(tablePart as QualifiedName)
        ?? this.index.getTableLocation(`public.${tablePart}` as QualifiedName);
      if (tableLoc) return new vscode.Location(tableLoc.uri, new vscode.Position(tableLoc.line, 0));
    }

    const loc = this.index.getTableLocation(word as QualifiedName)
      ?? this.index.getTableLocation(`public.${word}` as QualifiedName);
    if (loc) return new vscode.Location(loc.uri, new vscode.Position(loc.line, 0));
    return undefined;
  }
}

// ── Completion data ────────────────────────────────────────────────────────

type BlockKind = 'table' | 'ref' | 'tablegroup' | 'enum' | 'project' | 'indexes' | 'diagramview' | 'diagramview-tables' | 'diagramview-tablegroups' | 'diagramview-schemas' | 'none';

interface BlockContext {
  block: BlockKind;
  parentTable?: string;
}

// Ordered most-common first — drives sortText so the popular types appear at
// the top regardless of alphabetical order.
const SQL_TYPES = [
  'int', 'varchar(255)', 'uuid', 'text', 'boolean', 'timestamp',
  'integer', 'bigint', 'smallint', 'tinyint',
  'varchar(100)', 'varchar(50)', 'char(1)',
  'longtext', 'mediumtext',
  'bool',
  'float', 'double', 'real', 'decimal(10,2)', 'numeric(10,2)',
  'date', 'datetime', 'timestamptz', 'time',
  'json', 'jsonb',
  'blob', 'bytea', 'binary',
  'serial', 'bigserial',
];

const COLUMN_SETTINGS: Array<{ label: string; doc: string; kind?: vscode.CompletionItemKind; snippet?: string }> = [
  { label: 'pk', doc: 'Primary key — uniquely identifies each row.' },
  { label: 'primary key', doc: 'Primary key (verbose form).' },
  { label: 'not null', doc: 'Column cannot contain NULL values.' },
  { label: 'null', doc: 'Column allows NULL values.' },
  { label: 'unique', doc: 'All values must be unique across rows.' },
  { label: 'increment', doc: 'Auto-increment (serial).' },
  { label: 'default: ', doc: 'Default value on INSERT.', kind: vscode.CompletionItemKind.Property },
  { label: 'note: ', doc: 'Column note/comment.', kind: vscode.CompletionItemKind.Property },
  { label: 'ref: ', doc: 'Inline foreign-key reference.', kind: vscode.CompletionItemKind.Reference },
  { label: 'add', doc: 'Migration diff — column is being added in this migration.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'drop', doc: 'Migration diff — column is being dropped in this migration.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'modify: ', doc: 'Migration diff — column is being modified. Use name="old", type="old", default="old" for value changes; pk=true/false, not_null=true/false, unique=true/false, increment=true/false to record constraint changes.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'before: ', doc: 'Migration diff — same as `modify:`, but explicit: records the old (before-migration) values. Use name="old", type="old", default="old" for value changes; pk=true/false, not_null=true/false, unique=true/false, increment=true/false to record constraint changes.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'add ref: ', doc: 'Migration diff — this inline FK is being added in this migration.\n\n```dbmlx\nuser_id int [add ref: > users.id]\n```', kind: vscode.CompletionItemKind.Reference, snippet: 'add ref: ' },
  { label: 'drop ref: ', doc: 'Migration diff — this inline FK is being dropped in this migration.\n\n```dbmlx\nold_id int [drop ref: > legacy.id]\n```', kind: vscode.CompletionItemKind.Reference, snippet: 'drop ref: ' },
];

const INDEX_SETTINGS: Array<{ label: string; doc: string; kind?: vscode.CompletionItemKind }> = [
  { label: 'unique', doc: 'Unique index — no duplicate values.' },
  { label: 'pk', doc: 'Primary key index.' },
  { label: 'name: ', doc: 'Explicit index name.', kind: vscode.CompletionItemKind.Property },
  { label: 'type: btree',  doc: 'B-tree index (default). Supports range queries and sorting.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'type: hash',   doc: 'Hash index. Optimised for equality lookups only.',            kind: vscode.CompletionItemKind.EnumMember },
  { label: 'type: gin',    doc: 'GIN index. Arrays, JSONB, full-text search.',                 kind: vscode.CompletionItemKind.EnumMember },
  { label: 'type: gist',   doc: 'GiST index. Geometric types, full-text, nearest-neighbor.',  kind: vscode.CompletionItemKind.EnumMember },
  { label: 'type: spgist', doc: 'SP-GiST index. Non-balanced structures (IP ranges etc.).',   kind: vscode.CompletionItemKind.EnumMember },
  { label: 'type: brin',   doc: 'BRIN index. Very large tables with natural physical ordering.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'note: ', doc: 'Index note/comment.', kind: vscode.CompletionItemKind.Property },
  { label: 'add',  doc: 'Migration diff — this index is being added in this migration.',   kind: vscode.CompletionItemKind.EnumMember },
  { label: 'drop', doc: 'Migration diff — this index is being dropped in this migration.', kind: vscode.CompletionItemKind.EnumMember },
];

const TOPLEVEL_SNIPPETS: Array<{ label: string; snippet: string; doc: string; command?: string }> = [
  { label: 'Table', snippet: 'Table ${1:name} {\n\t$0\n}', doc: 'Define a database table.' },
  { label: 'Ref', snippet: 'Ref "${1:name}": ', doc: 'Define a relationship. Schema/table/column completions trigger automatically.', command: 'editor.action.triggerSuggest' },
  { label: 'Enum', snippet: 'Enum ${1:name} {\n\t$0\n}', doc: 'Define an enum type.' },
  { label: 'TableGroup', snippet: 'TableGroup ${1:name} {\n\t$0\n}', doc: 'Group tables into a bounded context.' },
  { label: 'Project', snippet: 'Project ${1:name} {\n\tdatabase_type: \'$1\'\n\t$0\n}', doc: 'Project-level metadata.' },
  { label: 'DiagramView', snippet: 'DiagramView ${1:name} {\n\tTables { * }\n}', doc: 'Define a named filterable view of the diagram.' },
];

const TABLE_HEADER_SETTINGS: Array<{ label: string; doc: string; kind?: vscode.CompletionItemKind; snippet?: string }> = [
  { label: 'add',  doc: 'Migration diff — this entire table is being created in this migration. Renders with a green border and +NEW badge.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'drop', doc: 'Migration diff — this entire table is being dropped in this migration. Renders with a red border, dimmed columns, and DROP badge.', kind: vscode.CompletionItemKind.EnumMember },
  { label: 'modify: ', doc: 'Migration diff — table is being renamed. Write the NEW name on the Table line, record the old name with name="old_name". Renders with an amber border and a before→after name diff in the header.', kind: vscode.CompletionItemKind.EnumMember, snippet: 'modify: name="${1:old_name}"' },
  { label: 'before: ', doc: 'Migration diff — same as `modify:`, but explicit: records the old table name. Write the NEW name on the Table line, record the old name with name="old_name". Renders with an amber border and a before→after name diff in the header.', kind: vscode.CompletionItemKind.EnumMember, snippet: 'before: name="${1:old_name}"' },
  { label: 'headercolor: ', doc: 'Custom header color for this table in the diagram.', kind: vscode.CompletionItemKind.Property },
];

const MODIFY_KEYS: Array<{ label: string; doc: string; snippet: string }> = [
  { label: 'name=',      doc: 'Column name before migration',           snippet: 'name="${1:old_name}"' },
  { label: 'type=',      doc: 'Column type before migration',           snippet: 'type="${1:old_type}"' },
  { label: 'default=',   doc: 'Default value before migration',         snippet: 'default="${1:value}"' },
  { label: 'pk=',        doc: 'PK status before migration',             snippet: 'pk=${1|true,false|}' },
  { label: 'not_null=',  doc: 'NOT NULL status before migration',       snippet: 'not_null=${1|true,false|}' },
  { label: 'unique=',    doc: 'UNIQUE status before migration',         snippet: 'unique=${1|true,false|}' },
  { label: 'increment=', doc: 'Auto-increment status before migration', snippet: 'increment=${1|true,false|}' },
];

const PROJECT_PROPS: Array<{ label: string; doc: string; snippet?: string }> = [
  { label: 'database_type: ', doc: "Database dialect, e.g. `'PostgreSQL'`, `'MySQL'`, `'MSSQL'`.", snippet: "database_type: '${1:PostgreSQL}'" },
  { label: 'Note: ', doc: 'Project description.', snippet: "Note: '${1:description}'" },
];

const REF_OPERATORS: Array<{ label: string; doc: string }> = [
  { label: '>', doc: 'Many-to-one — current → referenced' },
  { label: '<', doc: 'One-to-many — current ← referenced' },
  { label: '<>', doc: 'Many-to-many' },
  { label: '-', doc: 'One-to-one' },
];

// ── Block context helper (shared by hover + completion) ────────────────────

export function getContext(doc: vscode.TextDocument, pos: vscode.Position): BlockContext {
  let depth = 0;
  let firstKind: BlockKind = 'none';
  let firstFound = false;

  for (let i = pos.line; i >= 0; i--) {
    const raw =
      i === pos.line ? doc.lineAt(i).text.substring(0, pos.character) : doc.lineAt(i).text;
    // Strip strings and line comments before counting braces
    const text = raw.replace(/"[^"]*"|'[^']*'|\/\/.*$/g, '');

    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '}') {
        depth++;
      } else if (text[j] === '{') {
        if (depth > 0) {
          depth--;
        } else {
          // depth === 0: this is an enclosing block opening
          const blockLine = doc.lineAt(i).text.trim().toLowerCase();
          const kind = classifyBlockLine(blockLine);

          if (!firstFound) {
            firstFound = true;
            if (kind !== 'indexes' && !isDiagramViewSection(kind)) {
              const parentTable = extractTableName(doc.lineAt(i).text);
              return { block: kind, parentTable };
            }
            // indexes and diagramview-* blocks: continue scanning for the parent block
            firstKind = kind;
          } else {
            const parentTable = extractTableName(doc.lineAt(i).text);
            return { block: firstKind, parentTable };
          }
        }
      }
    }
  }
  return { block: 'none' };
}

function classifyBlockLine(trimmedLower: string): BlockKind {
  if (/^table\b/.test(trimmedLower)) return 'table';
  if (/^ref\b/.test(trimmedLower)) return 'ref';
  if (/^tablegroup\b/.test(trimmedLower)) return 'tablegroup';
  if (/^enum\b/.test(trimmedLower)) return 'enum';
  if (/^project\b/.test(trimmedLower)) return 'project';
  if (/^indexes\b/.test(trimmedLower)) return 'indexes';
  if (/^diagramview\b/.test(trimmedLower)) return 'diagramview';
  if (/^tables\s*\{/.test(trimmedLower)) return 'diagramview-tables';
  if (/^tablegroups\s*\{/.test(trimmedLower)) return 'diagramview-tablegroups';
  if (/^schemas\s*\{/.test(trimmedLower)) return 'diagramview-schemas';
  return 'none';
}

function isDiagramViewSection(k: BlockKind): k is 'diagramview-tables' | 'diagramview-tablegroups' | 'diagramview-schemas' {
  return k === 'diagramview-tables' || k === 'diagramview-tablegroups' || k === 'diagramview-schemas';
}

function getUsedDiagramViewSections(doc: vscode.TextDocument, pos: vscode.Position): Set<string> {
  const used = new Set<string>();
  let depth = 0;
  let blockStartLine = -1;
  for (let i = pos.line; i >= 0; i--) {
    const raw = i === pos.line ? doc.lineAt(i).text.substring(0, pos.character) : doc.lineAt(i).text;
    const text = raw.replace(/"[^"]*"|'[^']*'|\/\/.*$/g, '');
    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '}') { depth++; }
      else if (text[j] === '{') {
        if (depth > 0) { depth--; }
        else {
          if (/^\s*diagramview\b/i.test(doc.lineAt(i).text)) blockStartLine = i;
          break;
        }
      }
    }
    if (blockStartLine >= 0) break;
  }
  if (blockStartLine < 0) return used;
  for (let i = blockStartLine + 1; i < pos.line; i++) {
    const t = doc.lineAt(i).text.trim().toLowerCase();
    if (/^tables\s*\{/.test(t)) used.add('Tables');
    if (/^tablegroups\s*\{/.test(t)) used.add('TableGroups');
    if (/^schemas\s*\{/.test(t)) used.add('Schemas');
  }
  return used;
}

function extractTableName(lineText: string): string | undefined {
  const m = /^table\s+([\w."]+)/i.exec(lineText.trim());
  return m ? m[1]!.replace(/"/g, '') : undefined;
}

// ── Completion ──────────────────────────────────────────────────────────────

class DbmlxCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const lineText = doc.lineAt(pos).text;
    const linePrefix = lineText.substring(0, pos.character);
    const uri = doc.uri;

    // 0a. Inside !include "..." → suggest .dbmlx file paths
    if (INCLUDE_PREFIX_RE.test(linePrefix)) {
      return this.includePathItems(doc);
    }

    // 0b. `!` or `!i` at start of line → offer !include snippet
    if (/^!i?\w*$/.test(linePrefix)) {
      const item = new vscode.CompletionItem('!include', vscode.CompletionItemKind.Module);
      item.insertText = new vscode.SnippetString('!include "$0"');
      item.documentation = 'Include another dbmlx file into this schema.';
      item.sortText = '0_include';
      item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest files' };
      // Replace the `!` already typed so we don't produce `!!include`
      item.range = new vscode.Range(pos.line, linePrefix.indexOf('!'), pos.line, pos.character);
      return [item];
    }

    // B13/B14: no completions inside `//` comments, single-quoted strings, or
    // backtick expressions. (Double-quoted identifiers DO get completions.)
    if (isInsideStringOrComment(linePrefix)) return [];

    // B2/B3 (header name position): when the cursor is between `Table` and the
    // first `[` or `{`, the user is *naming a new table* — suggesting existing
    // names is wrong (and confusing, since reusing a name is invalid).
    // Annotations come *after* the name and are handled by the `[…]` path below.
    const tableHeaderName = /^\s*[Tt]able\s+(?:[^[{]*?)$/.test(linePrefix);
    if (tableHeaderName) return [];

    // Same for DiagramView header name position (`DiagramView name` before `{`).
    if (/^\s*[Dd]iagram[Vv]iew\s+[^{]*$/.test(linePrefix)) return [];
    // Same for Enum, TableGroup, Project — naming a new block, not referencing one.
    if (/^\s*[Ee]num\s+[^{]*$/.test(linePrefix)) return [];
    if (/^\s*[Tt]able[Gg]roup\s+[^{]*$/.test(linePrefix)) return [];
    if (/^\s*[Pp]roject\s+[^{]*$/.test(linePrefix)) return [];

    // A1/A4: when the cursor sits inside an unclosed `"…` token (whether VS Code
    // auto-closed the quote or not), replacement must cover the full quote token
    // so accepting `"public".` doesn't produce `""public".` or `""public"".`.
    const quoteRange = computeQuoteReplaceRange(lineText, pos.character);
    const quoteRangeDot = computeQuoteReplaceRangeDot(lineText, pos.character);
    const replaceRange: vscode.Range | undefined = quoteRange
      ? new vscode.Range(pos.line, quoteRange.startCol, pos.line, quoteRange.endCol)
      : undefined;
    const replaceRangeDot: vscode.Range | undefined = quoteRangeDot
      ? new vscode.Range(pos.line, quoteRangeDot.startCol, pos.line, quoteRangeDot.endCol)
      : undefined;

    // Strip whatever lies between the unclosed `"` and the cursor before running
    // dotMatch — so `"public"."pu` (cursor in second quote) still resolves to
    // table completions inside `public`.
    const dotCheckPrefix = quoteRange ? linePrefix.substring(0, quoteRange.startCol) : linePrefix;

    // 1. After `"schema".` or `"schema"."table".` → table names or column names
    const dotMatch = /(?:(?:"([^"]+)"|(\w+))\.)?(?:"([^"]+)"|(\w+))\.$/.exec(dotCheckPrefix);
    if (dotMatch) {
      const schema = dotMatch[1] ?? dotMatch[2];
      const tbl = dotMatch[3] ?? dotMatch[4]!;
      const table = (schema ? this.index.getTable(`${schema}.${tbl}`) : undefined)
        ?? this.index.getTable(tbl)
        ?? this.index.getTable(`public.${tbl}`);
      // An operator in linePrefix means we're completing the right-hand side of a Ref
      const isRightSide = /(?:<>|[<>-])/.test(linePrefix);
      if (table) {
        // Two-segment match resolved to a real table → suggest its columns
        return table.columns.map((col, i) => {
          const item = new vscode.CompletionItem(`"${col.name}"`, vscode.CompletionItemKind.Field);
          item.filterText = col.name; // E5: user can type col name without quotes
          item.detail = col.type;
          item.documentation = [
            col.pk ? 'PRIMARY KEY' : '',
            col.notNull ? 'NOT NULL' : '',
            col.unique ? 'UNIQUE' : '',
          ]
            .filter(Boolean)
            .join(', ');
          if (replaceRange) item.range = replaceRange;
          // D1/D2: PK first, declaration order otherwise. Preselect the PK.
          if (col.pk) item.preselect = true;
          item.sortText = (col.pk ? '0_' : '1_') + String(i).padStart(4, '0');
          // Left-side column: auto-show operators. Right-side: ref is complete, no more popup.
          if (!isRightSide) {
            item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest operators' };
          }
          return item;
        });
      }

      // No table found — the identifier before `.` may be a schema name.
      // Return all tables in that schema as `"tableName"` completions.
      const schemaPrefix = `${tbl}.`;
      const schemaTableItems: vscode.CompletionItem[] = [];
      for (const qn of this.index.getVisibleTableNames(uri)) {
        if (!qn.startsWith(schemaPrefix)) continue;
        const tableName = qn.substring(schemaPrefix.length);
        const t = this.index.getTable(qn);
        const item = new vscode.CompletionItem(`"${tableName}"`, vscode.CompletionItemKind.Class);
        item.filterText = tableName; // E5: user can type table name without quotes
        if (t) item.detail = `${t.columns.length} columns`;
        item.sortText = tableName;
        // replaceRangeDot covers `""` + the following `.` to avoid double-dot when editing in-place
        if (replaceRangeDot) item.range = replaceRangeDot;
        item.insertText = `"${tableName}".`;
        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest columns' };
        schemaTableItems.push(item);
      }
      if (schemaTableItems.length > 0) return schemaTableItems;
    }

    // 1b. After `"table".(` or inside composite FK tuple `"table".("col", ` → column names
    const tupleMatch = /(?:(?:"([^"]+)"|(\w+))\.)?(?:"([^"]+)"|(\w+))\.\(([^)]*)$/.exec(linePrefix);
    if (tupleMatch) {
      const schema = tupleMatch[1] ?? tupleMatch[2];
      const tbl = tupleMatch[3] ?? tupleMatch[4]!;
      const tupleSoFar = tupleMatch[5] ?? '';
      const table = (schema ? this.index.getTable(`${schema}.${tbl}`) : undefined)
        ?? this.index.getTable(tbl)
        ?? this.index.getTable(`public.${tbl}`);
      if (table) {
        // D4: dedupe columns already mentioned earlier in the tuple
        const used = new Set<string>();
        for (const m of tupleSoFar.matchAll(/(?:"([^"]+)"|(\w+))/g)) {
          used.add(m[1] ?? m[2]!);
        }
        const trimmedTuple = tupleSoFar.trim();
        const tupleHasContent = trimmedTuple.length > 0;
        const tupleEndsWithComma = /,\s*$/.test(trimmedTuple);
        // C3: when tuple has a complete token and no trailing comma, offer `)` to close
        const closeItem = (tupleHasContent && !tupleEndsWithComma)
          ? (() => {
              const it = new vscode.CompletionItem(')', vscode.CompletionItemKind.Operator);
              it.documentation = 'Close the composite FK column tuple.';
              it.sortText = '0_close';
              return it;
            })()
          : null;
        const colItems = table.columns
          .filter((c) => !used.has(c.name))
          .map((col, i) => {
            const item = new vscode.CompletionItem(`"${col.name}"`, vscode.CompletionItemKind.Field);
            item.filterText = col.name;
            item.detail = col.type;
            item.sortText = (col.pk ? '1_' : '2_') + String(i).padStart(4, '0');
            return item;
          });
        return closeItem ? [closeItem, ...colItems] : colItems;
      }
    }

    const { block, parentTable } = getContext(doc, pos);

    // 2. Inside `[...]`
    if (/\[[^\]]*$/.test(linePrefix)) {
      // After `type:` inside an index settings bracket → index type values
      if (block === 'indexes' && /\btype\s*:\s*\w*$/.test(linePrefix)) {
        return [
          this.makeItem('btree',  'B-tree (default) — range queries, sorting',          vscode.CompletionItemKind.EnumMember),
          this.makeItem('hash',   'Hash — equality lookups only',                        vscode.CompletionItemKind.EnumMember),
          this.makeItem('gin',    'GIN — arrays, JSONB, full-text search',               vscode.CompletionItemKind.EnumMember),
          this.makeItem('gist',   'GiST — geometric types, full-text, nearest-neighbor', vscode.CompletionItemKind.EnumMember),
          this.makeItem('spgist', 'SP-GiST — non-balanced structures (IP ranges, etc.)', vscode.CompletionItemKind.EnumMember),
          this.makeItem('brin',   'BRIN — large tables with natural physical ordering',  vscode.CompletionItemKind.EnumMember),
        ];
      }

      // Content of the current bracket pair (after the last `[`)
      const bracketContent = linePrefix.split('[').pop()!;
      const bracketState = classifyBracket(bracketContent);

      if (bracketState.kind === 'modify-keys') {
        return MODIFY_KEYS.map(({ label, doc, snippet }, i) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
          item.documentation = doc;
          item.insertText = new vscode.SnippetString(snippet);
          item.sortText = String(i).padStart(2, '0');
          return item;
        });
      }

      if (bracketState.kind === 'ref-table-column') {
        // Schema-filter when bracketContent includes a target schema like
        // `> public.` — but the dotMatch path above already handled that case.
        return this.tableColumnItems(uri, replaceRange);
      }

      if (bracketState.kind === 'ref-operator') {
        return this.operatorItems();
      }

      // 'settings' — column / index / table-header settings
      const isTableHeaderLine = /^\s*[Tt]able\b/.test(lineText);
      const settings = block === 'indexes' ? INDEX_SETTINGS
        : isTableHeaderLine ? TABLE_HEADER_SETTINGS
        : COLUMN_SETTINGS;
      return settings.map((s, i) => {
        const item = new vscode.CompletionItem(s.label, s.kind ?? vscode.CompletionItemKind.Keyword);
        item.documentation = s.doc;
        const snip = (s as { snippet?: string }).snippet;
        if (snip) item.insertText = new vscode.SnippetString(snip);
        // sortText preserves the curated order (most useful first)
        item.sortText = String(i).padStart(2, '0');
        // Auto-trigger follow-up suggestions for keywords that take arguments
        if (s.label === 'modify: ' || s.label === 'before: ') item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest modify keys' };
        if (s.label === 'ref: ' || s.label === 'add ref: ' || s.label === 'drop ref: ') item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest operators' };
        return item;
      });
    }

    // 3. Inside indexes block
    if (block === 'indexes') {
      const table = parentTable
        ? (this.index.getTable(parentTable) ?? this.index.getTable(`public.${parentTable}`))
        : undefined;
      // D4: filter out columns already mentioned earlier on this line
      // (e.g. inside a composite tuple `(domain_id, |)`).
      const used = new Set(usedColumnsOnLine(linePrefix));
      return (table?.columns ?? [])
        .filter((col) => !used.has(col.name))
        .map((col) => {
          const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
          item.detail = col.type;
          const tags: string[] = [];
          if (col.pk) tags.push('PK');
          if (col.notNull) tags.push('NOT NULL');
          if (col.unique) tags.push('UNIQUE');
          item.documentation = tags.length ? `Index this column (${tags.join(', ')})` : 'Index this column';
          // D1: preselect the PK column when present
          if (col.pk) item.preselect = true;
          // D2: PK first, then in declaration order
          item.sortText = (col.pk ? '0_' : '1_') + col.name;
          return item;
        });
    }

    // 4. Inside Table block at type position: `  colName <cursor>`
    if (block === 'table' && /^\s+(?:"[^"]+"|[\w]+)\s+\w*$/.test(linePrefix)) {
      const sqlItems = SQL_TYPES.map((t, i) => {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
        item.sortText = `1_${String(i).padStart(4, '0')}`;
        return item;
      });
      const enumItems = this.index.getEnumNames(uri).map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Enum);
        item.documentation = 'Enum type defined in this schema.';
        item.sortText = `0_${name}`;
        return item;
      });
      return [...enumItems, ...sqlItems];
    }

    // 5. Inside Table block at start of line → also offer `indexes` and `Note`
    if (block === 'table' && /^\s*\w*$/.test(linePrefix)) {
      return [
        ...['indexes', 'Note'].map((kw) => {
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
          if (kw === 'indexes') item.insertText = new vscode.SnippetString('indexes {\n\t$0\n}');
          if (kw === 'Note') item.insertText = new vscode.SnippetString("Note: '$0'");
          return item;
        }),
      ];
    }

    // 6. Inside Ref block or top-level `Ref [name]:` line → table.column + operators
    if (block === 'ref' || isRefLineExpr(linePrefix)) {
      return this.refCompletions(linePrefix, uri, replaceRange, replaceRangeDot);
    }

    // 6b. Inside Enum block → no completions (user is defining enum values)
    if (block === 'enum') return [];

    // 6c. Inside Project block → known project-level properties
    if (block === 'project' && /^\s*\w*$/.test(linePrefix)) {
      return PROJECT_PROPS.map(({ label, doc: d, snippet }) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
        item.documentation = d;
        if (snippet) item.insertText = new vscode.SnippetString(snippet);
        return item;
      });
    }
    if (block === 'project') return [];

    // 7. Inside TableGroup → table names
    if (block === 'tablegroup') {
      return this.tableNameItems(uri);
    }

    // 7b. Inside DiagramView block → sub-section snippets, deduped against already-written ones
    if (block === 'diagramview') {
      if (/^\s*\w*$/.test(linePrefix)) {
        const used = getUsedDiagramViewSections(doc, pos);
        const all = [
          this.makeSnippetItem('Tables', 'Tables {\n\t$0\n}', 'Filter by table names. Use * for all.'),
          this.makeSnippetItem('TableGroups', 'TableGroups {\n\t$0\n}', 'Filter by table group names. Use * for all.'),
          this.makeSnippetItem('Schemas', 'Schemas {\n\t$0\n}', 'Filter by schema names. Use * for all.'),
        ];
        return all.filter((item) => !used.has(item.label as string));
      }
      return [];
    }

    // 7c. Inside DiagramView Tables { } → table names + wildcard
    if (block === 'diagramview-tables') {
      const wildcard = new vscode.CompletionItem('*', vscode.CompletionItemKind.Value);
      wildcard.documentation = 'Include all tables.';
      return [wildcard, ...this.tableNameItems(uri)];
    }

    // 7d. Inside DiagramView TableGroups { } → group names + wildcard
    if (block === 'diagramview-tablegroups') {
      const wildcard = new vscode.CompletionItem('*', vscode.CompletionItemKind.Value);
      wildcard.documentation = 'Include all table groups.';
      return [wildcard, ...this.index.getGroupNames(uri).map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
        item.documentation = 'Table group';
        return item;
      })];
    }

    // 7e. Inside DiagramView Schemas { } → schema names + wildcard
    if (block === 'diagramview-schemas') {
      const wildcard = new vscode.CompletionItem('*', vscode.CompletionItemKind.Value);
      wildcard.documentation = 'Include all schemas.';
      return [wildcard, ...this.index.getSchemaNames(uri).map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
        item.documentation = 'Schema name';
        return item;
      })];
    }

    // 8. Top-level (outside any block): keyword snippets only
    if (block === 'none' && /^\s*\w*$/.test(linePrefix)) {
      return TOPLEVEL_SNIPPETS.map(({ label, snippet, doc: d, command }) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        item.insertText = new vscode.SnippetString(snippet);
        item.documentation = d;
        item.sortText = `0_${label}`;
        if (command) item.command = { command, title: 'Suggest' };
        return item;
      });
    }

    // Typing `Ref [name]` before the colon — suppress completions
    if (/^\s*[Rr]ef\b/.test(linePrefix) && !linePrefix.includes(':')) {
      return [];
    }

    return [];
  }

  private async includePathItems(doc: vscode.TextDocument): Promise<vscode.CompletionItem[]> {
    const currentDir = nodePath.dirname(doc.uri.fsPath);
    const allFiles = await vscode.workspace.findFiles('**/*.dbmlx', '**/node_modules/**');
    return allFiles
      .filter(u => u.fsPath !== doc.uri.fsPath)
      .map(u => {
        const rel = nodePath.relative(currentDir, u.fsPath).replace(/\\/g, '/');
        const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
        item.insertText = rel;
        item.detail = vscode.workspace.asRelativePath(u);
        return item;
      });
  }

  private refCompletions(linePrefix: string, uri: vscode.Uri, replaceRange?: vscode.Range, replaceRangeDot?: vscode.Range): vscode.CompletionItem[] {
    const refPrefix = extractRefPrefix(linePrefix) ?? linePrefix;
    const step = classifyRefStep(refPrefix);
    // C2: at left-empty / right-empty positions, offer schemas AND unqualified
    // table names so the user can pick either style.
    if (!step || step.kind === 'left-empty' || step.kind === 'right-empty') {
      return [
        ...this.schemaItems(uri, replaceRangeDot),
        ...this.unqualifiedTableItems(uri, replaceRange),
      ];
    }
    if (step.kind === 'operator') return this.operatorItems();
    // Fallback: partial identifier — show schemas + unqualified tables (same as left-empty)
    return [...this.schemaItems(uri, replaceRangeDot), ...this.unqualifiedTableItems(uri, replaceRange)];
  }

  /** Unqualified `"tableName"` items for the left/right side of a Ref expression. */
  private unqualifiedTableItems(uri: vscode.Uri, replaceRange?: vscode.Range): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const qn of this.index.getVisibleTableNames(uri)) {
      const dot = qn.indexOf('.');
      const tableName = dot >= 0 ? qn.substring(dot + 1) : qn;
      const t = this.index.getTable(qn);
      const item = new vscode.CompletionItem(`"${tableName}"`, vscode.CompletionItemKind.Class);
      item.filterText = tableName;
      if (t) item.detail = `${t.columns.length} columns · ${t.schemaName}`;
      // Sort after schemas so schemas appear first
      item.sortText = `1_${tableName}`;
      item.insertText = `"${tableName}".`;
      item.commitCharacters = ['.'];
      item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest columns' };
      if (replaceRange) item.range = replaceRange;
      items.push(item);
    }
    return items;
  }

  private schemaItems(uri: vscode.Uri, replaceRange?: vscode.Range): vscode.CompletionItem[] {
    const schemas = this.index.getSchemaNames(uri);
    return schemas.map((schema) => {
      const item = new vscode.CompletionItem(`"${schema}"`, vscode.CompletionItemKind.Module);
      item.filterText = schema; // E5: user can type schema name without quotes
      item.detail = 'schema';
      // Schemas before unqualified tables (which use sortText '1_…')
      item.sortText = `0_${schema}`;
      // D1: preselect 'public' if present (most common case)
      if (schema === 'public') item.preselect = true;
      // Insert with trailing `.` so dotMatch fires for table completions
      item.insertText = `"${schema}".`;
      item.commitCharacters = ['.'];
      item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest tables' };
      if (replaceRange) item.range = replaceRange;
      return item;
    });
  }

  private operatorItems(): vscode.CompletionItem[] {
    return REF_OPERATORS.map(({ label, doc: d }) => {
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Operator);
      item.documentation = d;
      item.insertText = `${label} `;
      // After picking an operator, auto-show schemas for the right-hand side
      item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
      return item;
    });
  }

  private tableColumnItems(uri: vscode.Uri, replaceRange?: vscode.Range): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    for (const name of this.index.getVisibleTableNames(uri)) {
      const table = this.index.getTable(name);
      if (!table) continue;
      for (const col of table.columns) {
        // Use fully-qualified double-quoted form: "schema"."table"."column"
        const label = `"${table.schemaName}"."${table.tableName}"."${col.name}"`;
        if (seen.has(label)) continue;
        seen.add(label);
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Reference);
        item.filterText = `${table.schemaName}.${table.tableName}.${col.name}`; // E5: match without quotes
        item.detail = col.type;
        item.documentation = [col.pk ? 'PK' : '', col.notNull ? 'NOT NULL' : '', col.unique ? 'UNIQUE' : '']
          .filter(Boolean).join(', ') || undefined;
        // D2: PKs first (the most common FK target by far)
        item.sortText = (col.pk ? '0_' : '1_') + label;
        if (replaceRange) item.range = replaceRange;
        items.push(item);
      }
    }
    return items;
  }

  private tableNameItems(uri: vscode.Uri): vscode.CompletionItem[] {
    return this.index.getVisibleTableNames(uri).map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
      const table = this.index.getTable(name);
      if (table) {
        item.detail = `${table.columns.length} columns`;
        item.documentation = `Table \`${name}\` — ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}.`;
      }
      item.sortText = name;
      return item;
    });
  }

  private makeSnippetItem(label: string, snippet: string, doc: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
    item.insertText = new vscode.SnippetString(snippet);
    item.documentation = doc;
    return item;
  }

  private makeItem(
    label: string,
    doc: string,
    kind: vscode.CompletionItemKind,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, kind);
    item.documentation = doc;
    return item;
  }
}

// ── Ref → Inline Ref Code Action ─────────────────────────────────────────────

const REF_LINE_RE = /^\s*[Rr]ef\b\s*(?:"[^"]*"|\w*)?\s*:\s*([\w."]+)\s*(<>|[<>-])\s*([\w."]+)(?:\s*\[([^\]]*)\])?/;

/** Split a top-level Ref's `[...]` settings into `add`/`drop` annotation and other settings. */
function parseRefBracket(bracketRaw: string | undefined): { kind: 'plain' | 'add' | 'drop'; extra: string[] } {
  if (!bracketRaw) return { kind: 'plain', extra: [] };
  let kind: 'plain' | 'add' | 'drop' = 'plain';
  const extra: string[] = [];
  for (const item of bracketRaw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^add$/i.test(item)) kind = 'add';
    else if (/^drop$/i.test(item)) kind = 'drop';
    else extra.push(item);
  }
  return { kind, extra };
}

/** Parse a dotted qualified endpoint like `"schema"."table"."col"` → { table, col }. */
function parseRefEndpoint(raw: string): { table: string; col: string } | null {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') { inQuote = !inQuote; cur += ch; }
    else if (ch === '.' && !inQuote) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  if (parts.length < 2) return null;
  const col = parts[parts.length - 1]!.replace(/"/g, '');
  const table = parts[parts.length - 2]!.replace(/"/g, '');
  return { table, col };
}

function flipOperator(op: string): string {
  if (op === '<') return '>';
  if (op === '>') return '<';
  return op; // '-' and '<>' stay the same
}

/** Scan the document and return a map of bare table name → line number of its header. */
function buildTableLineMap(doc: vscode.TextDocument): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < doc.lineCount; i++) {
    const m = TABLE_HEADER_RE.exec(doc.lineAt(i).text);
    if (!m) continue;
    const raw = m[1]!.replace(/"/g, '');
    const bare = raw.includes('.') ? raw.split('.').pop()! : raw;
    map.set(bare, i);
  }
  return map;
}

/**
 * Find the line number of a column inside a table block.
 * Returns -1 if not found.
 */
function findColumnLine(doc: vscode.TextDocument, tableHeaderLine: number, colName: string): number {
  let depth = 0;
  let inBlock = false;
  for (let i = tableHeaderLine; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const opens = (text.match(/\{/g) ?? []).length;
    const closes = (text.match(/\}/g) ?? []).length;
    if (!inBlock && opens > 0) inBlock = true;
    depth += opens - closes;
    if (inBlock && depth <= 0) break;
    if (!inBlock) continue;
    // Match column name at start of indented line
    const colRe = /^\s+(?:"([^"]+)"|(\w+))\s/;
    const m = colRe.exec(text);
    const found = m ? (m[1] ?? m[2]) : undefined;
    if (found === colName) return i;
  }
  return -1;
}

class DbmlxRefConvertCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] {
    const line = doc.lineAt(range.start.line);
    if (!/^\s*[Rr]ef\b/.test(line.text)) return [];

    const m = REF_LINE_RE.exec(line.text);
    if (!m) {
      // Composite refs use `.(col1, col2)` tuple syntax — DBML has no inline form for these.
      if (/\.\s*\(/.test(line.text)) {
        const action = new vscode.CodeAction(
          'Convert Ref — inline (not supported for composite refs)',
          vscode.CodeActionKind.RefactorRewrite,
        );
        action.disabled = { reason: 'Composite refs (with `(col1, col2)` tuples) cannot be expressed as inline refs — DBML inline refs only support single columns' };
        return [action];
      }
      return [];
    }

    const [, leftRaw, op, rightRaw, bracketRaw] = m as unknown as [string, string, string, string, string | undefined];
    const left = parseRefEndpoint(leftRaw);
    const right = parseRefEndpoint(rightRaw);
    if (!left || !right) return [];

    const { kind: refKind, extra: extraSettings } = parseRefBracket(bracketRaw);
    const refPrefix = refKind === 'add' ? 'add ' : refKind === 'drop' ? 'drop ' : '';

    const tableLines = buildTableLineMap(doc);
    const actions: vscode.CodeAction[] = [];

    const makeAction = (
      ep: { table: string; col: string },
      targetRaw: string,
      inlineOp: string,
    ): vscode.CodeAction => {
      const kindLabel = refKind !== 'plain' ? ` [${refKind}]` : '';
      const label = `Convert Ref — inline on \`${ep.table}.${ep.col}\`${kindLabel}`;
      const action = new vscode.CodeAction(label, vscode.CodeActionKind.RefactorRewrite);

      const tableHeaderLine = tableLines.get(ep.table);
      if (tableHeaderLine === undefined) {
        action.disabled = { reason: `Table \`${ep.table}\` is not defined in this file — open the file that defines it to convert` };
        return action;
      }

      const colLine = findColumnLine(doc, tableHeaderLine, ep.col);
      if (colLine === -1) {
        action.disabled = { reason: `Column \`${ep.col}\` not found in \`${ep.table}\` block in this file` };
        return action;
      }

      const edit = new vscode.WorkspaceEdit();

      // Add inline ref to the column line, preserving any extra Ref settings (delete: cascade, etc.)
      const colText = doc.lineAt(colLine).text;
      const bracketMatch = /\[([^\]]*)\]/.exec(colText);
      const refClause = `${refPrefix}ref: ${inlineOp} ${targetRaw}`;
      const newClauses = [refClause, ...extraSettings].join(', ');
      let newColText: string;
      if (bracketMatch) {
        const inner = bracketMatch[1]!.trim();
        const replacement = inner ? `[${inner}, ${newClauses}]` : `[${newClauses}]`;
        newColText = colText.slice(0, bracketMatch.index) + replacement + colText.slice(bracketMatch.index + bracketMatch[0].length);
      } else {
        newColText = colText.trimEnd() + ` [${newClauses}]`;
      }
      edit.replace(doc.uri, doc.lineAt(colLine).range, newColText);

      // Delete the Ref line (include its newline)
      const refLineStart = new vscode.Position(line.lineNumber, 0);
      const refLineEnd = line.lineNumber + 1 < doc.lineCount
        ? new vscode.Position(line.lineNumber + 1, 0)
        : new vscode.Position(line.lineNumber, line.text.length);
      edit.delete(doc.uri, new vscode.Range(refLineStart, refLineEnd));

      action.edit = edit;
      return action;
    };

    const leftAction = makeAction(left, rightRaw, op);
    const rightAction = makeAction(right, leftRaw, flipOperator(op));

    // Order by FK-convention: the "many" side (where the FK column lives) goes first.
    //   `<` → right is many → right first
    //   `>` → left is many → left first
    //   `-` / `<>` → ambiguous → left first by default
    if (op === '<') return [rightAction, leftAction];
    return [leftAction, rightAction];
  }
}

// ── Inline Ref → Top-level Ref Code Action ───────────────────────────────────

interface ParsedInlineRef {
  kind: 'plain' | 'add' | 'drop';
  op: string;
  target: string; // raw as written in file
}

/** Extract all inline ref items from a column bracket. */
function parseColumnInlineRefs(colText: string): ParsedInlineRef[] {
  const bracketMatch = /\[([^\]]*)\]/.exec(colText);
  if (!bracketMatch) return [];
  const results: ParsedInlineRef[] = [];
  for (const item of bracketMatch[1]!.split(',').map(s => s.trim()).filter(Boolean)) {
    const annotated = /^(add|drop)\s+ref:\s*(<>|[<>-])\s*([\w."]+(?:\.[\w."]+)*)/i.exec(item);
    if (annotated) {
      results.push({ kind: annotated[1]!.toLowerCase() as 'add' | 'drop', op: annotated[2]!, target: annotated[3]! });
      continue;
    }
    const plain = /^ref:\s*(<>|[<>-])\s*([\w."]+(?:\.[\w."]+)*)/i.exec(item);
    if (plain) results.push({ kind: 'plain', op: plain[1]!, target: plain[2]! });
  }
  return results;
}

/** Remove one specific inline ref item from the column line's bracket. Trims leading whitespace if the bracket becomes empty. */
function removeOneInlineRef(colText: string, ref: ParsedInlineRef): string {
  return colText.replace(/(\s*)\[([^\]]*)\]/, (_m, lead: string, inner: string) => {
    const kept = inner.split(',').map(s => s.trim()).filter(Boolean).filter(item => {
      const a = /^(add|drop)\s+ref:\s*(<>|[<>-])\s*([\w."]+(?:\.[\w."]+)*)/i.exec(item);
      if (a) return !(a[1]!.toLowerCase() === ref.kind && a[2] === ref.op && a[3] === ref.target);
      const p = /^ref:\s*(<>|[<>-])\s*([\w."]+(?:\.[\w."]+)*)/i.exec(item);
      if (p) return !(ref.kind === 'plain' && p[1] === ref.op && p[2] === ref.target);
      return true;
    });
    return kept.length > 0 ? `${lead}[${kept.join(', ')}]` : '';
  });
}

/** Scan backward from lineNum to find the enclosing Table header. Returns raw name as written. */
function findEnclosingTable(doc: vscode.TextDocument, lineNum: number): { headerLine: number; rawName: string } | null {
  const re = /^\s*[Tt]able\s+([\w."]+(?:\.[\w."]+)?)/;
  for (let i = lineNum - 1; i >= 0; i--) {
    const m = re.exec(doc.lineAt(i).text);
    if (m) return { headerLine: i, rawName: m[1]! };
  }
  return null;
}

/** Find the line number of the closing `}` of a Table block. */
function findTableBlockEnd(doc: vscode.TextDocument, headerLine: number): number {
  let depth = 0;
  for (let i = headerLine; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    depth += (text.match(/\{/g) ?? []).length;
    depth -= (text.match(/\}/g) ?? []).length;
    if (depth <= 0 && i > headerLine) return i;
  }
  return doc.lineCount - 1;
}

class DbmlxInlineRefLiftCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const line = doc.lineAt(range.start.line);
    const colText = line.text;

    // Only trigger on indented lines (inside a block) that contain a ref: item
    if (!/^\s/.test(colText)) return [];
    if (!/\bref:\s*(?:<>|[<>-])/.test(colText)) return [];

    const inlineRefs = parseColumnInlineRefs(colText);
    if (inlineRefs.length === 0) return [];

    const enclosing = findEnclosingTable(doc, range.start.line);
    if (!enclosing) return [];

    // Extract raw column name (preserving quotes if present)
    const rawColMatch = /^\s+("(?:[^"]+)"|\w+)\s/.exec(colText);
    if (!rawColMatch) return [];
    const rawCol = rawColMatch[1]!;

    const blockEnd = findTableBlockEnd(doc, enclosing.headerLine);
    const actions: vscode.CodeAction[] = [];

    for (const ref of inlineRefs) {
      const source = `${enclosing.rawName}.${rawCol}`;
      // FK-on-right convention: when inline op is `>` (this column is many = FK),
      // flip order + operator so the FK column ends up on the right side of the Ref.
      const flipForFkRight = ref.op === '>';
      const refLeft = flipForFkRight ? ref.target : source;
      const refRight = flipForFkRight ? source : ref.target;
      const refOp = flipForFkRight ? '<' : ref.op;
      const annotation = ref.kind === 'add' ? ' [add]' : ref.kind === 'drop' ? ' [drop]' : '';
      const kindLabel = ref.kind !== 'plain' ? ` [${ref.kind}]` : '';
      const label = `Lift to top-level — Ref: ${refLeft} ${refOp} ${refRight}${kindLabel}`;
      const newRefLine = `Ref: ${refLeft} ${refOp} ${refRight}${annotation}`;

      const action = new vscode.CodeAction(label, vscode.CodeActionKind.RefactorRewrite);
      const edit = new vscode.WorkspaceEdit();

      // Strip the inline ref item from the column line
      const newColText = removeOneInlineRef(colText, ref);
      edit.replace(doc.uri, line.range, newColText);

      // Insert new Ref line right after the table block's closing `}`
      edit.insert(doc.uri, doc.lineAt(blockEnd).range.end, '\n' + newRefLine);

      action.edit = edit;
      actions.push(action);
    }

    return actions;
  }
}

// ── CodeLens ─────────────────────────────────────────────────────────────────

const TABLE_HEADER_RE = /^\s*[Tt]able\s+([\w."]+(?:\.[\w."]+)?)/;

class DbmlxCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const m = TABLE_HEADER_RE.exec(doc.lineAt(i).text);
      if (!m) continue;
      const rawName = m[1]!;
      const range = new vscode.Range(i, 0, i, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: '$(go-to-file) Focus in diagram',
        command: 'dbmlx.focusTableInDiagram',
        arguments: [rawName],
      }));
    }
    return lenses;
  }
}

// ── Registration ───────────────────────────────────────────────────────────

// Exported for unit testing — not part of the public extension API.
export { DbmlxCompletionProvider };

export function registerLspProviders(
  index: WorkspaceIndex,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('dbmlx', new DbmlxHoverProvider(index)),
    vscode.languages.registerDocumentSymbolProvider('dbmlx', new DbmlxDocumentSymbolProvider(index)),
    vscode.languages.registerDefinitionProvider('dbmlx', new DbmlxDefinitionProvider(index)),
    vscode.languages.registerCompletionItemProvider(
      'dbmlx',
      new DbmlxCompletionProvider(index),
      '.', '[', ',', '"', '!', ':', '>', '<', '-',
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      'dbmlx',
      new DbmlxFormattingProvider(),
    ),
    vscode.languages.registerCodeLensProvider('dbmlx', new DbmlxCodeLensProvider()),
    vscode.languages.registerCodeActionsProvider(
      'dbmlx',
      new DbmlxRefConvertCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
    vscode.languages.registerCodeActionsProvider(
      'dbmlx',
      new DbmlxInlineRefLiftCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );
}
