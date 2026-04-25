import * as dagre from '@dagrejs/dagre';
import type { QualifiedName, Ref, Table } from '../../shared/types';

export interface NodeSize {
  width: number;
  height: number;
}

export type LayoutAlgorithm = 'top-down' | 'left-right' | 'snowflake' | 'compact';

/**
 * Runs the chosen layout algorithm over the given tables.
 * Returns a Map of table name → top-left position.
 * Call only when needed (e.g., tables with no layout entry), NOT on every re-render.
 */
export function autoLayout(
  tables: Table[],
  refs: Ref[],
  sizeOf: (name: QualifiedName) => NodeSize,
  algorithm: LayoutAlgorithm = 'top-down',
  groupAware = false,
): Map<QualifiedName, { x: number; y: number }> {
  if (tables.length === 0) return new Map();
  switch (algorithm) {
    case 'left-right': return runDagre(tables, refs, sizeOf, 'LR', groupAware);
    case 'snowflake': return runSnowflake(tables, refs, sizeOf, groupAware);
    case 'compact': return runCompact(tables, sizeOf, groupAware);
    default: return runDagre(tables, refs, sizeOf, 'TB', groupAware);
  }
}

interface DagreNode { x: number; y: number; width: number; height: number; }

function runDagre(
  tables: Table[],
  refs: Ref[],
  sizeOf: (name: QualifiedName) => NodeSize,
  rankdir: 'TB' | 'LR',
  groupAware: boolean,
): Map<QualifiedName, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: groupAware });
  g.setGraph({ rankdir, nodesep: 48, ranksep: 96, marginx: 32, marginy: 32 });
  g.setDefaultEdgeLabel(() => ({}));

  if (groupAware) {
    const groupNames = new Set<string>();
    for (const t of tables) if (t.groupName) groupNames.add(t.groupName);
    for (const gName of groupNames) g.setNode(`__grp__:${gName}`, {});
  }

  for (const t of tables) {
    const size = sizeOf(t.name);
    g.setNode(t.name, { width: size.width, height: size.height });
    if (groupAware && t.groupName) g.setParent(t.name, `__grp__:${t.groupName}`);
  }
  for (const r of refs) {
    if (!g.hasNode(r.source.table) || !g.hasNode(r.target.table)) continue;
    g.setEdge(r.source.table, r.target.table, { weight: 1 }, r.id);
  }
  dagre.layout(g);
  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const t of tables) {
    const node = g.node(t.name) as DagreNode | undefined;
    if (node && typeof node.x === 'number' && typeof node.y === 'number') {
      out.set(t.name, { x: Math.round(node.x - node.width / 2), y: Math.round(node.y - node.height / 2) });
    }
  }
  return out;
}

/** Radial layout: most-connected tables (or groups) near center, BFS rings expanding outward. */
function runSnowflake(
  tables: Table[],
  refs: Ref[],
  sizeOf: (name: QualifiedName) => NodeSize,
  groupAware: boolean,
): Map<QualifiedName, { x: number; y: number }> {
  const superOf = (t: Table) => (groupAware && t.groupName) ? `__grp__:${t.groupName}` : t.name;

  // Build adjacency between super-nodes
  const superAdj = new Map<string, Set<string>>();
  for (const t of tables) {
    const s = superOf(t);
    if (!superAdj.has(s)) superAdj.set(s, new Set());
  }
  for (const r of refs) {
    const src = tables.find((t) => t.name === r.source.table);
    const tgt = tables.find((t) => t.name === r.target.table);
    if (!src || !tgt) continue;
    const ss = superOf(src);
    const st = superOf(tgt);
    if (ss === st) continue;
    superAdj.get(ss)?.add(st);
    superAdj.get(st)?.add(ss);
  }

  const superDegree = (s: string) => superAdj.get(s)?.size ?? 0;
  const sortedSupers = [...superAdj.keys()].sort((a, b) => superDegree(b) - superDegree(a));

  if (superDegree(sortedSupers[0]!) === 0) return runCompact(tables, sizeOf, groupAware);

  // Build tablesBySuper early so we can compute bounding boxes
  const tablesBySuper = new Map<string, Table[]>();
  for (const t of tables) {
    const s = superOf(t);
    if (!tablesBySuper.has(s)) tablesBySuper.set(s, []);
    tablesBySuper.get(s)!.push(t);
  }

  // Bounding box of a super-node's mini compact grid
  function superBbox(superName: string): { w: number; h: number } {
    const members = tablesBySuper.get(superName) ?? [];
    if (members.length === 0) return { w: 220, h: 80 };
    const COLS = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const GAP_X = 32, GAP_Y = 48;
    let x = 0, y = 0, col = 0, rowH = 0, maxX = 0, maxY = 0;
    for (const t of members) {
      const sz = sizeOf(t.name);
      maxX = Math.max(maxX, x + sz.width);
      rowH = Math.max(rowH, sz.height);
      x += sz.width + GAP_X;
      col++;
      if (col >= COLS) { y += rowH + GAP_Y; maxY = y; col = 0; x = 0; rowH = 0; }
    }
    if (rowH > 0) maxY = y + rowH;
    return { w: maxX, h: maxY };
  }

  // Half-extent used for ring collision: max(w,h)/2 is a tighter bound than the
  // circumscribed circle (sqrt(w²+h²)/2), which over-estimates by up to 41%.
  const halfDiag = (b: { w: number; h: number }) => Math.max(b.w, b.h) / 2;

  // BFS on super-nodes
  const visited = new Set<string>();
  const bfsLevels: string[][] = [];
  let frontier = [sortedSupers[0]!];
  visited.add(sortedSupers[0]!);

  while (frontier.length > 0) {
    bfsLevels.push(frontier);
    const next: string[] = [];
    for (const s of frontier) {
      for (const nb of superAdj.get(s) ?? []) {
        if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }

  // Split large BFS levels into smaller rings so sin(π/n) stays large.
  // Without capping, a level of 30 nodes gives sin(π/30)≈0.1 → rAngular 10× larger.
  const RING_MAX = 8;
  const levels: string[][] = [];
  for (const lvl of bfsLevels) {
    for (let start = 0; start < lvl.length; start += RING_MAX) {
      levels.push(lvl.slice(start, start + RING_MAX));
    }
  }

  const GAP = 48; // minimum clear gap between node bboxes
  const superPos = new Map<string, { cx: number; cy: number }>();

  // Track the outer circumscribed boundary of the previous ring so the next ring
  // starts far enough to avoid radial overlap.
  let prevOuterRadius = halfDiag(superBbox(levels[0]![0]!));
  superPos.set(levels[0]![0]!, { cx: 0, cy: 0 });

  for (let li = 1; li < levels.length; li++) {
    const level = levels[li]!;
    const n = level.length;
    const bboxes = level.map((s) => superBbox(s));
    const halfDiags = bboxes.map(halfDiag);
    const maxHD = Math.max(...halfDiags);

    // Constraint 1: clear the inner ring's outer boundary
    const rRadial = prevOuterRadius + GAP + maxHD;

    // Constraint 2: adjacent nodes on this ring must not overlap
    // chord between neighbours = 2r·sin(π/n) ≥ maxHD_left + maxHD_right + GAP
    // worst-case: all max → 2r·sin(π/n) ≥ 2·maxHD + GAP
    // → r ≥ (maxHD + GAP/2) / sin(π/n)
    const rAngular = n > 1 ? (maxHD + GAP / 2) / Math.sin(Math.PI / n) : 0;

    const r = Math.max(rRadial, rAngular);

    const step = (2 * Math.PI) / n;
    for (let i = 0; i < n; i++) {
      const angle = i * step - Math.PI / 2;
      superPos.set(level[i]!, {
        cx: Math.round(r * Math.cos(angle)),
        cy: Math.round(r * Math.sin(angle)),
      });
    }

    prevOuterRadius = r + maxHD;
  }

  // Isolated super-nodes: row below the BFS bounding box
  const isolated = [...superAdj.keys()].filter((s) => !visited.has(s));
  if (isolated.length > 0) {
    let bfsMaxY = 0;
    for (const [s, pos] of superPos) {
      const b = superBbox(s);
      bfsMaxY = Math.max(bfsMaxY, pos.cy + b.h / 2);
    }
    let cx = 0;
    const bottomY = Math.round(bfsMaxY) + GAP + 60;
    for (const s of isolated) {
      const b = superBbox(s);
      superPos.set(s, { cx, cy: bottomY });
      cx += b.w + GAP;
    }
  }

  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const [s, members] of tablesBySuper) {
    const { cx, cy } = superPos.get(s) ?? { cx: 0, cy: 0 };
    for (const [name, pos] of miniCompactCentered(members, sizeOf, cx, cy)) {
      out.set(name, pos);
    }
  }
  return out;
}

/** Grid layout: tables packed into a square grid, optionally sorted by group. */
function runCompact(
  tables: Table[],
  sizeOf: (name: QualifiedName) => NodeSize,
  groupAware: boolean,
): Map<QualifiedName, { x: number; y: number }> {
  const ordered = groupAware
    ? [...tables].sort((a, b) => {
        const ga = a.groupName ?? '\xff';
        const gb = b.groupName ?? '\xff';
        return ga < gb ? -1 : ga > gb ? 1 : 0;
      })
    : tables;
  const COLS = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const GAP_X = 32;
  const GAP_Y = 48;
  const out = new Map<QualifiedName, { x: number; y: number }>();
  let x = 0, y = 0, col = 0, rowH = 0;
  for (const t of ordered) {
    const sz = sizeOf(t.name);
    out.set(t.name, { x, y });
    rowH = Math.max(rowH, sz.height);
    x += sz.width + GAP_X;
    col++;
    if (col >= COLS) { col = 0; x = 0; y += rowH + GAP_Y; rowH = 0; }
  }
  return out;
}

/** Place members in a mini compact grid, bounding-box-centered at (cx, cy). */
function miniCompactCentered(
  members: Table[],
  sizeOf: (name: QualifiedName) => NodeSize,
  cx: number,
  cy: number,
): Map<QualifiedName, { x: number; y: number }> {
  const COLS = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const GAP_X = 32, GAP_Y = 48;
  let x = 0, y = 0, col = 0, rowH = 0;
  const rel = new Map<QualifiedName, { x: number; y: number }>();
  for (const t of members) {
    const sz = sizeOf(t.name);
    rel.set(t.name, { x, y });
    rowH = Math.max(rowH, sz.height);
    x += sz.width + GAP_X;
    col++;
    if (col >= COLS) { col = 0; x = 0; y += rowH + GAP_Y; rowH = 0; }
  }
  // Compute bbox width/height
  let maxX = 0, maxY = 0;
  for (const [name, pos] of rel) {
    const sz = sizeOf(name);
    if (pos.x + sz.width > maxX) maxX = pos.x + sz.width;
    if (pos.y + sz.height > maxY) maxY = pos.y + sz.height;
  }
  const offsetX = cx - maxX / 2;
  const offsetY = cy - maxY / 2;
  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const [name, pos] of rel) {
    out.set(name, { x: Math.round(offsetX + pos.x), y: Math.round(offsetY + pos.y) });
  }
  return out;
}

/** Geometric constants used across router, renderer, and layout. MUST match CSS `.ddd-table__header`, `.ddd-table__col`, `.ddd-table__cols`. */
export const TABLE_HEADER_H = 28;
export const TABLE_ROW_H = 20;
export const TABLE_WIDTH = 240;
export const TABLE_BOTTOM_PAD = 8; // matches .ddd-table__cols padding (4 top + 4 bottom)

/**
 * Estimate node height based on column count. Width fixed.
 * Use tableActualHeight when you have a Table object (accounts for modify rows).
 */
export function estimateSize(columnCount: number): NodeSize {
  return { width: TABLE_WIDTH, height: TABLE_HEADER_H + columnCount * TABLE_ROW_H + TABLE_BOTTOM_PAD };
}

/** Actual rendered height of a table, counting [modify] columns as 2 rows. */
export function tableActualHeight(t: Table): number {
  let h = TABLE_HEADER_H + TABLE_BOTTOM_PAD;
  for (const col of t.columns) {
    h += t.columnChanges?.[col.name]?.kind === 'modify' ? TABLE_ROW_H * 2 : TABLE_ROW_H;
  }
  return h;
}

/** Y offset (from table top) for the vertical center of a column row at `index`.
 *  Assumes uniform row height — use colRowY when you have a Table object. */
export function columnCenterY(index: number): number {
  return TABLE_HEADER_H + 4 + index * TABLE_ROW_H + TABLE_ROW_H / 2;
}

/** Y offset (from table top) of the top of the column row at `colIndex`.
 *  Accounts for [modify] columns occupying two rows. */
export function colRowY(t: Table, colIndex: number): number {
  let y = TABLE_HEADER_H + 4;
  for (let i = 0; i < colIndex; i++) {
    y += t.columnChanges?.[t.columns[i]!.name]?.kind === 'modify' ? TABLE_ROW_H * 2 : TABLE_ROW_H;
  }
  return y;
}
