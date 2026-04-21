import * as vscode from 'vscode';
import * as nodePath from 'path';
import type { WorkspaceIndex } from './workspaceIndex';
import type { QualifiedName, Table } from '../shared/types';
import { DbmlxFormattingProvider } from './formatter';

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
    title: 'add — New Column',
    body: 'Marks this column as **added** in the current migration.\n\nThe column will be rendered with a green ➕ accent in the diagram.\n\n```dbmlx\ncreated_at timestamp [add]\nemail varchar(255) [add, not null]\n```',
  },
  drop: {
    title: 'drop — Dropped Column',
    body: 'Marks this column as **dropped** in the current migration.\n\nThe column will be rendered with a red 🗑 strikethrough accent in the diagram.\n\n```dbmlx\nlegacy_id int [drop]\nold_name varchar(100) [drop]\n```',
  },
  modify: {
    title: 'modify — Modified Column',
    body: 'Marks this column as **modified** in the current migration.\n\nWrite the column with its **new** name and type. Use `name=` and/or `type=` to record the **original** values before migration.\n\n```dbmlx\n// renamed + retyped: write the new state first\nuser_login text [modify: name="username", type="varchar(50)"]\n\n// type change only\nemail varchar(255) [modify: type="varchar(100)"]\n```\n\nRefs and indexes reference the new column name. The diagram renders the original (strikethrough) above and the new value below.',
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

const SQL_TYPES = [
  'int', 'integer', 'bigint', 'smallint', 'tinyint',
  'varchar(255)', 'varchar(100)', 'varchar(50)', 'char(1)',
  'text', 'longtext', 'mediumtext',
  'boolean', 'bool',
  'float', 'double', 'real', 'decimal(10,2)', 'numeric(10,2)',
  'date', 'datetime', 'timestamp', 'time',
  'uuid', 'json', 'jsonb',
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
  { label: 'modify: ', doc: 'Migration diff — column is being modified. Use name="old", type="old", default="old" for value changes; pk=true/false, not_null=true/false, unique=true/false, increment=true/false to record constraint changes.', kind: vscode.CompletionItemKind.EnumMember, snippet: 'modify: ${1|name,type,default,pk,not_null,unique,increment|}=${2|"$3",true,false|}' },
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
];

const TOPLEVEL_SNIPPETS: Array<{ label: string; snippet: string; doc: string }> = [
  { label: 'Table', snippet: 'Table ${1:name} {\n\t$0\n}', doc: 'Define a database table.' },
  { label: 'Ref', snippet: 'Ref "${1:name}": "${2:schema}"."${3:table}"."${4:column}" ${5|>,<,<>,-|} "${6:schema}"."${7:table}"."${8:column}"', doc: 'Define a relationship (inline).' },
  { label: 'Enum', snippet: 'Enum ${1:name} {\n\t$0\n}', doc: 'Define an enum type.' },
  { label: 'TableGroup', snippet: 'TableGroup ${1:name} {\n\t$0\n}', doc: 'Group tables into a bounded context.' },
  { label: 'Project', snippet: 'Project ${1:name} {\n\tdatabase_type: \'$1\'\n\t$0\n}', doc: 'Project-level metadata.' },
  { label: 'DiagramView', snippet: 'DiagramView ${1:name} {\n\tTables { * }\n}', doc: 'Define a named filterable view of the diagram.' },
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

const REF_OPERATORS: Array<{ label: string; doc: string }> = [
  { label: '>', doc: 'Many-to-one — current → referenced' },
  { label: '<', doc: 'One-to-many — current ← referenced' },
  { label: '<>', doc: 'Many-to-many' },
  { label: '-', doc: 'One-to-one' },
];

// ── Block context helper (shared by hover + completion) ────────────────────

function getContext(doc: vscode.TextDocument, pos: vscode.Position): BlockContext {
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

    // When the cursor sits between auto-inserted quotes `""` (VS Code closes the
    // quote the user typed), completions must replace the whole `""` pair so
    // inserting `"schema"."table"."col"` doesn't produce `""schema"..."`.
    const c = pos.character;
    const hasCursorBetweenQuotes = c > 0 && lineText[c - 1] === '"' && (lineText[c] ?? '') === '"';
    // replaceRange: covers the `""` pair — used for items whose insertText does NOT end with `.`
    const replaceRange: vscode.Range | undefined = hasCursorBetweenQuotes
      ? new vscode.Range(pos.line, c - 1, pos.line, c + 1)
      : undefined;
    // replaceRangeDot: also swallows the following `.` to avoid double-dot when editing in-place
    const replaceRangeDot: vscode.Range | undefined = hasCursorBetweenQuotes
      ? new vscode.Range(pos.line, c - 1, pos.line, lineText[c + 1] === '.' ? c + 2 : c + 1)
      : undefined;

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

    // When the cursor sits between auto-inserted quotes, strip the trailing `"` before
    // running dotMatch so `"public"."` (cursor between `""`) still resolves to tables.
    const dotCheckPrefix = replaceRange ? linePrefix.slice(0, -1) : linePrefix;

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
        return table.columns.map((col) => {
          const item = new vscode.CompletionItem(`"${col.name}"`, vscode.CompletionItemKind.Field);
          item.detail = col.type;
          item.documentation = [
            col.pk ? 'PRIMARY KEY' : '',
            col.notNull ? 'NOT NULL' : '',
            col.unique ? 'UNIQUE' : '',
          ]
            .filter(Boolean)
            .join(', ');
          if (replaceRange) item.range = replaceRange;
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
        if (t) item.detail = `${t.columns.length} columns`;
        // replaceRangeDot covers `""` + the following `.` to avoid double-dot when editing in-place
        if (replaceRangeDot) item.range = replaceRangeDot;
        item.insertText = `"${tableName}".`;
        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest columns' };
        schemaTableItems.push(item);
      }
      if (schemaTableItems.length > 0) return schemaTableItems;
    }

    // 1b. After `"table".(` or inside composite FK tuple `"table".("col", ` → column names
    const tupleMatch = /(?:(?:"([^"]+)"|(\w+))\.)?(?:"([^"]+)"|(\w+))\.\([^)]*$/.exec(linePrefix);
    if (tupleMatch) {
      const schema = tupleMatch[1] ?? tupleMatch[2];
      const tbl = tupleMatch[3] ?? tupleMatch[4]!;
      const table = (schema ? this.index.getTable(`${schema}.${tbl}`) : undefined)
        ?? this.index.getTable(tbl)
        ?? this.index.getTable(`public.${tbl}`);
      if (table) {
        return table.columns.map((col) => {
          const item = new vscode.CompletionItem(`"${col.name}"`, vscode.CompletionItemKind.Field);
          item.detail = col.type;
          return item;
        });
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

      // Find the last `modify:` and `ref:` keyword positions so the innermost one wins.
      // A line like `[ref: > table.col, modify: n|]` should trigger modify keys, not ref completions.
      let lastModify = -1, lastRef = -1;
      let _m: RegExpExecArray | null;
      const modRe = /\bmodify\s*:/gi;
      const refRe = /\bref\s*:/gi;
      while ((_m = modRe.exec(bracketContent))) lastModify = _m.index;
      while ((_m = refRe.exec(bracketContent))) lastRef = _m.index;

      // Inside [modify: ...] → modify key=value completions (modify: is more recent than ref:)
      if (lastModify >= 0 && lastModify > lastRef) {
        return MODIFY_KEYS.map(({ label, doc, snippet }) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
          item.documentation = doc;
          item.insertText = new vscode.SnippetString(snippet);
          return item;
        });
      }

      // Inside [ref: ...] → direction operator then table.column
      if (lastRef >= 0) {
        if (/(?:<>|[<>-])/.test(bracketContent.slice(lastRef))) {
          return this.tableColumnItems(uri, replaceRange);
        }
        return this.operatorItems();
      }

      const settings = block === 'indexes' ? INDEX_SETTINGS : COLUMN_SETTINGS;
      return settings.map((s) => {
        const item = new vscode.CompletionItem(s.label, s.kind ?? vscode.CompletionItemKind.Keyword);
        item.documentation = s.doc;
        const snip = (s as { snippet?: string }).snippet;
        if (snip) item.insertText = new vscode.SnippetString(snip);
        return item;
      });
    }

    // 3. Inside indexes block
    if (block === 'indexes') {
      const table = parentTable
        ? (this.index.getTable(parentTable) ?? this.index.getTable(`public.${parentTable}`))
        : undefined;
      return [
        // Column names from the parent table
        ...(table?.columns.map((col) => {
          const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
          item.detail = col.type;
          item.documentation = 'Index this column';
          return item;
        }) ?? []),
        // indexes sub-keyword
        ...[
          { label: 'indexes', snippet: 'indexes {\n\t$0\n}', doc: 'Add an indexes block' },
        ].map(({ label, snippet, doc }) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
          item.insertText = new vscode.SnippetString(snippet);
          item.documentation = doc;
          return item;
        }),
      ];
    }

    // 4. Inside Table block at type position: `  colName <cursor>`
    if (block === 'table' && /^\s+(?:"[^"]+"|[\w]+)\s+\w*$/.test(linePrefix)) {
      return SQL_TYPES.map((t, i) => {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
        item.sortText = String(i).padStart(4, '0');
        return item;
      });
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

    // 6. Inside Ref block or inline `Ref [name]:` line → table.column + operators
    // Anchored at start of line; name is optional and may be double-quoted.
    const isRefLine = /^\s*[Rr]ef\b(?:\s+(?:"[^"]+"|[\w]+))?\s*:/.test(linePrefix);
    if (block === 'ref' || isRefLine) {
      return this.refCompletions(linePrefix, uri, replaceRange, replaceRangeDot);
    }

    // 7. Inside TableGroup → table names
    if (block === 'tablegroup') {
      return this.tableNameItems(uri);
    }

    // 7b. Inside DiagramView block → sub-section snippets
    if (block === 'diagramview' && /^\s*\w*$/.test(linePrefix)) {
      return [
        this.makeSnippetItem('Tables', 'Tables {\n\t$0\n}', 'Filter by table names. Use * for all.'),
        this.makeSnippetItem('TableGroups', 'TableGroups {\n\t$0\n}', 'Filter by table group names. Use * for all.'),
        this.makeSnippetItem('Schemas', 'Schemas {\n\t$0\n}', 'Filter by schema names. Use * for all.'),
      ];
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

    // 8. Top-level (outside any block): keyword snippets + table names
    if (block === 'none' && /^\s*\w*$/.test(linePrefix)) {
      return [
        ...TOPLEVEL_SNIPPETS.map(({ label, snippet, doc: d }) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
          item.insertText = new vscode.SnippetString(snippet);
          item.documentation = d;
          item.sortText = `0_${label}`;
          return item;
        }),
        ...this.tableNameItems(uri),
      ];
    }

    // Typing `Ref [name]` before the colon — suppress completions
    if (/^\s*[Rr]ef\b/.test(linePrefix) && !linePrefix.includes(':')) {
      return [];
    }

    return this.tableNameItems(uri);
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
    // Right after an operator (nothing typed yet, or just an opening `"`) → schemas
    if (/(?:<>|[<>-])\s*"?$/.test(linePrefix)) {
      return this.schemaItems(uri, replaceRangeDot);
    }
    // After operator + partial identifier → full table.column list (graceful fallback)
    if (/(?:<>|[<>-])\s*(?:"[^"]*"|[\w.])+$/.test(linePrefix)) {
      return this.tableColumnItems(uri, replaceRange);
    }
    // Has a complete `table.col` ref (no operator yet) → offer operators
    if (/(?:"[^"]+"|[\w]+)\.(?:"[^"]*"|\w+)\s*$/.test(linePrefix) && !/(?:<>|[<>-])/.test(linePrefix)) {
      return this.operatorItems();
    }
    // Fresh start after colon (possibly with opening `"`) → schemas
    return this.schemaItems(uri, replaceRangeDot);
  }

  private schemaItems(uri: vscode.Uri, replaceRange?: vscode.Range): vscode.CompletionItem[] {
    return this.index.getSchemaNames(uri).map((schema) => {
      const item = new vscode.CompletionItem(`"${schema}"`, vscode.CompletionItemKind.Module);
      item.detail = 'schema';
      // Insert with trailing `.` so dotMatch fires for table completions
      item.insertText = `"${schema}".`;
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
        item.detail = col.type;
        item.documentation = [col.pk ? 'PK' : '', col.notNull ? 'NOT NULL' : '', col.unique ? 'UNIQUE' : '']
          .filter(Boolean).join(', ') || undefined;
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
      if (table) item.detail = `${table.columns.length} columns`;
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

// ── Registration ───────────────────────────────────────────────────────────

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
  );
}
