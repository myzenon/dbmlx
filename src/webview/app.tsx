import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useAppStore } from './state/store';
import { autoLayout, estimateSize } from './layout/autoLayout';
import { TableNode } from './render/tableNode';
import { EdgeLayer } from './render/edgeLayer';
import { panBy, zoomAt } from './render/viewport';
import { SpatialIndex } from './render/spatialIndex';
import { lodForZoom } from './render/lod';
import type { QualifiedName, WebviewToHost } from '../shared/types';

interface AppProps {
  post: (msg: WebviewToHost) => void;
}

const VISIBILITY_MARGIN = 256; // world px of slack around viewport

export function App(_props: AppProps) {
  const schema = useAppStore((s) => s.schema);
  const parseError = useAppStore((s) => s.parseError);
  const positions = useAppStore((s) => s.positions);
  const viewport = useAppStore((s) => s.viewport);
  const ready = useAppStore((s) => s.ready);

  useEffect(() => {
    if (!ready) return;
    const missing = schema.tables.filter((t) => !positions.has(t.name));
    if (missing.length === 0) return;

    const sizeOf = (name: QualifiedName) => {
      const t = schema.tables.find((x) => x.name === name);
      return estimateSize(t?.columns.length ?? 0);
    };
    const layoutTargets = positions.size === 0 ? schema.tables : missing;
    const laidOut = autoLayout(layoutTargets, schema.refs, sizeOf);
    const entries: Array<[QualifiedName, { x: number; y: number }]> = [];
    for (const [name, pos] of laidOut) entries.push([name, pos]);
    if (entries.length > 0) store.getState().setPositionsBatch(entries);
  }, [schema, ready]);

  const columnCountByTable = useMemo(() => {
    const m = new Map<QualifiedName, number>();
    for (const t of schema.tables) m.set(t.name, t.columns.length);
    return m;
  }, [schema]);

  const spatialIndex = useMemo(() => {
    const idx = new SpatialIndex();
    for (const t of schema.tables) {
      const pos = positions.get(t.name);
      if (!pos) continue;
      const size = estimateSize(t.columns.length);
      idx.insert(t.name, { x: pos.x, y: pos.y, w: size.width, h: size.height });
    }
    return idx;
  }, [schema, positions]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportRect, setViewportRect] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cr = entry.contentRect;
      setViewportRect({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.pow(1.0015, -e.deltaY);
      zoomAt(screen, factor);
    };

    let panning = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-panning');
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!panning) return;
      panBy(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      el.classList.remove('is-panning');
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  const visibleNames = useMemo(() => {
    if (viewportRect.w === 0 || viewportRect.h === 0) return null;
    const worldBbox = {
      x: (-viewport.x) / viewport.zoom - VISIBILITY_MARGIN,
      y: (-viewport.y) / viewport.zoom - VISIBILITY_MARGIN,
      w: viewportRect.w / viewport.zoom + VISIBILITY_MARGIN * 2,
      h: viewportRect.h / viewport.zoom + VISIBILITY_MARGIN * 2,
    };
    return spatialIndex.query(worldBbox);
  }, [spatialIndex, viewport, viewportRect]);

  const lod = lodForZoom(viewport.zoom);

  if (!ready) {
    return <div class="ddd-empty">loading…</div>;
  }

  if (schema.tables.length === 0 && !parseError) {
    return <div class="ddd-empty">empty DBML — define a Table to see it here.</div>;
  }

  const worldTransform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  const visibleRefs = visibleNames
    ? schema.refs.filter((r) => visibleNames.has(r.source.table) || visibleNames.has(r.target.table))
    : schema.refs;

  return (
    <>
      <div class="ddd-viewport" ref={viewportRef}>
        <div class="ddd-world" style={{ transform: worldTransform }}>
          <EdgeLayer refs={visibleRefs} positions={positions} columnCountByTable={columnCountByTable} />
          {schema.tables.map((t) => {
            if (visibleNames && !visibleNames.has(t.name)) return null;
            const pos = positions.get(t.name);
            if (!pos) return null;
            return <TableNode key={t.name} table={t} x={pos.x} y={pos.y} lod={lod} />;
          })}
        </div>
      </div>
      {parseError ? (
        <div class="ddd-banner" title={parseError.message}>
          Parse error
          {parseError.line != null ? ` (line ${parseError.line})` : ''}: {parseError.message}
        </div>
      ) : null}
      <div class="ddd-statusbar">
        {visibleNames ? visibleNames.size : schema.tables.length}/{schema.tables.length} tables · {schema.refs.length} refs · zoom {Math.round(viewport.zoom * 100)}% · LOD {lod}
      </div>
    </>
  );
}
