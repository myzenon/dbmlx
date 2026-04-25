import { Parser } from '@dbml/core';
import type {
  Column,
  ColumnChange,
  DiagramView,
  ParseError,
  QualifiedName,
  Ref,
  RefEndpointRelation,
  Schema,
  Table,
  TableGroup,
} from '../shared/types';

/**
 * Wrapper over @dbml/core Parser.
 * Input: DBML source string.
 * Output: internal Schema (plain-data, postMessage-safe) or ParseError.
 */
/** Strip dbmlx-only syntax (DiagramView blocks, migration annotations) leaving clean DBML for @dbml/core. */
export function stripDbmlxExtensions(source: string): string {
  const { stripped: noViews } = extractDiagramViews(source);
  const { stripped } = extractMigrationChanges(noViews);
  return stripped;
}

export function parseDbmlx(source: string): { schema: Schema; error: null } | { schema: null; error: ParseError } {
  const { stripped: noViews, views } = extractDiagramViews(source);
  const { stripped, changes: migrationChanges, tableChanges, tableFromNames, indexChanges } = extractMigrationChanges(noViews);
  try {
    const db = Parser.parse(stripped, 'dbmlv2');
    const exported = db.export() as unknown as ExportedDatabase;
    const schema = mapExportedToSchema(exported, migrationChanges, tableChanges, tableFromNames, indexChanges);
    schema.views = views;
    return { schema, error: null };
  } catch (err) {
    return { schema: null, error: toParseError(err) };
  }
}

/**
 * Extracts all DiagramView { } blocks from DBML source and returns the source
 * with those blocks removed (so @dbml/core doesn't choke on them).
 */
function extractDiagramViews(source: string): { stripped: string; views: DiagramView[] } {
  const views: DiagramView[] = [];
  // Match DiagramView <name> { ... } — handles nested braces naively (DBML blocks don't nest deeply)
  const stripped = source.replace(/DiagramView\s+(\w+)\s*\{([^{}]*(?:\{[^}]*\}[^{}]*)*)\}/gi, (_match, name: string, body: string) => {
    views.push(parseDiagramViewBody(name.trim(), body));
    return '';
  });
  return { stripped, views };
}

function parseDiagramViewBody(name: string, body: string): DiagramView {
  const parseSection = (keyword: string): string[] | null => {
    const re = new RegExp(`${keyword}\\s*\\{([^}]*)\\}`, 'i');
    const m = body.match(re);
    if (!m) return null;
    const content = m[1]!.trim();
    if (content === '*') return []; // empty array = wildcard (all)
    return content.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  };
  return {
    name,
    tables: parseSection('Tables'),
    tableGroups: parseSection('TableGroups'),
    schemas: parseSection('Schemas'),
  };
}

/**
 * Extracts migration change annotations from DBML source.
 * Supported syntax inside Table blocks:
 *   col type [modify: name="new_name", type="new_type"]  — rename / retype
 *   col type [drop]                                       — column being dropped
 *   col type [add]                                        — column being added
 * Strips these annotations before passing to @dbml/core.
 */
function extractMigrationChanges(source: string): {
  stripped: string;
  changes: Map<string, Map<string, ColumnChange>>;
  tableChanges: Map<string, 'add' | 'drop' | 'modify'>;
  tableFromNames: Map<string, string>;
  indexChanges: Map<string, Array<{ columns: string[]; kind: 'add' | 'drop' }>>;
} {
  const changes = new Map<string, Map<string, ColumnChange>>();
  const tableChanges = new Map<string, 'add' | 'drop' | 'modify'>();
  const tableFromNames = new Map<string, string>();
  const indexChanges = new Map<string, Array<{ columns: string[]; kind: 'add' | 'drop' }>>();
  const lines = source.split('\n');
  const outLines: string[] = [];

  let braceDepth = 0;
  let inTable = false;
  let tableBodyDepth = 0;
  let currentTableRawName = '';
  let inIndexesBlock = false;
  let indexesBodyDepth = 0;

  const TABLE_OPEN_RE = /^\s*[Tt]able\s+([\w"`.]+(?:\.[\w"`.]+)?)/;
  const COL_NAME_RE = /^\s+(?:"([^"]+)"|(\w+))\s/;
  const MODIFY_RE = /\[[^\]]*\bmodify:\s*([^\]]*)\]/i;

  for (const line of lines) {
    const clean = line.replace(/"[^"]*"|'[^']*'|`[^`]*`|\/\/.*$/g, '');
    const opens = (clean.match(/\{/g) ?? []).length;
    const closes = (clean.match(/\}/g) ?? []).length;

    let isTableHeader = false;
    const tableMatch = TABLE_OPEN_RE.exec(line);
    if (tableMatch && !inTable) {
      const raw = tableMatch[1]!.replace(/["` ]/g, '');
      currentTableRawName = raw.includes('.') ? raw.split('.').pop()! : raw;
      inTable = true;
      isTableHeader = true;
      tableBodyDepth = braceDepth + opens;
      if (!changes.has(currentTableRawName)) changes.set(currentTableRawName, new Map());
      if (!indexChanges.has(currentTableRawName)) indexChanges.set(currentTableRawName, []);
      // Detect [add] / [drop] / [modify: name="old"] on the table header line (before `{`)
      const headerBracket = /\[([^\]]*)\]/.exec(line.replace(/\{[^}]*$/, ''));
      if (headerBracket) {
        const inner = headerBracket[1]!;
        if (/\badd\b/i.test(inner)) {
          tableChanges.set(currentTableRawName, 'add');
        } else if (/\bdrop\b/i.test(inner)) {
          tableChanges.set(currentTableRawName, 'drop');
        } else if (/\bmodify\s*:/i.test(inner)) {
          tableChanges.set(currentTableRawName, 'modify');
          const fromName = /\bname\s*=\s*"([^"]*)"/.exec(inner)?.[1];
          if (fromName) tableFromNames.set(currentTableRawName, fromName);
        }
      }
    }

    braceDepth += opens - closes;
    if (inTable && braceDepth < tableBodyDepth) inTable = false;
    if (inIndexesBlock && braceDepth < indexesBodyDepth) inIndexesBlock = false;

    let processedLine = line;

    // Detect "indexes {" header at table body depth
    const isIndexesHeader = inTable && !inIndexesBlock && /^\s*indexes\s*\{/i.test(line);
    if (isIndexesHeader) { inIndexesBlock = true; indexesBodyDepth = braceDepth; }

    // Parse index lines for [add]/[drop] annotations
    if (inTable && inIndexesBlock && !isIndexesHeader && braceDepth === indexesBodyDepth) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== '}') {
        const hasIndexAdd = /\[[^\]]*\badd\b[^\]]*\]/i.test(line);
        const hasIndexDrop = /\[[^\]]*\bdrop\b[^\]]*\]/i.test(line);
        if (hasIndexAdd || hasIndexDrop) {
          let columns: string[] = [];
          const compositeMatch = /^\s*\(([^)]+)\)/.exec(line);
          if (compositeMatch) {
            columns = compositeMatch[1]!.split(',').map((s) => s.trim().replace(/["'`]/g, '')).filter(Boolean);
          } else {
            const singleMatch = /^\s*(\w+)/.exec(line);
            if (singleMatch) columns = [singleMatch[1]!];
          }
          const kind: 'add' | 'drop' = hasIndexDrop ? 'drop' : 'add';
          indexChanges.get(currentTableRawName)!.push({ columns, kind });
          if (hasIndexDrop) { outLines.push(''); continue; }
          processedLine = line.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
            const rest = inner.split(',').map((s) => s.trim()).filter((s) => !/^add$/i.test(s)).join(', ');
            return rest ? `[${rest}]` : '';
          }).trimEnd();
          outLines.push(processedLine);
          continue;
        }
      }
    }

    // Detect Ref lines with [add]/[drop] (top-level or inside table blocks)
    if (/^\s*[Rr]ef\b/.test(line) && !isTableHeader && !isIndexesHeader) {
      const hasRefDrop = /\[[^\]]*\bdrop\b[^\]]*\]/i.test(line);
      const hasRefAdd = /\[[^\]]*\badd\b[^\]]*\]/i.test(line);
      if (hasRefDrop || hasRefAdd) {
        const keyword = hasRefDrop ? 'drop' : 'add';
        const PREFIX = hasRefDrop ? 'DBMLXDROP_' : 'DBMLXADD_';
        processedLine = line.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
          if (!new RegExp(`\\b${keyword}\\b`, 'i').test(inner)) return _m;
          const rest = inner.split(',').map((s) => s.trim()).filter((s) => !new RegExp(`^${keyword}$`, 'i').test(s)).join(', ');
          return rest ? `[${rest}]` : '';
        }).trimEnd();
        // Inject name prefix so mapRef can detect the annotation
        processedLine = processedLine.replace(
          /^(\s*[Rr]ef\b)(\s+"[^"]*"|\s+[\w]+)?(\s*:)/,
          (_m, kw: string, name: string | undefined, colon: string) => {
            const orig = (name ?? '').trim().replace(/^"|"$/g, '').replace(/\s+/g, '_');
            return `${kw} ${PREFIX}${orig}${colon}`;
          },
        );
        outLines.push(processedLine);
        continue;
      }
    }

    // Strip [add] / [drop] / [modify: ...] from table header so @dbml/core doesn't choke on them
    if (isTableHeader && tableChanges.has(currentTableRawName)) {
      processedLine = processedLine.replace(/\[([^\]]*)\]/, (_m, content: string) => {
        const KV = /\w+\s*=\s*(?:"[^"]*"|true|false)/;
        const NEXT_KV = /(?=\w+\s*=\s*(?:"|true|false))/;
        const cleaned = content
          .replace(new RegExp(`\\s*\\bmodify:\\s*(?:${KV.source}(?:\\s*,\\s*${NEXT_KV.source})?)*\\s*`, 'gi'), '')
          .split(',').map((s: string) => s.trim()).filter((s: string) => !/^(add|drop)$/i.test(s)).join(', ')
          .replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '').trim();
        return cleaned ? `[${cleaned}]` : '';
      }).trimEnd();
    }
    if (inTable && braceDepth === tableBodyDepth) {
      const tableChanges = changes.get(currentTableRawName)!;

      const colMatch = COL_NAME_RE.exec(line);
      const colName = colMatch ? (colMatch[1] ?? colMatch[2]) : undefined;
      if (colName) {
        // [{WHATEVER_RULES}modify: name="x", type="y"]
        const modifyMatch = MODIFY_RE.exec(line);
        if (modifyMatch) {
          const body = modifyMatch[1]!;
          const fromName = /\bname\s*=\s*"([^"]*)"/.exec(body)?.[1];
          const fromType = /\btype\s*=\s*"([^"]*)"/.exec(body)?.[1];
          const parseBool = (key: string) => { const m = new RegExp(`\\b${key}\\s*=\\s*(true|false)\\b`).exec(body); return m ? m[1] === 'true' : undefined; };
          const fromPk = parseBool('pk');
          const fromNotNull = parseBool('not_null');
          const fromUnique = parseBool('unique');
          const fromDefault = /\bdefault\s*=\s*"([^"]*)"/.exec(body)?.[1];
          const fromIncrement = parseBool('increment');
          tableChanges.set(colName, { kind: 'modify', fromName, fromType, fromPk, fromNotNull, fromUnique, fromDefault, fromIncrement });
          // Strip modify: and all its key=value pairs (quoted strings or booleans), preserving other settings
          processedLine = line.replace(/\[([^\]]*)\]/, (_m, inner: string) => {
            const KV = /\w+\s*=\s*(?:"[^"]*"|true|false)/;
            const NEXT_KV = /(?=\w+\s*=\s*(?:"|true|false))/;
            const cleaned = inner
              .replace(new RegExp(`\\s*\\bmodify:\\s*(?:${KV.source}(?:\\s*,\\s*${NEXT_KV.source})?)*\\s*`, 'gi'), '')
              .replace(/,\s*,/g, ',')
              .replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '')
              .trim();
            return cleaned ? `[${cleaned}]` : '';
          }).trimEnd();
          outLines.push(processedLine);
          continue;
        }

        // [add] — strip from settings, keep column for @dbml/core
        const hasAdd = /\[[^\]]*\badd\b[^\]]*\]/i.test(line);
        if (hasAdd) {
          tableChanges.set(colName, { kind: 'add' });
          processedLine = line.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
            if (!/\badd\b/i.test(inner)) return _m;
            const rest = inner.split(',').map((s: string) => s.trim()).filter((s: string) => !/^add$/i.test(s)).join(', ');
            return rest ? `[${rest}]` : '';
          }).trimEnd();
          outLines.push(processedLine);
          continue;
        }

        // [drop] — strip from settings, keep column for @dbml/core
        const hasDrop = /\[[^\]]*\bdrop\b[^\]]*\]/i.test(line);
        if (hasDrop) {
          tableChanges.set(colName, { kind: 'drop' });
          processedLine = line.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
            if (!/\bdrop\b/i.test(inner)) return _m;
            const rest = inner.split(',').map((s: string) => s.trim()).filter((s: string) => !/^drop$/i.test(s)).join(', ');
            return rest ? `[${rest}]` : '';
          }).trimEnd();
          outLines.push(processedLine);
          continue;
        }
      }
    }

    outLines.push(processedLine);
  }

  return { stripped: outLines.join('\n'), changes, tableChanges, tableFromNames, indexChanges };
}

function toParseError(err: unknown): ParseError {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = typeof e.message === 'string' ? e.message : String(err);
    const diags = (e.diags ?? e.diagnostics) as unknown;
    if (Array.isArray(diags) && diags.length > 0) {
      const first = diags[0] as Record<string, unknown>;
      const loc = first.location as Record<string, unknown> | undefined;
      const start = loc?.start as Record<string, unknown> | undefined;
      return {
        message: typeof first.message === 'string' ? first.message : message,
        line: typeof start?.line === 'number' ? start.line : undefined,
        column: typeof start?.column === 'number' ? start.column : undefined,
      };
    }
    return { message };
  }
  return { message: String(err) };
}

/* ----- AST mapping ----- */

interface ExportedField {
  name: string;
  type: unknown;
  unique: boolean;
  pk: boolean;
  not_null: boolean;
  note: string;
  dbdefault: unknown;
  increment: boolean;
}

interface ExportedIndexColumn {
  value: string;
  type: 'column' | 'expression';
}

interface ExportedIndex {
  columns: ExportedIndexColumn[];
  pk: boolean;
  unique: boolean;
}

interface ExportedTable {
  fields: ExportedField[];
  indexes?: ExportedIndex[];
  name: string;
  alias: string | null;
  note: string;
  headerColor: string | null;
}

interface ExportedRef {
  endpoints: Array<{
    schemaName: string | null;
    tableName: string;
    fieldNames: string[];
    relation: unknown;
  }>;
  name: string | null;
  onDelete: unknown;
  onUpdate: unknown;
}

interface ExportedTableGroup {
  name: string;
  tables: Array<{ schemaName: string | null; tableName: string }>;
}

interface ExportedSchema {
  name: string;
  tables: ExportedTable[];
  refs: ExportedRef[];
  tableGroups: ExportedTableGroup[];
}

interface ExportedDatabase {
  schemas: ExportedSchema[];
}

function unquote(s: string): string {
  if (!s) return s;
  const first = s.charAt(0);
  const last = s.charAt(s.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

function qualify(schemaName: string | null | undefined, tableName: string): QualifiedName {
  const s = unquote((schemaName ?? '').trim());
  const t = unquote(tableName.trim());
  return `${s && s.length > 0 ? s : 'public'}.${t}`;
}

function mapExportedToSchema(db: ExportedDatabase, migrationChanges: Map<string, Map<string, ColumnChange>>, tableAnnotations?: Map<string, 'add' | 'drop' | 'modify'>, tableFromNames?: Map<string, string>, tableIndexChanges?: Map<string, Array<{ columns: string[]; kind: 'add' | 'drop' }>>): Schema {
  const tables: Table[] = [];
  const refs: Ref[] = [];
  const groups: TableGroup[] = [];
  const tableToGroup = new Map<QualifiedName, string>();

  // Pass 1: build the complete tableToGroup map and groups list across ALL schemas before
  // assigning groupName to tables. @dbml/core may emit TableGroup definitions in a different
  // schema entry than the tables they reference (e.g. billing.orders table in "billing" schema,
  // but the TableGroup definition ends up in the "public" schema entry which is listed last).
  for (const s of db.schemas) {
    const schemaName = s.name && s.name.length > 0 ? s.name : 'public';
    for (const g of s.tableGroups ?? []) {
      const members: QualifiedName[] = [];
      for (const t of g.tables ?? []) {
        const q = qualify(t.schemaName ?? schemaName, t.tableName);
        members.push(q);
        tableToGroup.set(q, g.name);
      }
      members.sort();
      groups.push({ name: unquote(g.name), tables: members });
    }
  }

  // Pass 2: build tables now that tableToGroup is fully populated.
  for (const s of db.schemas) {
    const schemaName = s.name && s.name.length > 0 ? s.name : 'public';

    for (const t of s.tables ?? []) {
      const cleanName = unquote(t.name);
      const qn = qualify(schemaName, cleanName);
      const rawChanges = migrationChanges.get(cleanName);
      const columnChanges: Record<string, ColumnChange> = {};
      if (rawChanges) for (const [col, change] of rawChanges) columnChanges[col] = change;
      const pkIndexCols = new Set<string>();
      for (const idx of t.indexes ?? []) {
        if (idx.pk) {
          for (const c of idx.columns) {
            if (c.type === 'column') pkIndexCols.add(unquote(c.value));
          }
        }
      }
      const columns = (t.fields ?? []).map((f) => {
        const col = mapField(f);
        return pkIndexCols.has(col.name) ? { ...col, pk: true } : col;
      });
      const tableChange = tableAnnotations?.get(cleanName);
      const tableFromName = tableFromNames?.get(cleanName);
      const idxChanges = tableIndexChanges?.get(cleanName)?.filter((ic) => ic.columns.length > 0);
      tables.push({
        name: qn,
        schemaName,
        tableName: cleanName,
        columns,
        note: t.note || null,
        groupName: tableToGroup.get(qn) ?? null,
        columnChanges,
        ...(tableChange ? { tableChange } : {}),
        ...(tableFromName ? { tableFromName } : {}),
        ...(idxChanges?.length ? { indexChanges: idxChanges } : {}),
      });
    }

    for (const r of s.refs ?? []) {
      const mapped = mapRef(r, schemaName);
      if (mapped) refs.push(mapped);
    }
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  groups.sort((a, b) => a.name.localeCompare(b.name));

  return { tables, refs, groups, views: [] };
}

function mapField(f: ExportedField): Column {
  return {
    name: unquote(f.name),
    type: typeName(f.type),
    pk: f.pk || undefined,
    notNull: f.not_null || undefined,
    unique: f.unique || undefined,
    increment: f.increment || undefined,
    default: f.dbdefault != null ? String((f.dbdefault as { value?: unknown })?.value ?? f.dbdefault) : null,
    note: f.note || null,
  };
}

function typeName(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>;
    if (typeof o.type_name === 'string') return o.type_name;
    if (typeof o.name === 'string') return o.name;
  }
  return 'unknown';
}

function mapRef(r: ExportedRef, defaultSchemaName: string): Ref | null {
  if (!r.endpoints || r.endpoints.length !== 2) return null;
  const [a, b] = r.endpoints;
  if (!a || !b) return null;
  const source = {
    table: qualify(a.schemaName ?? defaultSchemaName, a.tableName),
    columns: a.fieldNames.map(unquote),
    relation: normalizeRelation(a.relation),
  };
  const target = {
    table: qualify(b.schemaName ?? defaultSchemaName, b.tableName),
    columns: b.fieldNames.map(unquote),
    relation: normalizeRelation(b.relation),
  };
  const id = stableRefId(source.table, source.columns, target.table, target.columns);
  let name = r.name || null;
  let refChange: 'add' | 'drop' | undefined;
  if (name?.startsWith('DBMLXADD_')) { refChange = 'add'; name = name.slice(9) || null; }
  else if (name?.startsWith('DBMLXDROP_')) { refChange = 'drop'; name = name.slice(10) || null; }
  return { id, source, target, name, ...(refChange ? { refChange } : {}) };
}

function normalizeRelation(rel: unknown): RefEndpointRelation {
  if (rel === '*' || rel === 'many' || rel === '>') return '*';
  return '1';
}

function stableRefId(
  srcTable: string,
  srcCols: string[],
  tgtTable: string,
  tgtCols: string[],
): string {
  const a = `${srcTable}(${[...srcCols].sort().join(',')})`;
  const b = `${tgtTable}(${[...tgtCols].sort().join(',')})`;
  return a < b ? `${a}->${b}` : `${b}->${a}`;
}
