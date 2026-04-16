import type { QualifiedName, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeRoute {
  id: string;
  d: string; // SVG path data
}

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

  // 4. build paths
  const out: EdgeRoute[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;
    const assign = portAssign[i]!;
    const a = portPoint(d.srcBbox, assign.sourceSide, assign.sourceRatio);
    const b = portPoint(d.tgtBbox, assign.targetSide, assign.targetRatio);
    const path = buildManhattanPath(a, assign.sourceSide, b, assign.targetSide);
    out.push({ id: d.ref.id, d: path });
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
  const srcC = centerOf(src);
  const tgtC = centerOf(tgt);
  const dx = tgtC.x - srcC.x;
  const dy = tgtC.y - srcC.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceSide: 'right', targetSide: 'left' }
      : { sourceSide: 'left', targetSide: 'right' };
  }
  return dy >= 0
    ? { sourceSide: 'bottom', targetSide: 'top' }
    : { sourceSide: 'top', targetSide: 'bottom' };
}

function centerOf(b: Bbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function portPoint(b: Bbox, side: Side, ratio: number): { x: number; y: number } {
  const r = Math.max(0.05, Math.min(0.95, ratio));
  switch (side) {
    case 'left':   return { x: b.x,           y: b.y + b.h * r };
    case 'right':  return { x: b.x + b.w,     y: b.y + b.h * r };
    case 'top':    return { x: b.x + b.w * r, y: b.y };
    case 'bottom': return { x: b.x + b.w * r, y: b.y + b.h };
  }
}

function buildManhattanPath(a: { x: number; y: number }, aSide: Side, b: { x: number; y: number }, bSide: Side): string {
  const aH = aSide === 'left' || aSide === 'right';
  const bH = bSide === 'left' || bSide === 'right';

  if (aH && bH) {
    const midX = (a.x + b.x) / 2;
    return `M${a.x},${a.y} H${midX} V${b.y} H${b.x}`;
  }
  if (!aH && !bH) {
    const midY = (a.y + b.y) / 2;
    return `M${a.x},${a.y} V${midY} H${b.x} V${b.y}`;
  }
  if (aH) {
    return `M${a.x},${a.y} H${b.x} V${b.y}`;
  }
  return `M${a.x},${a.y} V${b.y} H${b.x}`;
}
