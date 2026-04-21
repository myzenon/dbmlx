import { store } from '../state/store';
import { estimateSize, tableActualHeight } from '../layout/autoLayout';
import { schedulePersist } from '../drag/dragController';
import type { QualifiedName } from '../../shared/types';

let _viewportEl: HTMLElement | null = null;

export function registerViewportEl(el: HTMLElement | null): void {
  _viewportEl = el;
}

export interface Point { x: number; y: number }

export function screenToWorld(screen: Point): Point {
  const vp = store.getState().viewport;
  return {
    x: (screen.x - vp.x) / vp.zoom,
    y: (screen.y - vp.y) / vp.zoom,
  };
}

export function worldToScreen(world: Point): Point {
  const vp = store.getState().viewport;
  return {
    x: world.x * vp.zoom + vp.x,
    y: world.y * vp.zoom + vp.y,
  };
}

export function zoomAt(screen: Point, factor: number): void {
  const state = store.getState();
  const vp = state.viewport;
  const nextZoom = clamp(vp.zoom * factor, 0.08, 4);
  if (nextZoom === vp.zoom) return;
  const world = { x: (screen.x - vp.x) / vp.zoom, y: (screen.y - vp.y) / vp.zoom };
  const nextX = screen.x - world.x * nextZoom;
  const nextY = screen.y - world.y * nextZoom;
  state.setViewport({ x: nextX, y: nextY, zoom: nextZoom });
}

export function panBy(dx: number, dy: number): void {
  const state = store.getState();
  state.setViewport({ x: state.viewport.x + dx, y: state.viewport.y + dy });
}

export function zoomAtCenter(factor: number, viewportEl: HTMLElement): void {
  const rect = viewportEl.getBoundingClientRect();
  zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor);
}

export function resetView(): void {
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
}

export function fitToContent(viewportEl: HTMLElement, padding = 48): void {
  const state = store.getState();
  const tables = state.schema.tables;
  if (tables.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tables) {
    const pos = state.positions.get(t.name);
    if (!pos) continue;
    const size = estimateSize(t.columns.length);
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x + size.width > maxX) maxX = pos.x + size.width;
    if (pos.y + size.height > maxY) maxY = pos.y + size.height;
  }
  if (!Number.isFinite(minX)) return;
  const rect = viewportEl.getBoundingClientRect();
  const availW = Math.max(1, rect.width - padding * 2);
  const availH = Math.max(1, rect.height - padding * 2);
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const zoom = clamp(Math.min(availW / worldW, availH / worldH), 0.08, 4);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x = rect.width / 2 - cx * zoom;
  const y = rect.height / 2 - cy * zoom;
  store.getState().setViewport({ x, y, zoom });
}

export function focusTable(name: QualifiedName): void {
  const state = store.getState();
  const pos = state.positions.get(name);
  if (!pos) return;

  const table = state.schema.tables.find((t) => t.name === name);
  const w = estimateSize(table?.columns.length ?? 0).width;
  const h = table ? tableActualHeight(table) : estimateSize(0).height;

  // Un-hide the table if it's individually hidden.
  if (state.hiddenTables.has(name)) {
    state.setTableHidden(name, false);
    schedulePersist();
  }
  // Un-hide / un-collapse the group if this table belongs to one.
  if (table?.groupName) {
    const gs = state.groups[table.groupName];
    if (gs?.hidden) {
      state.setGroup(table.groupName, { hidden: false });
      schedulePersist();
    }
    if (gs?.collapsed) {
      state.setGroup(table.groupName, { collapsed: false });
      schedulePersist();
    }
  }

  const el = _viewportEl;
  const vw = el ? el.getBoundingClientRect().width : window.innerWidth;
  const vh = el ? el.getBoundingClientRect().height : window.innerHeight;

  const zoom = clamp(state.viewport.zoom, 0.5, 2);
  const cx = pos.x + w / 2;
  const cy = pos.y + h / 2;
  state.setViewport({ x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom, zoom });
}

export function focusGroup(groupName: string): void {
  const state = store.getState();
  const group = state.schema.groups.find((g) => g.name === groupName);
  if (!group) return;

  // Un-hide / un-collapse the group first so its tables are visible.
  const gs = state.groups[groupName];
  if (gs?.hidden) { state.setGroup(groupName, { hidden: false }); schedulePersist(); }
  if (gs?.collapsed) { state.setGroup(groupName, { collapsed: false }); schedulePersist(); }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const name of group.tables) {
    const pos = state.positions.get(name);
    if (!pos) continue;
    const t = state.schema.tables.find((t) => t.name === name);
    const w = estimateSize(t?.columns.length ?? 0).width;
    const h = t ? tableActualHeight(t) : estimateSize(0).height;
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x + w > maxX) maxX = pos.x + w;
    if (pos.y + h > maxY) maxY = pos.y + h;
  }
  if (!Number.isFinite(minX)) return;

  const el = _viewportEl;
  const vw = el ? el.getBoundingClientRect().width : window.innerWidth;
  const vh = el ? el.getBoundingClientRect().height : window.innerHeight;
  const padding = 64;
  const zoom = clamp(Math.min((vw - padding * 2) / Math.max(1, maxX - minX), (vh - padding * 2) / Math.max(1, maxY - minY)), 0.08, 4);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  state.setViewport({ x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom, zoom });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
