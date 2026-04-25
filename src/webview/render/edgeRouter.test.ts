import { describe, it, expect } from 'vitest';
import { routeRefs } from './edgeRouter';
import type { Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const bbox = (x: number, y: number, w = 200, h = 300): Bbox => ({ x, y, w, h });

function makeBboxOf(map: Record<string, Bbox>) {
  return (name: string): Bbox | undefined => map[name];
}

function makeColY(resolvedCols: Record<string, Record<string, number>>) {
  return (table: string, col: string): number | undefined => resolvedCols[table]?.[col];
}

/**
 * Parse a 4-segment Manhattan path "M{sx},{sy} H{midX} V{ty} H{tx}" into its components.
 * Returns null if the string doesn't match the expected format.
 */
function parsePath(d: string): { sx: number; sy: number; midX: number; ty: number; tx: number } | null {
  const m = d.match(/^M(-?[\d.]+),(-?[\d.]+) H(-?[\d.]+) V(-?[\d.]+) H(-?[\d.]+)$/);
  if (!m) return null;
  return { sx: +m[1]!, sy: +m[2]!, midX: +m[3]!, ty: +m[4]!, tx: +m[5]! };
}

// ─── TARGET convergence (Supabase style) ────────────────────────────────────
// target table right of source tables; multiple sources target same column.
//
// target left edge = 500, colOffset = 20 → targetY = 120, tx = 500
// trunkX = 500 - 60 = 440

describe('routeRefs — TARGET-side convergence', () => {
  const TABLES = {
    target: bbox(500, 100),
    src1: bbox(0, 50),
    src2: bbox(0, 200),
    src3: bbox(0, 380),
  };
  const COL_Y = makeColY({ target: { id: 20 } });
  const TRUNK_X = 500 - 60;

  const THREE_REFS: Ref[] = [
    { id: 'r1', source: { table: 'src1', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
    { id: 'r2', source: { table: 'src2', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
    { id: 'r3', source: { table: 'src3', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
  ];

  it('paths are well-formed 4-segment Manhattan paths', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) {
      expect(parsePath(r.d), `bad path: "${r.d}"`).not.toBeNull();
    }
  });

  it('all edges share trunk X = tgtBbox.x - 60', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) {
      expect(parsePath(r.d)!.midX).toBe(TRUNK_X);
    }
  });

  it('all edges arrive at the same target Y (no PORT_SEP stagger)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    const tys = new Set(routes.map((r) => parsePath(r.d)!.ty));
    expect(tys.size).toBe(1);
    expect([...tys][0]).toBe(120);
  });

  it('source Y values differ (fan-out at source end)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    expect(new Set(routes.map((r) => parsePath(r.d)!.sy)).size).toBe(3);
  });

  it('all edges carry the same convergeGroupId', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    const ids = routes.map((r) => r.convergeGroupId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it('sourceConvergeGroupId is NOT set (wrong end)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) expect(r.sourceConvergeGroupId).toBeUndefined();
  });

  it('midSeg suppressed for drag handle', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) expect(r.midSeg).toBeUndefined();
  });
});

// ─── SOURCE convergence (real-world "domains → FK tables" style) ─────────────
// One shared source (domain) on the RIGHT; multiple FK target tables on the LEFT.
// DBML Ref direction: source = domain (1 side), target = FK table (* side).
// chooseSides: dx = tgtCenter.x - srcCenter.x < 0 → sourceSide='left', targetSide='right'
//
// domain left edge = 700, colOffset = 20 → sourceY = 720, srcX = 700
// trunkX = 700 - 60 = 640 (60px to the left of domain)

describe('routeRefs — SOURCE-side convergence', () => {
  const TABLES = {
    domain:    bbox(700, 700),           // right side — the shared "one" table
    fk_table1: bbox(0,   50),            // left side FK tables
    fk_table2: bbox(0,   250),
    fk_table3: bbox(0,   450),
  };
  const COL_Y = makeColY({ domain: { id: 20 } });
  const TRUNK_X = 700 - 60; // 640

  const THREE_REFS: Ref[] = [
    { id: 'r1', source: { table: 'domain', columns: ['id'], relation: '1' }, target: { table: 'fk_table1', columns: ['domain_id'], relation: '*' } },
    { id: 'r2', source: { table: 'domain', columns: ['id'], relation: '1' }, target: { table: 'fk_table2', columns: ['domain_id'], relation: '*' } },
    { id: 'r3', source: { table: 'domain', columns: ['id'], relation: '1' }, target: { table: 'fk_table3', columns: ['domain_id'], relation: '*' } },
  ];

  it('paths are well-formed 4-segment Manhattan paths', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) {
      expect(parsePath(r.d), `bad path: "${r.d}"`).not.toBeNull();
    }
  });

  it('all edges share trunk X = srcBbox.x - 60 (trunk near domain left edge)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) {
      expect(parsePath(r.d)!.midX).toBe(TRUNK_X);
    }
  });

  it('all edges depart from the same source Y (no PORT_SEP stagger at source)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    const sys = new Set(routes.map((r) => parsePath(r.d)!.sy));
    expect(sys.size).toBe(1);
    expect([...sys][0]).toBe(700 + 20); // domain.y + colOffset
  });

  it('target Y values differ (fan-out at target end)', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    expect(new Set(routes.map((r) => parsePath(r.d)!.ty)).size).toBe(3);
  });

  it('all edges carry the same sourceConvergeGroupId', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    const ids = routes.map((r) => r.sourceConvergeGroupId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it('convergeGroupId (target-side) is NOT set', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) expect(r.convergeGroupId).toBeUndefined();
  });

  it('midSeg suppressed for drag handle', () => {
    const routes = routeRefs(THREE_REFS, makeBboxOf(TABLES), COL_Y);
    for (const r of routes) expect(r.midSeg).toBeUndefined();
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('routeRefs — no convergence cases', () => {
  const TABLES = {
    target: bbox(500, 100),
    src1: bbox(0, 50),
    src2: bbox(0, 200),
  };

  it('single edge — no converge', () => {
    const refs: Ref[] = [
      { id: 's1', source: { table: 'src1', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
    ];
    const colY = makeColY({ target: { id: 20 } });
    const [r] = routeRefs(refs, makeBboxOf(TABLES), colY);
    expect(r!.convergeGroupId).toBeUndefined();
    expect(r!.sourceConvergeGroupId).toBeUndefined();
    expect(r!.midSeg).toBeDefined(); // drag handle present on non-converge edges
  });

  it('two edges targeting different columns — no converge', () => {
    const refs: Ref[] = [
      { id: 'a1', source: { table: 'src1', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'],    relation: '1' } },
      { id: 'a2', source: { table: 'src2', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['other'], relation: '1' } },
    ];
    const colY = makeColY({ target: { id: 20, other: 60 } });
    const routes = routeRefs(refs, makeBboxOf(TABLES), colY);
    expect(routes[0]!.convergeGroupId).toBeUndefined();
    expect(routes[1]!.convergeGroupId).toBeUndefined();
  });

  it('no colY resolver — no converge', () => {
    const refs: Ref[] = [
      { id: 'r1', source: { table: 'src1', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
      { id: 'r2', source: { table: 'src2', columns: ['fk'], relation: '*' }, target: { table: 'target', columns: ['id'], relation: '1' } },
    ];
    const routes = routeRefs(refs, makeBboxOf(TABLES)); // no resolver
    for (const r of routes) {
      expect(r.convergeGroupId).toBeUndefined();
      expect(r.sourceConvergeGroupId).toBeUndefined();
    }
  });
});
