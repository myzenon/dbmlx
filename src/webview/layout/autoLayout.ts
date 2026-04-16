import * as dagre from '@dagrejs/dagre';
import type { QualifiedName, Ref, Table } from '../../shared/types';

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Runs dagre top-down layout over all tables.
 * Returns a Map of table name → center position.
 *
 * Call only when needed (e.g., tables with no layout entry), NOT on every re-render.
 */
export function autoLayout(
  tables: Table[],
  refs: Ref[],
  sizeOf: (name: QualifiedName) => NodeSize,
): Map<QualifiedName, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  g.setGraph({
    rankdir: 'TB',
    nodesep: 48,
    ranksep: 96,
    marginx: 32,
    marginy: 32,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of tables) {
    const size = sizeOf(t.name);
    g.setNode(t.name, { width: size.width, height: size.height });
  }

  for (const r of refs) {
    if (!g.hasNode(r.source.table) || !g.hasNode(r.target.table)) continue;
    g.setEdge(r.source.table, r.target.table, { weight: 1 }, r.id);
  }

  dagre.layout(g);

  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const t of tables) {
    const node = g.node(t.name) as dagre.Node | undefined;
    if (node && typeof node.x === 'number' && typeof node.y === 'number') {
      out.set(t.name, { x: Math.round(node.x - node.width / 2), y: Math.round(node.y - node.height / 2) });
    }
  }
  return out;
}

/**
 * Estimate node height based on column count. Width fixed.
 * Later (M3 LOD), real measured sizes replace this.
 */
export function estimateSize(columnCount: number): NodeSize {
  const HEADER = 28;
  const ROW = 20;
  return { width: 240, height: HEADER + columnCount * ROW + 8 };
}
