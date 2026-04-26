import type { QualifiedName, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeRoute {
  id: string;
  d: string;
  /** Middle segment of the Manhattan path, exposed so callers can render a draggable handle over it. */
  midSeg?: { x1: number; y1: number; x2: number; y2: number; axis: 'v' | 'h' };
  /** Resolved port coordinates (world space), useful for hit-testing / highlighting. */
  source: { x: number; y: number; side: Side };
  target: { x: number; y: number; side: Side };
  /**
   * Set when this edge belongs to a convergence group (≥2 edges sharing the same hub column).
   * The hub is the relation='1' endpoint. Edges from both inline refs (hub=source) and
   * top-level Ref: declarations (hub=target) are merged into the same group.
   */
  convergeGroupId?: string;
  /**
   * True when the hub (relation='1') endpoint is at the source end of this edge.
   * False when the hub is at the target end.
   * Used by renderers to know which arrowhead to suppress for non-first group members.
   */
  convergeHubIsSource?: boolean;
  /**
   * The world-space point where this edge's converge trunk meets the fanning-out branch.
   * Renderers should draw a filled junction dot here (once per group) so the user can
   * clearly see which table is the shared hub vs the individual spokes.
   */
  convergeJunction?: { x: number; y: number };
}

/** Optional per-endpoint port override — used to align edges with the PK/FK column row. */
export type ColumnYResolver = (table: QualifiedName, column: string) => number | undefined;

/** User-adjusted offsets to the middle segment, keyed by ref id. */
export type EdgeOffsetResolver = (refId: string) => { dx?: number; dy?: number } | undefined;

interface PortAssignment {
  sourceSide: Side;
  targetSide: Side;
  sourceRatio: number; // 0..1 along the side
  targetRatio: number;
}

/**
 * Routes every ref orthogonally (Manhattan, 2-elbow max) and distributes
 * ports along each table side to minimize overlap when multiple edges share a side.
 *
 * Returns an ordered list matching refs[] order — callers can filter by visibility.
 */
export function routeRefs(
  refs: Ref[],
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  columnYResolver?: ColumnYResolver,
  offsetResolver?: EdgeOffsetResolver,
  merge = true,
): EdgeRoute[] {
  // 1. decide sides for each edge
  const decisions: Array<{ ref: Ref; srcBbox: Bbox; tgtBbox: Bbox; sourceSide: Side; targetSide: Side } | null> = [];
  for (const r of refs) {
    const srcBbox = bboxOf(r.source.table);
    const tgtBbox = bboxOf(r.target.table);
    if (!srcBbox || !tgtBbox) {
      decisions.push(null);
      continue;
    }
    const { sourceSide, targetSide } = chooseSides(srcBbox, tgtBbox);
    decisions.push({ ref: r, srcBbox, tgtBbox, sourceSide, targetSide });
  }

  // 2. group by (table, side) to compute port offsets
  type Group = Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>;
  const groups = new Map<string, Group>();

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;

    const srcKey = `${d.ref.source.table}|${d.sourceSide}`;
    const tgtKey = `${d.ref.target.table}|${d.targetSide}`;
    const srcOrientation = orientationOfSide(d.sourceSide);
    const tgtOrientation = orientationOfSide(d.targetSide);

    const tgtCenter = centerOf(d.tgtBbox);
    const srcCenter = centerOf(d.srcBbox);

    const srcOther = srcOrientation === 'v' ? tgtCenter.y : tgtCenter.x;
    const tgtOther = tgtOrientation === 'v' ? srcCenter.y : srcCenter.x;

    pushGroup(groups, srcKey, { edgeIdx: i, role: 'source', otherCenter: srcOther, orientation: srcOrientation });
    pushGroup(groups, tgtKey, { edgeIdx: i, role: 'target', otherCenter: tgtOther, orientation: tgtOrientation });
  }

  // 3. assign port ratios: sort group by otherCenter, evenly distribute
  const portAssign: PortAssignment[] = decisions.map(() => ({
    sourceSide: 'right',
    targetSide: 'left',
    sourceRatio: 0.5,
    targetRatio: 0.5,
  }));

  for (const [, entries] of groups) {
    entries.sort((a, b) => a.otherCenter - b.otherCenter);
    const count = entries.length;
    for (let i = 0; i < count; i++) {
      const entry = entries[i]!;
      const ratio = (i + 1) / (count + 1);
      const d = decisions[entry.edgeIdx]!;
      const assign = portAssign[entry.edgeIdx]!;
      assign.sourceSide = d.sourceSide;
      assign.targetSide = d.targetSide;
      if (entry.role === 'source') assign.sourceRatio = ratio;
      else assign.targetRatio = ratio;
    }
  }

  // 4. resolve port points and detect same-table-pair groups for midX staggering
  const BUNDLE_SEP = 16; // px between parallel edges on the same pair of tables
  const PORT_SEP = 6;    // px between edges sharing the exact same column port

  // Compute raw port points for every edge.
  // convergeKey is set when the hub (relation='1') endpoint has a resolved column Y.
  // Using the hub endpoint normalises inline refs (hub=source, reversed by @dbml/core)
  // and top-level Ref: declarations (hub=target) into the same convergence group.
  type PortedEdge = {
    idx: number;
    a: { x: number; y: number };
    b: { x: number; y: number };
    userDx: number;
    convergeKey?: string;  // hub-based key; same string for inline and top-level refs
    hubIsSource?: boolean; // true when the hub is the source endpoint of this edge
  };
  const ported: Array<PortedEdge | null> = [];

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) { ported.push(null); continue; }
    const assign = portAssign[i]!;

    let sourceY: number | undefined;
    let targetY: number | undefined;
    let convergeKey: string | undefined;
    let hubIsSource: boolean | undefined;

    if (columnYResolver) {
      // Pin source column Y (if available) — used for FK-end alignment
      if (assign.sourceSide === 'left' || assign.sourceSide === 'right') {
        const sourceCol = d.ref.source.columns[0];
        const offset = sourceCol ? columnYResolver(d.ref.source.table, sourceCol) : undefined;
        if (offset !== undefined) sourceY = d.srcBbox.y + offset;
      }
      // Pin target column Y (if available)
      if (assign.targetSide === 'left' || assign.targetSide === 'right') {
        const targetCol = d.ref.target.columns[0];
        const offset = targetCol ? columnYResolver(d.ref.target.table, targetCol) : undefined;
        if (offset !== undefined) targetY = d.tgtBbox.y + offset;
      }
      // Build a unified convergence key based on the hub (relation='1') endpoint.
      // This ensures inline refs (hub=source) and top-level Ref: (hub=target) are in the same group.
      const srcIsHub = d.ref.source.relation === '1';
      if (srcIsHub && sourceY !== undefined) {
        convergeKey = `${d.ref.source.table}|${assign.sourceSide}|${d.ref.source.columns[0]}`;
        hubIsSource = true;
      } else if (!srcIsHub && targetY !== undefined) {
        convergeKey = `${d.ref.target.table}|${assign.targetSide}|${d.ref.target.columns[0]}`;
        hubIsSource = false;
      }
    }

    const a = portPoint(d.srcBbox, assign.sourceSide, assign.sourceRatio, sourceY);
    const b = portPoint(d.tgtBbox, assign.targetSide, assign.targetRatio, targetY);
    const userDx = offsetResolver?.(d.ref.id)?.dx ?? 0;
    ported.push({ idx: i, a, b, userDx, convergeKey, hubIsSource });
  }

  // Build unified converge groups (hub-based). Only groups with ≥2 members are active.
  const convergeBuckets = new Map<string, number[]>();
  if (merge) {
    for (let i = 0; i < ported.length; i++) {
      const p = ported[i];
      if (!p?.convergeKey) continue;
      let bucket = convergeBuckets.get(p.convergeKey);
      if (!bucket) { bucket = []; convergeBuckets.set(p.convergeKey, bucket); }
      bucket.push(i);
    }
  }
  const convergeGroupOf = new Map<number, string>();
  for (const [key, idxs] of convergeBuckets) {
    if (idxs.length < 2) continue;
    for (const i of idxs) convergeGroupOf.set(i, key);
  }

  // Stagger Y for edges sharing the exact same source port — skip converge members whose
  // hub is at the source (they must stay at the same Y to form the shared trunk head).
  const srcPortGroups = new Map<string, number[]>();
  for (let i = 0; i < ported.length; i++) {
    const p = ported[i];
    if (!p) continue;
    const key = `${p.a.x},${p.a.y}`;
    if (!srcPortGroups.has(key)) srcPortGroups.set(key, []);
    srcPortGroups.get(key)!.push(i);
  }
  for (const [, idxs] of srcPortGroups) {
    if (idxs.length < 2) continue;
    const toStagger = idxs.filter((i) => !(convergeGroupOf.has(i) && ported[i]?.hubIsSource));
    const n = toStagger.length;
    for (let i = 0; i < n; i++) {
      ported[toStagger[i]!]!.a.y += Math.round((i - (n - 1) / 2) * PORT_SEP);
    }
  }

  // Same for target ports — skip converge members whose hub is at the target.
  const tgtPortGroups = new Map<string, number[]>();
  for (let i = 0; i < ported.length; i++) {
    const p = ported[i];
    if (!p) continue;
    const key = `${p.b.x},${p.b.y}`;
    if (!tgtPortGroups.has(key)) tgtPortGroups.set(key, []);
    tgtPortGroups.get(key)!.push(i);
  }
  for (const [, idxs] of tgtPortGroups) {
    if (idxs.length < 2) continue;
    const toStagger = idxs.filter((i) => !(convergeGroupOf.has(i) && !ported[i]?.hubIsSource));
    const n = toStagger.length;
    for (let i = 0; i < n; i++) {
      ported[toStagger[i]!]!.b.y += Math.round((i - (n - 1) / 2) * PORT_SEP);
    }
  }

  // Stagger midX for edges that connect the same pair of table sides
  const tablePairGroups = new Map<string, number[]>();
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d || !ported[i]) continue;
    const assign = portAssign[i]!;
    const key = `${d.ref.source.table}|${d.ref.target.table}|${assign.sourceSide}|${assign.targetSide}`;
    if (!tablePairGroups.has(key)) tablePairGroups.set(key, []);
    tablePairGroups.get(key)!.push(i);
  }
  const midXOffset = new Map<number, number>();
  for (const [, idxs] of tablePairGroups) {
    if (idxs.length < 2) continue;
    const n = idxs.length;
    for (let i = 0; i < n; i++) {
      midXOffset.set(idxs[i]!, Math.round((i - (n - 1) / 2) * BUNDLE_SEP));
    }
  }

  // Compute a shared trunk X for each converge group.
  // The trunk sits TRUNK_OFFSET px outside the hub table edge.
  const TRUNK_OFFSET = 60;
  const convergeMidX = new Map<number, number>();
  for (const [, idxs] of convergeBuckets) {
    if (idxs.length < 2) continue;
    const firstIdx = idxs[0]!;
    const first = ported[firstIdx]!;
    const assign = portAssign[firstIdx]!;
    const hubAtSrc = first.hubIsSource;
    const trunkX = hubAtSrc
      ? (assign.sourceSide === 'left' ? first.a.x - TRUNK_OFFSET : first.a.x + TRUNK_OFFSET)
      : (assign.targetSide === 'left' ? first.b.x - TRUNK_OFFSET : first.b.x + TRUNK_OFFSET);
    for (const i of idxs) convergeMidX.set(i, trunkX);
  }

  // 4b. De-coincide convergence trunks: when multiple convergence groups share the same trunkX,
  // stagger the trunks apart so they don't draw on top of each other.
  const TRUNK_STAGGER = 12;
  const trunkXGroups = new Map<number, number[][]>(); // trunkX → list of per-group edge-index arrays
  for (const [, idxs] of convergeBuckets) {
    if (idxs.length < 2) continue;
    const trunkX = convergeMidX.get(idxs[0]!)!;
    let g = trunkXGroups.get(trunkX);
    if (!g) { g = []; trunkXGroups.set(trunkX, g); }
    g.push(idxs);
  }
  for (const [, groups] of trunkXGroups) {
    if (groups.length < 2) continue;
    const n = groups.length;
    for (let j = 0; j < n; j++) {
      const dx = Math.round((j - (n - 1) / 2) * TRUNK_STAGGER);
      for (const i of groups[j]!) convergeMidX.set(i, convergeMidX.get(i)! + dx);
    }
  }

  // 4c. De-coincide: stagger non-convergence edges whose vertical segments share the same
  // midX AND have overlapping Y ranges. Prevents unrelated FK lines from appearing merged
  // when the layout engine places unrelated tables at the same X rank.
  const COINCIDE_SEP = 8;
  const tentativeMidX: Array<number | null> = ported.map((p, i) => {
    if (!p) return null;
    if (convergeGroupOf.has(i)) return convergeMidX.get(i)!;
    return Math.round((p.a.x + p.b.x) / 2 + p.userDx + (midXOffset.get(i) ?? 0));
  });

  const coincideMap = new Map<number, number[]>();
  for (let i = 0; i < tentativeMidX.length; i++) {
    const mx = tentativeMidX[i];
    if (mx == null || convergeGroupOf.has(i)) continue;
    const mxKey: number = mx;
    let bucket = coincideMap.get(mxKey);
    if (!bucket) { bucket = []; coincideMap.set(mxKey, bucket); }
    bucket.push(i);
  }

  const coincideExtra = new Map<number, number>();
  for (const [, idxs] of coincideMap) {
    if (idxs.length < 2) continue;
    let hasOverlap = false;
    outer: for (let j = 0; j < idxs.length; j++) {
      const pj = ported[idxs[j]!]!;
      const jMinY = Math.min(pj.a.y, pj.b.y), jMaxY = Math.max(pj.a.y, pj.b.y);
      for (let k = j + 1; k < idxs.length; k++) {
        const pk = ported[idxs[k]!]!;
        const kMinY = Math.min(pk.a.y, pk.b.y), kMaxY = Math.max(pk.a.y, pk.b.y);
        if (Math.min(jMaxY, kMaxY) > Math.max(jMinY, kMinY)) { hasOverlap = true; break outer; }
      }
    }
    if (!hasOverlap) continue;
    const n = idxs.length;
    for (let j = 0; j < n; j++) coincideExtra.set(idxs[j]!, Math.round((j - (n - 1) / 2) * COINCIDE_SEP));
  }

  // 5. build paths
  const out: EdgeRoute[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const p = ported[i];
    if (!d || !p) continue;
    const assign = portAssign[i]!;

    const { a, b, userDx } = p;
    const isConverge = convergeGroupOf.has(i);

    const midX = isConverge
      ? convergeMidX.get(i)!
      : Math.round((a.x + b.x) / 2 + userDx + (midXOffset.get(i) ?? 0) + (coincideExtra.get(i) ?? 0));

    const path = `M${a.x},${a.y} H${midX} V${b.y} H${b.x}`;
    // Converge edges share a fixed trunk — suppress drag handle so edges move together.
    const midSeg = isConverge ? undefined : { x1: midX, y1: a.y, x2: midX, y2: b.y, axis: 'v' as const };

    // Junction dot at the corner where the shared trunk meets the individual spokes.
    // Hub-at-source: trunk departs from shared hubY (a.y) → junction at (trunkX, a.y).
    // Hub-at-target: spokes converge to hubY (b.y)     → junction at (trunkX, b.y).
    let convergeJunction: { x: number; y: number } | undefined;
    if (isConverge) {
      convergeJunction = p.hubIsSource ? { x: midX, y: a.y } : { x: midX, y: b.y };
    }

    out.push({
      id: d.ref.id,
      d: path,
      midSeg,
      source: { ...a, side: assign.sourceSide },
      target: { ...b, side: assign.targetSide },
      convergeGroupId: convergeGroupOf.get(i),
      convergeHubIsSource: isConverge ? p.hubIsSource : undefined,
      convergeJunction,
    });
  }
  return out;
}

function pushGroup(
  groups: Map<string, Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>>,
  key: string,
  entry: { edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' },
): void {
  let arr = groups.get(key);
  if (!arr) {
    arr = [];
    groups.set(key, arr);
  }
  arr.push(entry);
}

function orientationOfSide(side: Side): 'h' | 'v' {
  return side === 'left' || side === 'right' ? 'h' : 'v';
}

function chooseSides(src: Bbox, tgt: Bbox): { sourceSide: Side; targetSide: Side } {
  // dbdiagram-style: always exit/enter horizontally. Column-aligned ports only make sense horizontally,
  // so forcing left/right for every edge keeps routing predictable and aligned with column rows.
  const srcC = centerOf(src);
  const tgtC = centerOf(tgt);
  const dx = tgtC.x - srcC.x;
  return dx >= 0
    ? { sourceSide: 'right', targetSide: 'left' }
    : { sourceSide: 'left', targetSide: 'right' };
}

function centerOf(b: Bbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function portPoint(b: Bbox, side: Side, ratio: number, overrideY?: number, overrideX?: number): { x: number; y: number } {
  const r = Math.max(0.05, Math.min(0.95, ratio));
  switch (side) {
    case 'left':   return { x: b.x,           y: overrideY ?? b.y + b.h * r };
    case 'right':  return { x: b.x + b.w,     y: overrideY ?? b.y + b.h * r };
    case 'top':    return { x: overrideX ?? b.x + b.w * r, y: b.y };
    case 'bottom': return { x: overrideX ?? b.x + b.w * r, y: b.y + b.h };
  }
}

// buildManhattanPath is now inlined in routeRefs because chooseSides forces H-V-H only.
