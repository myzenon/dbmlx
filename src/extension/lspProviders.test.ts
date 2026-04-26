/**
 * Unit tests for DbmlxCompletionProvider.
 * vscode is mocked so the tests run in Node without an extension host.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── vscode mock ────────────────────────────────────────────────────────────
vi.mock('vscode', () => {
  const CompletionItemKind = {
    Text: 0, Method: 1, Function: 2, Constructor: 3,
    Field: 4, Variable: 5, Class: 6, Interface: 7,
    Module: 8, Property: 9, Unit: 10, Value: 11,
    Enum: 12, Keyword: 13, Snippet: 14, Color: 15,
    File: 16, Reference: 17, Folder: 18, EnumMember: 19,
    Constant: 20, Struct: 21, Event: 22, Operator: 23,
    TypeParameter: 24,
  };

  class CompletionItem {
    label: string; kind?: number;
    insertText?: { value: string } | string;
    documentation?: string; detail?: string;
    sortText?: string; filterText?: string;
    preselect?: boolean; command?: { command: string; title: string };
    range?: unknown;
    constructor(label: string, kind?: number) {
      this.label = label; this.kind = kind;
    }
  }

  class SnippetString {
    constructor(public value: string) {}
  }

  class Range {
    constructor(
      public startLine: number, public startChar: number,
      public endLine: number, public endChar: number,
    ) {}
  }

  class Position {
    constructor(public line: number, public character: number) {}
  }

  class MarkdownString {
    value = ''; isTrusted = false;
    appendMarkdown(s: string) { this.value += s; return this; }
    appendCodeblock(s: string) { this.value += s; return this; }
  }

  class Hover {
    constructor(public contents: unknown, public range?: unknown) {}
  }

  class Location {
    constructor(public uri: unknown, public position: unknown) {}
  }

  class DocumentSymbol {
    children: unknown[] = [];
    constructor(
      public name: string, public detail: string, public kind: number,
      public range: unknown, public selectionRange: unknown,
    ) {}
  }

  const Uri = {
    file: (p: string) => ({ fsPath: p, path: p, toString: () => `file://${p}`, with: (c: { path: string }) => ({ ...c, fsPath: c.path }) }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = [base.fsPath, ...parts].join('/').replace(/\/\//g, '/');
      return Uri.file(joined);
    },
  };

  const TextEdit = {
    replace: (range: unknown, text: string) => ({ range, newText: text }),
  };

  return {
    CompletionItem, CompletionItemKind, SnippetString, Range, Position,
    MarkdownString, Hover, Location, DocumentSymbol, Uri, TextEdit,
    SymbolKind: { Class: 4, Field: 7, Key: 9 },
    languages: {
      registerHoverProvider: () => ({ dispose: () => {} }),
      registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
      registerDefinitionProvider: () => ({ dispose: () => {} }),
      registerCompletionItemProvider: () => ({ dispose: () => {} }),
      registerDocumentFormattingEditProvider: () => ({ dispose: () => {} }),
    },
    workspace: {
      findFiles: async () => [],
      asRelativePath: (u: { fsPath: string }) => u.fsPath,
      fs: {},
    },
  };
});

import { DbmlxCompletionProvider } from './lspProviders';
import type { Table, Column, QualifiedName } from '../shared/types';

// ── Test helpers ───────────────────────────────────────────────────────────

function col(name: string, type: string, pk?: boolean): Column {
  return { name, type, pk: pk || undefined, notNull: undefined, unique: undefined, increment: undefined, default: null, note: null };
}

function makeTable(schema: string, name: string, columns: Column[]): Table {
  return {
    name: `${schema}.${name}` as QualifiedName,
    schemaName: schema,
    tableName: name,
    columns,
    note: null,
    groupName: null,
    columnChanges: {},
  };
}

function makeIndex(tables: Table[] = []) {
  const byName = new Map<string, Table>(tables.map((t) => [t.name, t]));
  const getTable = (name: string): Table | undefined =>
    byName.get(name) ?? byName.get(`public.${name}`);
  return {
    getTable,
    getVisibleTableNames: (_uri: unknown): QualifiedName[] => [...byName.keys()] as QualifiedName[],
    getSchemaNames: (_uri: unknown): string[] => [...new Set(tables.map((t) => t.schemaName))],
    getGroupNames: (_uri: unknown): string[] => [],
    getTablesInFile: (_uri: unknown): Array<{ name: QualifiedName; line: number }> => [],
    getTableLocation: (_qn: string) => undefined,
    getColumnLocation: (_qn: string, _col: string) => undefined,
  };
}

function makeDoc(lines: string[]) {
  return {
    uri: { fsPath: '/test/schema.dbmlx', toString: () => 'file:///test/schema.dbmlx' },
    lineAt: (posOrLine: number | { line: number }) => {
      const n = typeof posOrLine === 'number' ? posOrLine : posOrLine.line;
      return { text: lines[n] ?? '' };
    },
    getText: () => lines.join('\n'),
    getWordRangeAtPosition: () => undefined,
  };
}

type CItem = { label: string; kind?: number; preselect?: boolean; filterText?: string; sortText?: string; insertText?: unknown; command?: unknown };

function labels(items: CItem[]): string[] {
  return items.map((i) => i.label);
}

function find(items: CItem[], label: string): CItem | undefined {
  return items.find((i) => i.label === label);
}

// ── Tests ──────────────────────────────────────────────────────────────────

let provider: DbmlxCompletionProvider;

beforeEach(() => {
  const tables = [
    makeTable('public', 'users', [col('id', 'int', true), col('name', 'varchar')]),
    makeTable('public', 'orders', [col('id', 'int', true), col('user_id', 'int')]),
    makeTable('billing', 'invoices', [col('id', 'int', true), col('amount', 'decimal')]),
  ];
  provider = new DbmlxCompletionProvider(makeIndex(tables) as never);
});

async function complete(lines: string[], line: number, char: number): Promise<CItem[]> {
  return (await provider.provideCompletionItems(makeDoc(lines) as never, { line, character: char } as never)) as CItem[];
}

// ── B13/B14: comment and string guards ─────────────────────────────────────

describe('B13/B14 — no completions inside comment or string', () => {
  it('returns [] inside // comment', async () => {
    const items = await complete(['  col int [pk // comment'], 0, 24);
    expect(items).toEqual([]);
  });

  it('returns [] inside single-quoted string', async () => {
    const items = await complete(["Note: 'hello wor"], 0, 16);
    expect(items).toEqual([]);
  });

  it('returns [] inside backtick expression', async () => {
    const items = await complete(['default: `now('], 0, 14);
    expect(items).toEqual([]);
  });

  it('does NOT suppress completions inside double-quoted identifier', async () => {
    const items = await complete(['Ref: "pub'], 0, 9);
    expect(items.length).toBeGreaterThan(0);
  });
});

// ── B3: Table header name guard ────────────────────────────────────────────

describe('B3 — no completions when naming a new table', () => {
  it('returns [] for "Table " (just the keyword)', async () => {
    const items = await complete(['Table '], 0, 6);
    expect(items).toEqual([]);
  });

  it('returns [] for "Table use" (partial name)', async () => {
    const items = await complete(['Table use'], 0, 9);
    expect(items).toEqual([]);
  });

  it('returns [] for "Table users" (full name before block opens)', async () => {
    const items = await complete(['Table users'], 0, 11);
    expect(items).toEqual([]);
  });

  it('still offers settings inside the bracket on the same line', async () => {
    // The guard only fires when no [ or { has appeared
    const items = await complete(['Table users ['], 0, 13);
    expect(labels(items)).toContain('add');
  });
});

// ── Top-level keyword snippets ─────────────────────────────────────────────

describe('top-level — keyword snippets (block=none)', () => {
  it('offers Table, Ref, Enum, TableGroup, Project, DiagramView', async () => {
    const items = await complete([''], 0, 0);
    const ls = labels(items);
    expect(ls).toContain('Table');
    expect(ls).toContain('Ref');
    expect(ls).toContain('Enum');
    expect(ls).toContain('TableGroup');
    expect(ls).toContain('Project');
    expect(ls).toContain('DiagramView');
  });

  it('Table item has snippet insertText', async () => {
    const items = await complete([''], 0, 0);
    const tableItem = find(items, 'Table');
    expect((tableItem?.insertText as { value?: string })?.value).toContain('${1:name}');
  });

  it('Ref item triggers follow-up suggestions via command', async () => {
    const items = await complete([''], 0, 0);
    const refItem = find(items, 'Ref');
    expect((refItem?.command as { command?: string })?.command).toBe('editor.action.triggerSuggest');
  });
});

// ── Column settings bracket ────────────────────────────────────────────────

describe('bracket [...] — column settings', () => {
  const tableLines = ['Table users {', '  user_id int [', '}'];

  it('offers pk, not null, unique, null, increment', async () => {
    const items = await complete(tableLines, 1, 15);
    const ls = labels(items);
    expect(ls).toContain('pk');
    expect(ls).toContain('not null');
    expect(ls).toContain('unique');
    expect(ls).toContain('null');
    expect(ls).toContain('increment');
  });

  it('offers default:, note:, ref:', async () => {
    const items = await complete(tableLines, 1, 15);
    const ls = labels(items);
    expect(ls).toContain('default: ');
    expect(ls).toContain('note: ');
    expect(ls).toContain('ref: ');
  });

  it('offers migration diff keywords: add, drop, modify:', async () => {
    const items = await complete(tableLines, 1, 15);
    const ls = labels(items);
    expect(ls).toContain('add');
    expect(ls).toContain('drop');
    expect(ls).toContain('modify: ');
  });

  it('offers add ref: and drop ref: for inline FK migration', async () => {
    const items = await complete(tableLines, 1, 15);
    const ls = labels(items);
    expect(ls).toContain('add ref: ');
    expect(ls).toContain('drop ref: ');
  });

  it('ref: triggers follow-up suggestions', async () => {
    const items = await complete(tableLines, 1, 15);
    const refItem = find(items, 'ref: ');
    expect((refItem?.command as { command?: string })?.command).toBe('editor.action.triggerSuggest');
  });
});

// ── Modify-keys bracket ────────────────────────────────────────────────────

describe('bracket [...] — modify-keys after modify:', () => {
  const tableLines = ['Table users {', '  col text [modify: ', '}'];

  it('offers name=, type=, default=, pk=, not_null=, unique=, increment=', async () => {
    const items = await complete(tableLines, 1, 20);
    const ls = labels(items);
    expect(ls).toContain('name=');
    expect(ls).toContain('type=');
    expect(ls).toContain('default=');
    expect(ls).toContain('pk=');
    expect(ls).toContain('not_null=');
    expect(ls).toContain('unique=');
    expect(ls).toContain('increment=');
  });

  it('name= has a snippet insertText', async () => {
    const items = await complete(tableLines, 1, 20);
    const nameItem = find(items, 'name=');
    expect((nameItem?.insertText as { value?: string })?.value).toContain('${1:old_name}');
  });
});

// ── Ref operator bracket ───────────────────────────────────────────────────

describe('bracket [...] — ref-operator after ref:', () => {
  const tableLines = ['Table users {', '  user_id int [ref: ', '}'];

  it('offers >, <, <>, - operators', async () => {
    const items = await complete(tableLines, 1, 20);
    const ls = labels(items);
    expect(ls).toContain('>');
    expect(ls).toContain('<');
    expect(ls).toContain('<>');
    expect(ls).toContain('-');
  });

  it('each operator has insertText with trailing space', async () => {
    const items = await complete(tableLines, 1, 20);
    const op = find(items, '>');
    expect(op?.insertText).toBe('> ');
  });

  it('each operator triggers follow-up suggestions', async () => {
    const items = await complete(tableLines, 1, 20);
    const op = find(items, '>');
    expect((op?.command as { command?: string })?.command).toBe('editor.action.triggerSuggest');
  });

  it('same operators offered after add ref:', async () => {
    const addRefLines = ['Table users {', '  user_id int [add ref: ', '}'];
    const items = await complete(addRefLines, 1, 24);
    expect(labels(items)).toContain('>');
  });
});

// ── Ref table-column bracket ───────────────────────────────────────────────

describe('bracket [...] — ref-table-column after operator', () => {
  const tableLines = ['Table users {', '  user_id int [ref: > ', '}'];

  it('offers table.column combinations from all visible tables', async () => {
    const items = await complete(tableLines, 1, 22);
    expect(items.length).toBeGreaterThan(0);
    // Labels should be fully-qualified "schema"."table"."column" form
    expect(labels(items).some((l) => l.includes('users') && l.includes('id'))).toBe(true);
  });

  it('pk columns have sortText starting with 0_', async () => {
    const items = await complete(tableLines, 1, 22);
    const pkItem = items.find((i) => i.label.includes('"id"') && i.label.includes('users'));
    expect(pkItem?.sortText).toMatch(/^0_/);
  });
});

// ── Table header bracket settings ─────────────────────────────────────────

describe('bracket [...] on Table header line', () => {
  it('offers add, drop, modify: (table-level settings)', async () => {
    const items = await complete(['Table users [', '}'], 0, 13);
    const ls = labels(items);
    expect(ls).toContain('add');
    expect(ls).toContain('drop');
    expect(ls).toContain('modify: ');
  });

  it('does NOT offer pk or not null (those are column settings)', async () => {
    const items = await complete(['Table users [', '}'], 0, 13);
    const ls = labels(items);
    expect(ls).not.toContain('pk');
    expect(ls).not.toContain('not null');
  });
});

// ── SQL type completions ───────────────────────────────────────────────────

describe('table block — SQL type completions at type position', () => {
  const tableLines = ['Table users {', '  user_id ', '}'];

  it('offers common SQL types', async () => {
    const items = await complete(tableLines, 1, 10);
    const ls = labels(items);
    expect(ls).toContain('int');
    expect(ls).toContain('varchar(255)');
    expect(ls).toContain('uuid');
    expect(ls).toContain('text');
    expect(ls).toContain('boolean');
    expect(ls).toContain('timestamp');
  });

  it('preserves curated order via sortText', async () => {
    const items = await complete(tableLines, 1, 10);
    const intIdx = items.findIndex((i) => i.label === 'int');
    const blobIdx = items.findIndex((i) => i.label === 'blob');
    expect(intIdx).toBeLessThan(blobIdx);
  });
});

// ── Ref line completions ───────────────────────────────────────────────────

describe('Ref: line — schema and table completions', () => {
  it('offers schema names on "Ref: "', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const ls = labels(items);
    expect(ls).toContain('"public"');
    expect(ls).toContain('"billing"');
  });

  it('"public" schema is preselected (D1)', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const pub = find(items, '"public"');
    expect(pub?.preselect).toBe(true);
  });

  it('schema items have filterText without quotes (E5)', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const pub = find(items, '"public"');
    expect(pub?.filterText).toBe('public');
  });

  it('also offers unqualified table names for direct style (C2)', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const ls = labels(items);
    expect(ls).toContain('"users"');
    expect(ls).toContain('"orders"');
    expect(ls).toContain('"invoices"');
  });

  it('unqualified table items have insertText with trailing "." (triggers column suggestions)', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const users = find(items, '"users"');
    expect(users?.insertText).toBe('"users".');
  });

  it('schema items have insertText with trailing "." (triggers table suggestions)', async () => {
    const items = await complete(['Ref: '], 0, 5);
    const pub = find(items, '"public"');
    expect(pub?.insertText).toBe('"public".');
  });

  it('offers operators after "Ref: users.id "', async () => {
    const items = await complete(['Ref: users.id '], 0, 14);
    const ls = labels(items);
    expect(ls).toContain('>');
    expect(ls).toContain('<');
    expect(ls).toContain('<>');
    expect(ls).toContain('-');
  });

  it('offers schemas again after operator (right side, C1)', async () => {
    const items = await complete(['Ref: users.id > '], 0, 16);
    const ls = labels(items);
    expect(ls).toContain('"public"');
    expect(ls).toContain('"billing"');
  });

  it('offers unqualified tables on right side too (C2)', async () => {
    const items = await complete(['Ref: users.id > '], 0, 16);
    const ls = labels(items);
    expect(ls).toContain('"users"');
    expect(ls).toContain('"orders"');
  });
});

// ── dotMatch: column and schema completions ────────────────────────────────

describe('dotMatch — column completions after table.', () => {
  it('"public"."users". → column names of users', async () => {
    const line = 'Ref: "public"."users".';
    const items = await complete([line], 0, line.length);
    const ls = labels(items);
    expect(ls).toContain('"id"');
    expect(ls).toContain('"name"');
  });

  it('pk column is preselected and sorted first', async () => {
    const line = 'Ref: "public"."users".';
    const items = await complete([line], 0, line.length);
    const id = find(items, '"id"');
    expect(id?.preselect).toBe(true);
    expect(id?.sortText).toMatch(/^0_/);
  });

  it('column items have filterText without quotes (E5)', async () => {
    const line = 'Ref: "public"."users".';
    const items = await complete([line], 0, line.length);
    const idItem = find(items, '"id"');
    expect(idItem?.filterText).toBe('id');
  });

  it('schema. → table names in that schema', async () => {
    const line = 'Ref: "billing".';
    const items = await complete([line], 0, line.length);
    const ls = labels(items);
    expect(ls).toContain('"invoices"');
  });

  it('schema table items have insertText with trailing "."', async () => {
    const line = 'Ref: "public".';
    const items = await complete([line], 0, line.length);
    const usersItem = find(items, '"users"');
    expect(usersItem?.insertText).toBe('"users".');
  });
});

// ── Indexes block ──────────────────────────────────────────────────────────

describe('indexes block — column name completions', () => {
  const indexLines = [
    'Table users {',
    '  id int [pk]',
    '  name varchar',
    '  indexes {',
    '    ',
    '  }',
    '}',
  ];

  it('offers columns of the parent table', async () => {
    const items = await complete(indexLines, 4, 4);
    const ls = labels(items);
    expect(ls).toContain('id');
    expect(ls).toContain('name');
  });

  it('pk column is preselected (D1)', async () => {
    const items = await complete(indexLines, 4, 4);
    const idItem = find(items, 'id');
    expect(idItem?.preselect).toBe(true);
  });

  it('pk column sorts before non-pk (D2)', async () => {
    const items = await complete(indexLines, 4, 4);
    const idIdx = items.findIndex((i) => i.label === 'id');
    const nameIdx = items.findIndex((i) => i.label === 'name');
    expect(idIdx).toBeLessThan(nameIdx);
  });

  it('D4: deduplicates columns already on the line', async () => {
    const linesWithId = [
      'Table users {',
      '  id int [pk]',
      '  name varchar',
      '  indexes {',
      '    id, ',  // id already used
      '  }',
      '}',
    ];
    const items = await complete(linesWithId, 4, 8);
    const ls = labels(items);
    expect(ls).not.toContain('id');
    expect(ls).toContain('name');
  });
});

// ── Indexes settings bracket ───────────────────────────────────────────────

describe('indexes block — settings bracket', () => {
  const indexLines = [
    'Table users {',
    '  id int [pk]',
    '  indexes {',
    '    id [',
    '  }',
    '}',
  ];

  it('offers index-specific settings: unique, pk, name:, type:', async () => {
    const items = await complete(indexLines, 3, 8);
    const ls = labels(items);
    expect(ls).toContain('unique');
    expect(ls).toContain('pk');
    expect(ls).toContain('name: ');
    expect(ls.some((l) => l.startsWith('type:'))).toBe(true);
  });

  it('does NOT offer column settings (not null, increment, etc.)', async () => {
    const items = await complete(indexLines, 3, 8);
    const ls = labels(items);
    expect(ls).not.toContain('not null');
    expect(ls).not.toContain('increment');
  });
});
