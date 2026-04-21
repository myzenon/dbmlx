/**
 * Shared types between extension host (Node.js) and webview (Preact).
 * These MUST be plain data — no class instances, no functions.
 * They cross the postMessage boundary and are JSON-serialized.
 */

export type QualifiedName = string; // e.g., "public.users"

export type ColumnChangeKind = 'add' | 'drop' | 'modify';

export interface ColumnChange {
  kind: ColumnChangeKind;
  /** For 'modify': original column name before migration (undefined = name unchanged) */
  fromName?: string;
  /** For 'modify': original column type before migration (undefined = type unchanged) */
  fromType?: string;
  /** For 'modify': pk status before migration (undefined = unchanged) */
  fromPk?: boolean;
  /** For 'modify': not-null status before migration (undefined = unchanged) */
  fromNotNull?: boolean;
  /** For 'modify': unique status before migration (undefined = unchanged) */
  fromUnique?: boolean;
  /** For 'modify': default value before migration (undefined = unchanged) */
  fromDefault?: string;
  /** For 'modify': auto-increment status before migration (undefined = unchanged) */
  fromIncrement?: boolean;
}

export interface Column {
  name: string;
  type: string;
  pk?: boolean;
  notNull?: boolean;
  unique?: boolean;
  increment?: boolean;
  default?: string | null;
  note?: string | null;
}

export interface Table {
  name: QualifiedName;
  schemaName: string;
  tableName: string;
  columns: Column[];
  note?: string | null;
  groupName?: string | null;
  /** Migration change annotations keyed by column name. Empty object if no changes. */
  columnChanges?: Record<string, ColumnChange>;
  /** Table-level migration annotation: add, drop, or rename. */
  tableChange?: 'add' | 'drop' | 'modify';
  /** For tableChange === 'modify': the table name before the migration. */
  tableFromName?: string;
}

export type RefEndpointRelation = '1' | '*'; // one or many

export interface Ref {
  id: string; // stable hash of endpoints
  source: { table: QualifiedName; columns: string[]; relation: RefEndpointRelation };
  target: { table: QualifiedName; columns: string[]; relation: RefEndpointRelation };
  name?: string | null;
}

export interface TableGroup {
  name: string;
  tables: QualifiedName[];
  note?: string | null;
}

/** A named, filterable view of the diagram defined in DBML with DiagramView { }. */
export interface DiagramView {
  name: string;
  /** Specific unqualified table names, or null meaning "not filtered by tables". */
  tables: string[] | null;
  /** Specific table group names, or null meaning "not filtered by groups". */
  tableGroups: string[] | null;
  /** Specific schema names, or null meaning "not filtered by schemas". */
  schemas: string[] | null;
}

export interface Schema {
  tables: Table[];
  refs: Ref[];
  groups: TableGroup[];
  views: DiagramView[];
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

/* ----- Layout file ----- */

export interface TableLayout {
  x: number;
  y: number;
  hidden?: boolean;
  color?: string;
}

export interface GroupLayout {
  collapsed?: boolean;
  hidden?: boolean;
  color?: string;
}

export interface ViewportLayout {
  x: number;
  y: number;
  zoom: number;
}

export interface EdgeLayout {
  dx?: number;
  dy?: number;
}

export interface ViewSettings {
  showOnlyPkFk?: boolean;
  showGroupBoundary?: boolean;
  showCardinalityLabels?: boolean;
}

export interface Layout {
  version: 1;
  viewport: ViewportLayout;
  tables: Record<QualifiedName, TableLayout>;
  groups: Record<string, GroupLayout>;
  edges?: Record<string, EdgeLayout>;
  viewSettings?: ViewSettings;
}

/* ----- Protocol: Host → Webview ----- */

export type ViewportCommand = 'zoomIn' | 'zoomOut' | 'resetView' | 'fitToContent';

export type HostToWebview =
  | { type: 'schema:update'; payload: { schema: Schema; parseError: ParseError | null } }
  | { type: 'layout:loaded'; payload: Layout }
  | { type: 'layout:external-change'; payload: Layout }
  | { type: 'theme:change'; payload: { kind: 'light' | 'dark' } }
  | { type: 'viewport:command'; payload: { action: ViewportCommand } }
  | { type: 'export:request' };

/* ----- Protocol: Webview → Host ----- */

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'layout:persist'; payload: Partial<Layout> }
  | { type: 'command:reveal'; payload: { tableName: QualifiedName } }
  | { type: 'command:pruneOrphans' }
  | { type: 'command:resetLayout' }
  | { type: 'error:log'; payload: { message: string; stack?: string } }
  | { type: 'export:svg'; payload: { svg: string } }
  | { type: 'export:png'; payload: { data: string } } // base64 PNG data URL
  | { type: 'view:switch'; payload: { view: string | null } };
