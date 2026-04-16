import { store } from '../state/store';

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
  // Zoom around pointer: keep world point under cursor stationary.
  const world = { x: (screen.x - vp.x) / vp.zoom, y: (screen.y - vp.y) / vp.zoom };
  const nextX = screen.x - world.x * nextZoom;
  const nextY = screen.y - world.y * nextZoom;
  state.setViewport({ x: nextX, y: nextY, zoom: nextZoom });
}

export function panBy(dx: number, dy: number): void {
  const state = store.getState();
  state.setViewport({ x: state.viewport.x + dx, y: state.viewport.y + dy });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
