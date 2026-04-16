import { createStore } from 'zustand/vanilla';
import { useSyncExternalStore } from 'preact/compat';
import type { Layout, ParseError, QualifiedName, Schema, TableLayout, ViewportLayout } from '../../shared/types';

export interface AppState {
  schema: Schema;
  parseError: ParseError | null;
  positions: Map<QualifiedName, { x: number; y: number }>;
  groups: Record<string, { collapsed: boolean; hidden: boolean; color?: string }>;
  viewport: ViewportLayout;
  theme: 'light' | 'dark';
  ready: boolean;
}

export interface AppActions {
  setSchema(schema: Schema, parseError: ParseError | null): void;
  setLayout(layout: Layout): void;
  setTablePos(name: QualifiedName, x: number, y: number): void;
  setViewport(vp: Partial<ViewportLayout>): void;
  setTheme(kind: 'light' | 'dark'): void;
  setPositionsBatch(entries: Array<[QualifiedName, { x: number; y: number }]>): void;
}

const initial: AppState = {
  schema: { tables: [], refs: [], groups: [] },
  parseError: null,
  positions: new Map(),
  groups: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  theme: 'light',
  ready: false,
};

export const store = createStore<AppState & AppActions>((set, _get) => ({
  ...initial,
  setSchema(schema, parseError) {
    set({ schema, parseError, ready: true });
  },
  setLayout(layout) {
    const positions = new Map<QualifiedName, { x: number; y: number }>();
    for (const [name, pos] of Object.entries(layout.tables)) {
      positions.set(name, { x: pos.x, y: pos.y });
    }
    set({ positions, groups: { ...layout.groups }, viewport: { ...layout.viewport } });
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
}));

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(() => listener()),
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function toTableLayoutRecord(positions: Map<QualifiedName, { x: number; y: number }>): Record<QualifiedName, TableLayout> {
  const out: Record<QualifiedName, TableLayout> = {};
  for (const [name, pos] of positions) out[name] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  return out;
}
