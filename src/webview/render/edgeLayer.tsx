import type { QualifiedName, Ref, Schema } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { routeRefs } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import { useAppStore } from '../state/store';
import { startEdgeDrag } from '../drag/dragController';

interface GroupSize {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeLayerProps {
  refs: Ref[];
  positions: Map<QualifiedName, { x: number; y: number }>;
  tablesByName: Map<QualifiedName, Schema['tables'][number]>;
  groupSizes?: GroupSize[];
  worldBbox: { x: number; y: number; w: number; h: number };
}

const GROUP_PREFIX = '__group__:';

export function EdgeLayer({ refs, positions, tablesByName, groupSizes, worldBbox }: EdgeLayerProps) {
  const edgeOffsets = useAppStore((s) => s.edgeOffsets);
  const showCardinalityLabels = useAppStore((s) => s.showCardinalityLabels);

  const groupByName = new Map<string, GroupSize>();
  if (groupSizes) for (const g of groupSizes) groupByName.set(g.name, g);

  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    if (name.startsWith(GROUP_PREFIX)) {
      const groupName = name.slice(GROUP_PREFIX.length);
      const g = groupByName.get(groupName);
      if (!g) return undefined;
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    }
    const pos = positions.get(name);
    if (!pos) return undefined;
    const t = tablesByName.get(name);
    const size = estimateSize(t?.columns.length ?? 0);
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  };

  const columnY = (tableName: QualifiedName, column: string): number | undefined => {
    const t = tablesByName.get(tableName);
    if (!t) return undefined;
    const idx = t.columns.findIndex((c) => c.name === column);
    if (idx < 0) return undefined;
    return columnCenterY(idx);
  };

  const routes = routeRefs(refs, bboxOf, columnY, (id) => edgeOffsets.get(id));

  const refById = new Map<string, Ref>();
  for (const r of refs) refById.set(r.id, r);

  // Track occupied label slots (bucketed to 10px grid) so colliding labels go below instead of above.
  const usedLabelSlots = new Set<string>();
  const labelY = (x: number, y: number): number => {
    const key = `${Math.round(x / 4)},${Math.round(y / 10)}`;
    if (usedLabelSlots.has(key)) return y + 12;
    usedLabelSlots.add(key);
    return y - 5;
  };

  return (
    <svg
      class="ddd-edges"
      width={worldBbox.w}
      height={worldBbox.h}
      viewBox={`${worldBbox.x} ${worldBbox.y} ${worldBbox.w} ${worldBbox.h}`}
      style={{
        position: 'absolute',
        left: `${worldBbox.x}px`,
        top: `${worldBbox.y}px`,
      }}
    >
      <defs>
        <marker id="ddd-mk-many" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
          <path d="M2,2 L10,6 L2,10 M10,2 L10,10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </marker>
        <marker id="ddd-mk-one" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
          <path d="M10,2 L10,10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </marker>
        <marker id="ddd-mk-many-s" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
          <path d="M10,2 L2,6 L10,10 M2,2 L2,10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </marker>
        <marker id="ddd-mk-one-s" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
          <path d="M2,2 L2,10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </marker>
      </defs>
      {routes.map((r) => {
        const ref = refById.get(r.id);
        const startMarker = ref?.source.relation === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)';
        const endMarker = ref?.target.relation === '*' ? 'url(#ddd-mk-many)' : 'url(#ddd-mk-one)';
        const srcLabel = ref?.source.relation === '*' ? 'N' : '1';
        const tgtLabel = ref?.target.relation === '*' ? 'N' : '1';
        const srcLabelX = r.source.x + (r.source.side === 'right' ? 16 : -16);
        const tgtLabelX = r.target.x + (r.target.side === 'right' ? 16 : -16);
        const srcLabelY = labelY(srcLabelX, r.source.y);
        const tgtLabelY = labelY(tgtLabelX, r.target.y);
        return (
          <g key={r.id}>
            <path
              d={r.d}
              class="ddd-edge"
              markerStart={startMarker}
              markerEnd={endMarker}
            />
            {showCardinalityLabels ? <text class="ddd-edge-label" x={srcLabelX} y={srcLabelY}>{srcLabel}</text> : null}
            {showCardinalityLabels ? <text class="ddd-edge-label" x={tgtLabelX} y={tgtLabelY}>{tgtLabel}</text> : null}
            {r.midSeg ? (
              <line
                class="ddd-edge-handle"
                x1={r.midSeg.x1}
                y1={r.midSeg.y1}
                x2={r.midSeg.x2}
                y2={r.midSeg.y2}
                onPointerDown={(e) => startEdgeDrag(r.id, r.midSeg!.axis, e as unknown as PointerEvent, e.currentTarget as unknown as HTMLElement)}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
