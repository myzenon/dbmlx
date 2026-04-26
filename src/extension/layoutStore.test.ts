import { vi, describe, it, expect } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  workspace: {
    fs: { readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn() },
  },
}));

import { parseLayout, serializeLayout, emptyLayout } from './layoutStore';

// ── emptyLayout ───────────────────────────────────────────────────────────

describe('emptyLayout', () => {
  it('returns version 1 with empty collections', () => {
    const l = emptyLayout();
    expect(l.version).toBe(1);
    expect(l.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(l.tables).toEqual({});
    expect(l.groups).toEqual({});
    expect(l.edges).toEqual({});
    expect(l.viewSettings).toBeUndefined();
  });
});

// ── parseLayout ───────────────────────────────────────────────────────────

describe('parseLayout', () => {
  it('returns emptyLayout for invalid JSON', () => {
    expect(parseLayout('not json')).toMatchObject({ version: 1, tables: {}, groups: {}, edges: {} });
    expect(parseLayout('')).toMatchObject({ version: 1, tables: {} });
  });

  it('returns emptyLayout for non-object JSON', () => {
    expect(parseLayout('null')).toMatchObject({ version: 1, tables: {} });
    expect(parseLayout('"string"')).toMatchObject({ version: 1, tables: {} });
    expect(parseLayout('42')).toMatchObject({ version: 1, tables: {} });
  });

  it('parses viewport values', () => {
    const text = JSON.stringify({
      viewport: { x: 10, y: -20, zoom: 1.5 },
      tables: {}, groups: {}, edges: {},
    });
    const layout = parseLayout(text);
    expect(layout.viewport).toEqual({ x: 10, y: -20, zoom: 1.5 });
  });

  it('rounds viewport integers, keeps zoom precision', () => {
    const text = JSON.stringify({
      viewport: { x: 10.7, y: 20.3, zoom: 0.75 },
      tables: {}, groups: {}, edges: {},
    });
    const layout = parseLayout(text);
    expect(layout.viewport.x).toBe(11);
    expect(layout.viewport.y).toBe(20);
    expect(layout.viewport.zoom).toBe(0.75);
  });

  it('uses fallback viewport when missing', () => {
    const layout = parseLayout(JSON.stringify({ tables: {}, groups: {}, edges: {} }));
    expect(layout.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('parses table x/y positions', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { 'public.users': { x: 100, y: 200 } },
      groups: {}, edges: {},
    });
    const layout = parseLayout(text);
    expect(layout.tables['public.users']).toEqual({ x: 100, y: 200 });
  });

  it('rounds table coordinates to integers', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { 't': { x: 10.7, y: 20.3 } },
      groups: {}, edges: {},
    });
    const layout = parseLayout(text);
    expect(layout.tables['t']?.x).toBe(11);
    expect(layout.tables['t']?.y).toBe(20);
  });

  it('parses table hidden flag', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { 'public.users': { x: 0, y: 0, hidden: true } },
      groups: {}, edges: {},
    });
    expect(parseLayout(text).tables['public.users']?.hidden).toBe(true);
  });

  it('does not set hidden on table when hidden:false', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { 'public.users': { x: 0, y: 0, hidden: false } },
      groups: {}, edges: {},
    });
    expect(parseLayout(text).tables['public.users']?.hidden).toBeUndefined();
  });

  it('parses table color', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { 'public.users': { x: 0, y: 0, color: '#ff0000' } },
      groups: {}, edges: {},
    });
    expect(parseLayout(text).tables['public.users']?.color).toBe('#ff0000');
  });

  it('parses group collapsed and color', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {},
      groups: { billing: { collapsed: true, color: '#aabbcc' } },
      edges: {},
    });
    expect(parseLayout(text).groups['billing']).toEqual({ collapsed: true, color: '#aabbcc' });
  });

  it('parses group hidden', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {},
      groups: { auth: { hidden: true } },
      edges: {},
    });
    expect(parseLayout(text).groups['auth']).toEqual({ hidden: true });
  });

  it('parses empty group as empty object', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {},
      groups: { core: {} },
      edges: {},
    });
    expect(parseLayout(text).groups['core']).toEqual({});
  });

  it('parses edges with dx and dy', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {},
      edges: { 'e1': { dx: 10, dy: -5 } },
    });
    expect(parseLayout(text).edges?.['e1']).toEqual({ dx: 10, dy: -5 });
  });

  it('parses edge with only dx', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {},
      edges: { 'e1': { dx: 20 } },
    });
    expect(parseLayout(text).edges?.['e1']).toEqual({ dx: 20 });
  });

  it('excludes edge entries with neither dx nor dy', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {},
      edges: { 'e1': { note: 'nothing' } },
    });
    expect(parseLayout(text).edges?.['e1']).toBeUndefined();
  });

  it('rounds edge offsets to integers', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {},
      edges: { 'e1': { dx: 10.6, dy: -5.4 } },
    });
    const edges = parseLayout(text).edges ?? {};
    expect(edges['e1']?.dx).toBe(11);
    expect(edges['e1']?.dy).toBe(-5);
  });

  it('parses viewSettings showOnlyPkFk', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {},
      viewSettings: { showOnlyPkFk: true },
    });
    expect(parseLayout(text).viewSettings?.showOnlyPkFk).toBe(true);
  });

  it('parses viewSettings showGroupBoundary false', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {},
      viewSettings: { showGroupBoundary: false },
    });
    expect(parseLayout(text).viewSettings?.showGroupBoundary).toBe(false);
  });

  it('parses viewSettings mergeConvergentEdges false', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {},
      viewSettings: { mergeConvergentEdges: false },
    });
    expect(parseLayout(text).viewSettings?.mergeConvergentEdges).toBe(false);
  });

  it('returns undefined viewSettings when object has no known keys', () => {
    const text = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {},
      viewSettings: { unknownKey: true },
    });
    expect(parseLayout(text).viewSettings).toBeUndefined();
  });

  it('tolerates missing tables/groups/edges', () => {
    const layout = parseLayout(JSON.stringify({ version: 1 }));
    expect(layout.tables).toEqual({});
    expect(layout.groups).toEqual({});
    expect(layout.edges).toEqual({});
  });
});

// ── serializeLayout ───────────────────────────────────────────────────────

describe('serializeLayout', () => {
  it('produces valid JSON', () => {
    const s = serializeLayout(emptyLayout());
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it('ends with a trailing newline', () => {
    expect(serializeLayout(emptyLayout()).endsWith('\n')).toBe(true);
  });

  it('sorts table keys alphabetically', () => {
    const layout = {
      ...emptyLayout(),
      tables: {
        'public.zebra': { x: 1, y: 2 },
        'public.alpha': { x: 3, y: 4 },
      },
    };
    const s = serializeLayout(layout);
    expect(s.indexOf('"public.alpha"')).toBeLessThan(s.indexOf('"public.zebra"'));
  });

  it('sorts group keys alphabetically', () => {
    const layout = {
      ...emptyLayout(),
      groups: { 'z-group': { collapsed: true as true }, 'a-group': { hidden: true as true } },
    };
    const s = serializeLayout(layout);
    expect(s.indexOf('"a-group"')).toBeLessThan(s.indexOf('"z-group"'));
  });

  it('sorts edge keys alphabetically', () => {
    const layout = { ...emptyLayout(), edges: { 'z-edge': { dx: 1 }, 'a-edge': { dy: 2 } } };
    const s = serializeLayout(layout);
    expect(s.indexOf('"a-edge"')).toBeLessThan(s.indexOf('"z-edge"'));
  });

  it('omits collapsed:false from groups', () => {
    const layout = { ...emptyLayout(), groups: { billing: {} } };
    const s = serializeLayout(layout);
    expect(s).not.toContain('collapsed');
    expect(s).not.toContain('hidden');
  });

  it('writes collapsed:true when set', () => {
    const layout = { ...emptyLayout(), groups: { billing: { collapsed: true as true } } };
    expect(serializeLayout(layout)).toContain('"collapsed": true');
  });

  it('writes hidden:true in groups', () => {
    const layout = { ...emptyLayout(), groups: { billing: { hidden: true as true } } };
    expect(serializeLayout(layout)).toContain('"hidden": true');
  });

  it('omits hidden:false from tables', () => {
    const layout = { ...emptyLayout(), tables: { 'public.users': { x: 0, y: 0 } } };
    expect(serializeLayout(layout)).not.toContain('hidden');
  });

  it('writes hidden:true in tables', () => {
    const layout = { ...emptyLayout(), tables: { 'public.users': { x: 0, y: 0, hidden: true as true } } };
    expect(serializeLayout(layout)).toContain('"hidden": true');
  });

  it('writes integer coordinates', () => {
    const layout = { ...emptyLayout(), tables: { 't': { x: 10.7, y: 20.3 } } };
    const s = serializeLayout(layout);
    expect(s).toContain('"x": 11');
    expect(s).toContain('"y": 20');
  });

  it('writes color when present on table', () => {
    const layout = { ...emptyLayout(), tables: { 't': { x: 0, y: 0, color: '#abc' } } };
    expect(serializeLayout(layout)).toContain('"color": "#abc"');
  });

  it('writes viewSettings showOnlyPkFk:true when set', () => {
    const layout = { ...emptyLayout(), viewSettings: { showOnlyPkFk: true as true } };
    expect(serializeLayout(layout)).toContain('"showOnlyPkFk": true');
  });

  it('writes viewSettings showGroupBoundary:false when set', () => {
    const layout = { ...emptyLayout(), viewSettings: { showGroupBoundary: false as false } };
    expect(serializeLayout(layout)).toContain('"showGroupBoundary": false');
  });

  it('writes viewSettings mergeConvergentEdges:false when set', () => {
    const layout = { ...emptyLayout(), viewSettings: { mergeConvergentEdges: false as false } };
    expect(serializeLayout(layout)).toContain('"mergeConvergentEdges": false');
  });

  it('omits viewSettings key when not present', () => {
    expect(serializeLayout(emptyLayout())).not.toContain('viewSettings');
  });

  it('omits viewSettings key when object is empty', () => {
    const layout = { ...emptyLayout(), viewSettings: {} };
    expect(serializeLayout(layout)).not.toContain('viewSettings');
  });

  it('omits edges that have no dx or dy', () => {
    const layout = { ...emptyLayout(), edges: { 'e1': {} } };
    expect(serializeLayout(layout)).not.toContain('"e1"');
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────

describe('parseLayout → serializeLayout round-trip', () => {
  it('is idempotent: serialize(parse(serialize(x))) === serialize(x)', () => {
    const layout = {
      version: 1 as const,
      viewport: { x: 120, y: -40, zoom: 0.8 },
      tables: {
        'public.users': { x: 100, y: 80, color: '#D0E8FF' },
        'billing.invoices': { x: 300, y: 200, hidden: true as true },
      },
      groups: {
        billing: { collapsed: true as true, color: '#F0E8D0' },
        core: {},
      },
      edges: { 'ref-1': { dx: 10, dy: -20 } },
    };
    const s1 = serializeLayout(layout);
    const s2 = serializeLayout(parseLayout(s1));
    expect(s2).toBe(s1);
  });

  it('round-trips viewSettings', () => {
    const layout = {
      ...emptyLayout(),
      viewSettings: { mergeConvergentEdges: false as false, showOnlyPkFk: true as true },
    };
    const s1 = serializeLayout(layout);
    const s2 = serializeLayout(parseLayout(s1));
    expect(s2).toBe(s1);
  });

  it('round-trips empty layout', () => {
    const s1 = serializeLayout(emptyLayout());
    expect(serializeLayout(parseLayout(s1))).toBe(s1);
  });

  it('byte-identical for a realistic layout', () => {
    const expected = `{
  "version": 1,
  "viewport": { "x": 120, "y": -40, "zoom": 0.8 },
  "tables": {
    "billing.invoices": { "x": 300, "y": 200 },
    "public.users": { "x": 100, "y": 80, "color": "#D0E8FF" }
  },
  "groups": {
    "billing": { "collapsed": true, "color": "#F0E8D0" },
    "core": {}
  },
  "edges": {
    "ref-1": { "dx": 10, "dy": -20 }
  }
}
`;
    expect(serializeLayout(parseLayout(expected))).toBe(expected);
  });
});
