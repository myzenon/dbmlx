import { store, toTableLayoutRecord } from '../state/store';
import { postToHost } from '../vscode';

/**
 * Pointer-driven drag for a table node.
 *
 * During drag:
 *   - Mutates the dragged node's transform directly (GPU compositing, no Preact re-render for the move).
 *   - Writes to the store on every frame so Preact re-renders edges + LOD in sync with the move.
 *     For large diagrams this stays at 60fps because only the visible subset renders (M3 culling).
 *
 * On drop:
 *   - Final store commit.
 *   - Debounced layout:persist message to the host (M5: writes sidecar JSON).
 */

let active = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 300;

export function startDrag(e: PointerEvent, tableName: string, node: HTMLElement): void {
  if (active || e.button !== 0) return;
  const state = store.getState();
  const pos = state.positions.get(tableName);
  if (!pos) return;

  active = true;
  e.stopPropagation();
  e.preventDefault();

  const pointerStartX = e.clientX;
  const pointerStartY = e.clientY;
  const originX = pos.x;
  const originY = pos.y;

  node.style.willChange = 'transform';
  try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-dragging');

  const onMove = (ev: PointerEvent) => {
    const currentZoom = store.getState().viewport.zoom;
    const dx = (ev.clientX - pointerStartX) / currentZoom;
    const dy = (ev.clientY - pointerStartY) / currentZoom;
    const nx = Math.round(originX + dx);
    const ny = Math.round(originY + dy);
    node.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
    store.getState().setTablePos(tableName, nx, ny);
  };

  const onUp = (ev: PointerEvent) => {
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    node.style.willChange = '';
    try { node.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-dragging');
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = store.getState();
    postToHost({
      type: 'layout:persist',
      payload: {
        tables: toTableLayoutRecord(state.positions),
        groups: state.groups,
        viewport: state.viewport,
        version: 1,
      },
    });
  }, PERSIST_DEBOUNCE_MS);
}
