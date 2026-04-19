import { createStore } from 'zustand/vanilla';
import { useSyncExternalStore } from 'preact/compat';
import type { EdgeLayout, GroupLayout, Layout, ParseError, QualifiedName, Schema, TableLayout, ViewportLayout } from '../../shared/types';
import type { LayoutAlgorithm } from '../layout/autoLayout';

export interface TooltipState {
  title: string;
  subtitle?: string;
  body: string;
  x: number;
  y: number;
}

export interface AppState {
  schema: Schema;
  parseError: ParseError | null;
  positions: Map<QualifiedName, { x: number; y: number }>;
  hiddenTables: Set<QualifiedName>;
  tableColors: Map<QualifiedName, string>;
  edgeOffsets: Map<string, EdgeLayout>;
  groups: Record<string, GroupLayout>;
  viewport: ViewportLayout;
  theme: 'light' | 'dark';
  ready: boolean;
  selection: Set<QualifiedName>;
  tooltip: TooltipState | null;
  /** Ephemeral view flag: render only PK + FK columns in tables. Not persisted. */
  showOnlyPkFk: boolean;
  /** Ephemeral: algorithm to use next time auto-layout runs. Not persisted. */
  layoutAlgorithm: LayoutAlgorithm;
  /** Ephemeral: show/hide group boundary boxes and use group-aware layout. Not persisted. */
  showGroupBoundary: boolean;
  /** Ephemeral: show/hide 1-N cardinality labels on relation lines. Not persisted. */
  showCardinalityLabels: boolean;
  /** Active DiagramView name, or null = show all tables. Ephemeral, not persisted. */
  activeView: string | null;
}

export interface AppActions {
  setSchema(schema: Schema, parseError: ParseError | null): void;
  setLayout(layout: Layout): void;
  setTablePos(name: QualifiedName, x: number, y: number): void;
  setViewport(vp: Partial<ViewportLayout>): void;
  setTheme(kind: 'light' | 'dark'): void;
  setPositionsBatch(entries: Array<[QualifiedName, { x: number; y: number }]>): void;
  setGroup(name: string, patch: Partial<GroupLayout>): void;
  setTableHidden(name: QualifiedName, hidden: boolean): void;
  setTableColor(name: QualifiedName, color: string | null): void;
  setEdgeOffset(refId: string, offset: EdgeLayout | null): void;
  setSelection(names: Iterable<QualifiedName>): void;
  clearSelection(): void;
  setTooltip(t: TooltipState | null): void;
  toggleShowOnlyPkFk(): void;
  setLayoutAlgorithm(algo: LayoutAlgorithm): void;
  setShowGroupBoundary(v: boolean): void;
  setShowCardinalityLabels(v: boolean): void;
  resetPositions(): void;
  setActiveView(name: string | null): void;
}

const initial: AppState = {
  schema: { tables: [], refs: [], groups: [], views: [] },
  parseError: null,
  positions: new Map(),
  hiddenTables: new Set(),
  tableColors: new Map(),
  edgeOffsets: new Map(),
  groups: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  theme: 'light',
  ready: false,
  selection: new Set(),
  tooltip: null,
  showOnlyPkFk: false,
  layoutAlgorithm: 'top-down' as LayoutAlgorithm,
  showGroupBoundary: true,
  showCardinalityLabels: true,
  activeView: null,
};

export const store = createStore<AppState & AppActions>((set, _get) => ({
  ...initial,
  setSchema(schema, parseError) {
    set({ schema, parseError, ready: true });
  },
  setLayout(layout) {
    const positions = new Map<QualifiedName, { x: number; y: number }>();
    const hiddenTables = new Set<QualifiedName>();
    const tableColors = new Map<QualifiedName, string>();
    const edgeOffsets = new Map<string, EdgeLayout>();
    for (const [name, pos] of Object.entries(layout.tables)) {
      positions.set(name, { x: pos.x, y: pos.y });
      if (pos.hidden) hiddenTables.add(name);
      if (pos.color) tableColors.set(name, pos.color);
    }
    for (const [id, eo] of Object.entries(layout.edges ?? {})) {
      if (eo.dx !== undefined || eo.dy !== undefined) edgeOffsets.set(id, { dx: eo.dx, dy: eo.dy });
    }
    set({ positions, hiddenTables, tableColors, edgeOffsets, groups: { ...layout.groups }, viewport: { ...layout.viewport } });
  },
  setTablePos(name, x, y) {
    set((s) => {
      const next = new Map(s.positions);
      next.set(name, { x: Math.round(x), y: Math.round(y) });
      return { positions: next };
    });
  },
  setPositionsBatch(entries) {
    set((s) => {
      const next = new Map(s.positions);
      for (const [name, pos] of entries) next.set(name, { x: Math.round(pos.x), y: Math.round(pos.y) });
      return { positions: next };
    });
  },
  setViewport(vp) {
    set((s) => ({ viewport: { ...s.viewport, ...vp } }));
  },
  setTheme(kind) {
    set({ theme: kind });
  },
  setGroup(name, patch) {
    set((s) => {
      const existing = s.groups[name] ?? {};
      const merged: GroupLayout = { ...existing, ...patch };
      if (merged.collapsed === false) delete merged.collapsed;
      if (merged.hidden === false) delete merged.hidden;
      if (merged.color === '') delete merged.color;
      return { groups: { ...s.groups, [name]: merged } };
    });
  },
  setTableHidden(name, hidden) {
    set((s) => {
      const next = new Set(s.hiddenTables);
      if (hidden) next.add(name); else next.delete(name);
      return { hiddenTables: next };
    });
  },
  setTableColor(name, color) {
    set((s) => {
      const next = new Map(s.tableColors);
      if (color) next.set(name, color); else next.delete(name);
      return { tableColors: next };
    });
  },
  setEdgeOffset(refId, offset) {
    set((s) => {
      const next = new Map(s.edgeOffsets);
      if (offset && (offset.dx !== undefined || offset.dy !== undefined)) {
        next.set(refId, offset);
      } else {
        next.delete(refId);
      }
      return { edgeOffsets: next };
    });
  },
  setSelection(names) {
    set({ selection: new Set(names) });
  },
  clearSelection() {
    set({ selection: new Set() });
  },
  setTooltip(t) {
    set({ tooltip: t });
  },
  toggleShowOnlyPkFk() {
    set((s) => ({ showOnlyPkFk: !s.showOnlyPkFk }));
  },
  setLayoutAlgorithm(algo) {
    set({ layoutAlgorithm: algo });
  },
  setShowGroupBoundary(v: boolean) {
    set({ showGroupBoundary: v });
  },
  setShowCardinalityLabels(v: boolean) {
    set({ showCardinalityLabels: v });
  },
  resetPositions() {
    set({ positions: new Map() });
  },
  setActiveView(name) {
    set({ activeView: name });
  },
}));

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(() => listener()),
    () => selector(store.getState()),
  );
}

export function toTableLayoutRecord(
  positions: Map<QualifiedName, { x: number; y: number }>,
  hiddenTables: Set<QualifiedName>,
  tableColors: Map<QualifiedName, string>,
): Record<QualifiedName, TableLayout> {
  const out: Record<QualifiedName, TableLayout> = {};
  for (const [name, pos] of positions) {
    const entry: TableLayout = { x: Math.round(pos.x), y: Math.round(pos.y) };
    if (hiddenTables.has(name)) entry.hidden = true;
    const c = tableColors.get(name);
    if (c) entry.color = c;
    out[name] = entry;
  }
  return out;
}
