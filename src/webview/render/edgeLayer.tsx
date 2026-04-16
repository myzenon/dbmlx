import type { QualifiedName, Ref } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import { routeRefs } from './edgeRouter';
import type { Bbox } from './spatialIndex';

interface EdgeLayerProps {
  refs: Ref[];
  positions: Map<QualifiedName, { x: number; y: number }>;
  columnCountByTable: Map<QualifiedName, number>;
}

export function EdgeLayer({ refs, positions, columnCountByTable }: EdgeLayerProps) {
  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    const pos = positions.get(name);
    if (!pos) return undefined;
    const size = estimateSize(columnCountByTable.get(name) ?? 0);
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  };
  const routes = routeRefs(refs, bboxOf);

  return (
    <svg
      class="ddd-edges"
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
      width="100%"
      height="100%"
    >
      {routes.map((r) => (
        <path key={r.id} d={r.d} class="ddd-edge" />
      ))}
    </svg>
  );
}
