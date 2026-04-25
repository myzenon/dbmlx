import type { QualifiedName, Ref, Table } from '../../shared/types';
import type { AppState } from '../state/store';
import { estimateSize, TABLE_HEADER_H, TABLE_ROW_H } from '../layout/autoLayout';
import { routeRefs } from './edgeRouter';
import type { Bbox } from './spatialIndex';

export function svgToPngDataUrl(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas 2d unavailable')); return; }
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG render failed'));
    img.src = dataUrl;
  });
}

const PAD = 48;
const GRP_PAD = 24;
const GRP_HDR = 20;
const GRP_W = 220;
const GRP_H = 80;
const GP = '__group__:';

function hslColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360},55%,60%)`;
}

function withAlpha(color: string, a: number): string {
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `,${a.toFixed(2)})`);
  if (color.startsWith('#')) {
    const h = color.slice(1).padEnd(6, '0').slice(0, 6);
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
  }
  return color;
}

/** Actual rendered height of a table, accounting for modify columns taking two rows. */
function tableActualHeight(t: Table): number {
  let h = TABLE_HEADER_H + 4;
  for (const col of t.columns) {
    h += t.columnChanges?.[col.name]?.kind === 'modify' ? TABLE_ROW_H * 2 : TABLE_ROW_H;
  }
  return h + 4;
}

/** Y offset from table top for the column at index ci. */
function colRowY(t: Table, ci: number): number {
  let dy = TABLE_HEADER_H + 4;
  for (let i = 0; i < ci; i++) {
    dy += t.columnChanges?.[t.columns[i]!.name]?.kind === 'modify' ? TABLE_ROW_H * 2 : TABLE_ROW_H;
  }
  return dy;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateSvg(state: AppState): string {
  const { schema, positions, hiddenTables, tableColors, groups: grpState, theme, edgeOffsets,
    showOnlyPkFk, showGroupBoundary, showCardinalityLabels, mergeConvergentEdges, showDropRefs } = state;

  // Build fkColumnsByTable from refs (mirrors app.tsx useMemo)
  const fkColsByTable = new Map<QualifiedName, Set<string>>();
  for (const r of schema.refs) {
    for (const c of r.source.columns) { let s = fkColsByTable.get(r.source.table); if (!s) { s = new Set(); fkColsByTable.set(r.source.table, s); } s.add(c); }
    for (const c of r.target.columns) { let s = fkColsByTable.get(r.target.table); if (!s) { s = new Set(); fkColsByTable.set(r.target.table, s); } s.add(c); }
  }

  const getRenderedTable = (t: Table): Table => {
    if (!showOnlyPkFk) return t;
    const fk = fkColsByTable.get(t.name) ?? new Set<string>();
    return { ...t, columns: t.columns.filter((c) => c.pk || fk.has(c.name)) };
  };

  // Compute visibility state (mirrors app.tsx derived logic)
  const hidden = new Set<QualifiedName>(hiddenTables);
  const collapsedSet = new Set<QualifiedName>();
  const collapsedNodes: { name: string; x: number; y: number; w: number; h: number; color: string; count: number }[] = [];
  const containers: { name: string; x: number; y: number; w: number; h: number; color: string }[] = [];

  for (const g of schema.groups) {
    const st = grpState[g.name];
    if (st?.hidden) { for (const t of g.tables) hidden.add(t); continue; }
    if (st?.collapsed) {
      let sx = 0, sy = 0, n = 0;
      for (const t of g.tables) {
        const p = positions.get(t); if (!p) continue;
        const tbl = schema.tables.find((x) => x.name === t);
        const rh = tbl ? tableActualHeight(getRenderedTable(tbl)) : estimateSize(0).height;
        sx += p.x + estimateSize(0).width / 2; sy += p.y + rh / 2; n++;
        collapsedSet.add(t);
      }
      if (n > 0) collapsedNodes.push({ name: g.name, x: Math.round(sx / n - GRP_W / 2), y: Math.round(sy / n - GRP_H / 2), w: GRP_W, h: GRP_H, color: st.color ?? hslColor(g.name), count: g.tables.length });
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      for (const t of g.tables) {
        if (hidden.has(t)) continue;
        const p = positions.get(t); if (!p) continue;
        const tbl = schema.tables.find((x) => x.name === t);
        const rh = tbl ? tableActualHeight(getRenderedTable(tbl)) : estimateSize(0).height;
        if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
        if (p.x + estimateSize(0).width > x1) x1 = p.x + estimateSize(0).width;
        if (p.y + rh > y1) y1 = p.y + rh;
        n++;
      }
      if (n > 0) containers.push({ name: g.name, x: Math.round(x0 - GRP_PAD), y: Math.round(y0 - GRP_PAD - GRP_HDR), w: Math.round(x1 - x0 + GRP_PAD * 2), h: Math.round(y1 - y0 + GRP_PAD * 2 + GRP_HDR), color: st?.color ?? hslColor(g.name) });
    }
  }

  const effPos = new Map(positions);
  for (const g of collapsedNodes) effPos.set(GP + g.name, { x: g.x, y: g.y });

  // Effective refs (same dedup logic as app.tsx)
  const t2g = new Map<QualifiedName, string>();
  for (const t of schema.tables) if (t.groupName) t2g.set(t.name, t.groupName);
  const mapEp = (table: QualifiedName): QualifiedName | null => {
    if (hidden.has(table)) return null;
    if (collapsedSet.has(table)) { const g = t2g.get(table); return g ? GP + g : null; }
    return table;
  };
  const effRefs: Ref[] = [];
  const seen = new Set<string>();
  for (const r of schema.refs) {
    if (r.refChange === 'drop' && !showDropRefs) continue;
    const sm = mapEp(r.source.table); const tm = mapEp(r.target.table);
    if (!sm || !tm || sm === tm) continue;
    const key = `${sm}::${r.source.columns.join(',')}|${tm}::${r.target.columns.join(',')}`;
    if (seen.has(key)) continue; seen.add(key);
    effRefs.push({ ...r, id: key, source: { ...r.source, table: sm }, target: { ...r.target, table: tm } });
  }

  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    const p = effPos.get(name); if (!p) return undefined;
    if (name.startsWith(GP)) return { x: p.x, y: p.y, w: GRP_W, h: GRP_H };
    const t = schema.tables.find((x) => x.name === name);
    if (!t) return undefined;
    return { x: p.x, y: p.y, w: estimateSize(t.columns.length).width, h: tableActualHeight(getRenderedTable(t)) };
  };

  const columnYResolver = (tableName: QualifiedName, column: string): number | undefined => {
    const t = schema.tables.find((x) => x.name === tableName);
    if (!t) return undefined;
    const rt = getRenderedTable(t);
    const idx = rt.columns.findIndex((c) => c.name === column);
    if (idx < 0) return undefined;
    const isModify = t.columnChanges?.[rt.columns[idx]!.name]?.kind === 'modify';
    return colRowY(rt, idx) + (isModify ? TABLE_ROW_H * 1.5 : TABLE_ROW_H / 2);
  };

  const routes = routeRefs(effRefs, bboxOf, columnYResolver, (id) => edgeOffsets.get(id), mergeConvergentEdges);

  const refById = new Map<string, Ref>();
  for (const r of effRefs) refById.set(r.id, r);

  // World bounds
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of schema.tables) {
    if (hidden.has(t.name) || collapsedSet.has(t.name)) continue;
    const p = positions.get(t.name); if (!p) continue;
    const tw = estimateSize(t.columns.length).width;
    const th = tableActualHeight(getRenderedTable(t));
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x + tw > x1) x1 = p.x + tw; if (p.y + th > y1) y1 = p.y + th;
  }
  for (const el of [...collapsedNodes, ...containers]) {
    if (el.x < x0) x0 = el.x; if (el.y < y0) y0 = el.y;
    if (el.x + el.w > x1) x1 = el.x + el.w; if (el.y + el.h > y1) y1 = el.y + el.h;
  }
  if (!Number.isFinite(x0)) return '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="16" y="28" font-family="system-ui" font-size="14">No tables to export.</text></svg>';

  const vx = x0 - PAD, vy = y0 - PAD, vw = x1 - x0 + PAD * 2, vh = y1 - y0 + PAD * 2;

  const dark = theme === 'dark';
  const migAdd    = '#4caf50';
  const migDrop   = '#f44336';
  const migModify = '#ff9800';
  const bg        = dark ? '#1e1e1e' : '#ffffff';
  const fg        = dark ? '#d4d4d4' : '#1e1e1e';
  const fgMuted   = dark ? '#858585' : '#6b6b6b';
  const tblFill   = dark ? '#252526' : '#f5f5f5';
  const tblBorder = dark ? '#3c3c3c' : '#d4d4d4';
  const hdrFill   = dark ? '#2d2d2d' : '#e8e8e8';
  const rowLine   = dark ? '#2c2c2c' : '#ebebeb';
  const edgeLine  = dark ? '#4a9eff' : '#1a6fd4';
  const pkColor   = dark ? '#4ec9b0' : '#007f6f';

  const L: string[] = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">`);

  // Defs: clip paths + edge markers
  L.push('<defs>');
  const mk = (id: string, path: string, rx: number) =>
    `<marker id="${id}" viewBox="0 0 12 12" refX="${rx}" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto" overflow="visible"><path d="${path}" fill="none" stroke="${edgeLine}" stroke-width="1.2" stroke-linecap="round"/></marker>`;
  L.push(mk('ddd-mk-many',   'M2,2 L10,6 L2,10 M10,2 L10,10', 10));
  L.push(mk('ddd-mk-one',    'M10,2 L10,10',                    10));
  L.push(mk('ddd-mk-many-s', 'M10,2 L2,6 L10,10 M2,2 L2,10',    2));
  L.push(mk('ddd-mk-one-s',  'M2,2 L2,10',                       2));
  for (let ti = 0; ti < schema.tables.length; ti++) {
    const t = schema.tables[ti]!;
    if (hidden.has(t.name) || collapsedSet.has(t.name)) continue;
    const p = positions.get(t.name); if (!p) continue;
    L.push(`<clipPath id="c${ti}"><rect x="${p.x}" y="${p.y}" width="${estimateSize(t.columns.length).width}" height="${tableActualHeight(getRenderedTable(t))}" rx="4"/></clipPath>`);
  }
  L.push('</defs>');

  // Background
  L.push(`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${bg}"/>`);

  // Group containers (only when showGroupBoundary is enabled)
  if (showGroupBoundary) {
    for (const c of containers) {
      const a = dark ? 0.13 : 0.09;
      L.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="6" fill="${withAlpha(c.color, a)}" stroke="${c.color}" stroke-width="1.5" stroke-dasharray="6 3"/>`);
      L.push(`<text x="${c.x + 8}" y="${c.y + 14}" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="${c.color}">${esc(c.name)}</text>`);
    }
  }

  // Edges (draw before tables so tables sit on top)
  const renderedConvergeTargets = new Set<string>();
  const renderedConvergeSources = new Set<string>();
  for (const r of routes) {
    const ref = refById.get(r.id);
    const srcRel = ref?.source.relation ?? '1';
    const tgtRel = ref?.target.relation ?? '1';
    const startMarker = srcRel === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)';
    const endMarker   = tgtRel === '*' ? 'url(#ddd-mk-many)'   : 'url(#ddd-mk-one)';
    const srcLabel    = srcRel === '*' ? 'N' : '1';
    const tgtLabel    = tgtRel === '*' ? 'N' : '1';
    const srcLabelX   = r.source.x + (r.source.side === 'right' ? 16 : -16);
    const tgtLabelX   = r.target.x + (r.target.side === 'right' ? 16 : -16);
    const isTgtConvergeDup = r.convergeGroupId !== undefined && renderedConvergeTargets.has(r.convergeGroupId);
    if (r.convergeGroupId && !isTgtConvergeDup) renderedConvergeTargets.add(r.convergeGroupId);
    const isSrcConvergeDup = r.sourceConvergeGroupId !== undefined && renderedConvergeSources.has(r.sourceConvergeGroupId);
    if (r.sourceConvergeGroupId && !isSrcConvergeDup) renderedConvergeSources.add(r.sourceConvergeGroupId);
    const activeStartMarker = isSrcConvergeDup ? '' : ` marker-start="${startMarker}"`;
    const activeEndMarker   = isTgtConvergeDup ? '' : ` marker-end="${endMarker}"`;
    const isDropRef = ref?.refChange === 'drop';
    const refStroke = ref?.refChange === 'add' ? migAdd : isDropRef ? migDrop : edgeLine;
    const dropAttrs = isDropRef ? ' stroke-dasharray="5 4" opacity="0.55"' : '';
    L.push(`<path d="${r.d}" fill="none" stroke="${refStroke}" stroke-width="1.5" stroke-linecap="round"${activeStartMarker}${activeEndMarker}${dropAttrs}/>`);
    if (r.convergeJunction && !isTgtConvergeDup && !isSrcConvergeDup) {
      L.push(`<circle cx="${r.convergeJunction.x}" cy="${r.convergeJunction.y}" r="4" fill="${edgeLine}"/>`);
    }
    if (showCardinalityLabels) {
      if (!isSrcConvergeDup) L.push(`<text x="${srcLabelX}" y="${r.source.y - 4}" font-family="system-ui,sans-serif" font-size="10" fill="${fgMuted}" text-anchor="middle">${srcLabel}</text>`);
      if (!isTgtConvergeDup) L.push(`<text x="${tgtLabelX}" y="${r.target.y - 4}" font-family="system-ui,sans-serif" font-size="10" fill="${fgMuted}" text-anchor="middle">${tgtLabel}</text>`);
    }
  }

  // Tables
  for (let ti = 0; ti < schema.tables.length; ti++) {
    const t = schema.tables[ti]!;
    if (hidden.has(t.name) || collapsedSet.has(t.name)) continue;
    const p = positions.get(t.name); if (!p) continue;
    const rt = getRenderedTable(t);
    const w = estimateSize(t.columns.length).width;
    const h = tableActualHeight(rt);
    const { x, y } = p;

    const gclr = t.groupName ? (grpState[t.groupName]?.color ?? hslColor(t.groupName)) : undefined;
    const tclr = tableColors.get(t.name) ?? gclr;
    const tableAnn = t.tableChange;
    const tableAnnColor = tableAnn === 'add' ? migAdd : tableAnn === 'drop' ? migDrop : tableAnn === 'modify' ? migModify : null;
    const hdrBase = tclr ? withAlpha(tclr, dark ? 0.22 : 0.15) : hdrFill;
    const hdr = tableAnnColor ? withAlpha(tableAnnColor, 0.10) : hdrBase;
    const accent = tableAnnColor ?? tclr ?? tblBorder;
    const changes = t.columnChanges ?? {};
    const changeCount = Object.keys(changes).length;

    // Clipped internals
    L.push(`<g clip-path="url(#c${ti})">`);
    L.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${tblFill}"/>`);
    L.push(`  <rect x="${x}" y="${y}" width="${w}" height="${TABLE_HEADER_H}" fill="${hdr}"/>`);
    const pkIdxByCol = new Map<string, 'add' | 'drop'>();
    for (const ic of t.indexChanges ?? []) for (const c of ic.columns) pkIdxByCol.set(c, ic.kind);

    for (let ci = 0; ci < rt.columns.length; ci++) {
      const col = rt.columns[ci]!;
      const change = changes[col.name];
      const ry = y + colRowY(rt, ci);
      if (ci > 0) L.push(`  <line x1="${x}" y1="${ry}" x2="${x + w}" y2="${ry}" stroke="${rowLine}" stroke-width="1"/>`);

      if (change?.kind === 'modify') {
        const fromName = change.fromName ?? col.name;
        const fromType = change.fromType ?? col.type;
        const fromPk = change.fromPk ?? col.pk;
        const fromNotNull = change.fromNotNull ?? col.notNull;
        const fromUnique = change.fromUnique ?? col.unique;
        L.push(`  <rect x="${x}" y="${ry}" width="${w}" height="${TABLE_ROW_H * 2}" fill="${withAlpha(migModify, 0.08)}"/>`);
        L.push(`  <rect x="${x}" y="${ry}" width="2" height="${TABLE_ROW_H * 2}" fill="${migModify}"/>`);
        const beforeNameColor = fromPk ? pkColor : fg;
        L.push(`  <text x="${x + 8}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${beforeNameColor}" opacity="0.4" text-decoration="line-through">${esc(fromName)}</text>`);
        if (fromPk) {
          const iconX = x + 8 + fromName.length * 6.6 + 4;
          const iconY = ry + 5;
          L.push(`  <g transform="translate(${iconX},${iconY}) scale(0.625)" opacity="0.4"><path d="M10.5 2a3.5 3.5 0 0 0-3.37 4.48L2 11.61V14h2v-1h1v-1h1v-1h1v-1.12l1.02-1.02A3.5 3.5 0 1 0 10.5 2zm0 1a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1-.8-.13L8.5 9.06V10H7.5v1H6.5v1H5.5v1H3v-.97l5.26-5.26A2.5 2.5 0 0 1 10.5 3zM11 4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z" fill="${pkColor}"/></g>`);
        }
        let beforeRightX = x + w - 8;
        if (fromUnique) { L.push(`  <text x="${beforeRightX}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" opacity="0.4" text-anchor="end" text-decoration="line-through">U</text>`); beforeRightX -= 14; }
        if (fromNotNull) { L.push(`  <text x="${beforeRightX}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" opacity="0.4" text-anchor="end" text-decoration="line-through">NN</text>`); beforeRightX -= 20; }
        L.push(`  <text x="${beforeRightX}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${fgMuted}" opacity="0.4" text-anchor="end" text-decoration="line-through">${esc(fromType)}</text>`);
        L.push(`  <line x1="${x + 6}" y1="${ry + TABLE_ROW_H}" x2="${x + w}" y2="${ry + TABLE_ROW_H}" stroke="${withAlpha(migModify, 0.25)}" stroke-width="1"/>`);
        const afterNameColor = col.pk ? pkColor : migModify;
        L.push(`  <text x="${x + 8}" y="${ry + TABLE_ROW_H + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" font-weight="600" fill="${afterNameColor}">${esc(col.name)}</text>`);
        if (col.pk) {
          const iconX = x + 8 + col.name.length * 6.6 + 4;
          const iconY = ry + TABLE_ROW_H + 5;
          const afterPkColor = !fromPk ? migAdd : pkColor;
          L.push(`  <g transform="translate(${iconX},${iconY}) scale(0.625)"><path d="M10.5 2a3.5 3.5 0 0 0-3.37 4.48L2 11.61V14h2v-1h1v-1h1v-1h1v-1.12l1.02-1.02A3.5 3.5 0 1 0 10.5 2zm0 1a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1-.8-.13L8.5 9.06V10H7.5v1H6.5v1H5.5v1H3v-.97l5.26-5.26A2.5 2.5 0 0 1 10.5 3zM11 4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z" fill="${afterPkColor}"/></g>`);
        }
        let afterRightX = x + w - 8;
        if (col.unique) { L.push(`  <text x="${afterRightX}" y="${ry + TABLE_ROW_H + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${migModify}" opacity="0.85" text-anchor="end">U</text>`); afterRightX -= 14; }
        if (col.notNull) { L.push(`  <text x="${afterRightX}" y="${ry + TABLE_ROW_H + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${migModify}" opacity="0.85" text-anchor="end">NN</text>`); afterRightX -= 20; }
        L.push(`  <text x="${afterRightX}" y="${ry + TABLE_ROW_H + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${migModify}" opacity="0.85" text-anchor="end">${esc(col.type)}</text>`);
      } else if (change?.kind === 'drop') {
        L.push(`  <rect x="${x}" y="${ry}" width="${w}" height="${TABLE_ROW_H}" fill="${withAlpha(migDrop, 0.10)}"/>`);
        L.push(`  <rect x="${x}" y="${ry}" width="2" height="${TABLE_ROW_H}" fill="${migDrop}"/>`);
        L.push(`  <text x="${x + 8}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${fg}" opacity="0.55" text-decoration="line-through">${esc(col.name)}</text>`);
        let dropRx = x + w - 8;
        if (col.unique)  { L.push(`  <text x="${dropRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" opacity="0.55" text-anchor="end" text-decoration="line-through">U</text>`);  dropRx -= 14; }
        if (col.notNull) { L.push(`  <text x="${dropRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" opacity="0.55" text-anchor="end" text-decoration="line-through">NN</text>`); dropRx -= 20; }
        L.push(`  <text x="${dropRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${fgMuted}" opacity="0.55" text-anchor="end" text-decoration="line-through">${esc(col.type)}</text>`);
      } else if (change?.kind === 'add') {
        L.push(`  <rect x="${x}" y="${ry}" width="${w}" height="${TABLE_ROW_H}" fill="${withAlpha(migAdd, 0.12)}"/>`);
        L.push(`  <rect x="${x}" y="${ry}" width="2" height="${TABLE_ROW_H}" fill="${migAdd}"/>`);
        const nc = col.pk ? pkColor : migAdd;
        L.push(`  <text x="${x + 8}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${nc}">+\u2009${esc(col.name)}</text>`);
        let addRx = x + w - 8;
        if (col.unique)  { L.push(`  <text x="${addRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" text-anchor="end">U</text>`);  addRx -= 14; }
        if (col.notNull) { L.push(`  <text x="${addRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" text-anchor="end">NN</text>`); addRx -= 20; }
        L.push(`  <text x="${addRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${fgMuted}" text-anchor="end">${esc(col.type)}</text>`);
      } else {
        const pkIdxChange = pkIdxByCol.get(col.name);
        const pkDrop = pkIdxChange === 'drop' && !col.pk;
        const pkAdd  = pkIdxChange === 'add'  && col.pk;
        const nc = col.pk ? pkColor : fg;
        L.push(`  <text x="${x + 8}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${nc}">${esc(col.name)}</text>`);
        if (col.pk || pkDrop) {
          const iconX = x + 8 + col.name.length * 6.6 + 4;
          const iconY = ry + 5;
          const iconColor = pkAdd ? migAdd : pkDrop ? migDrop : pkColor;
          const iconOpacity = pkDrop ? ' opacity="0.75"' : '';
          L.push(`  <g transform="translate(${iconX},${iconY}) scale(0.625)"${iconOpacity}><path d="M10.5 2a3.5 3.5 0 0 0-3.37 4.48L2 11.61V14h2v-1h1v-1h1v-1h1v-1.12l1.02-1.02A3.5 3.5 0 1 0 10.5 2zm0 1a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1-.8-.13L8.5 9.06V10H7.5v1H6.5v1H5.5v1H3v-.97l5.26-5.26A2.5 2.5 0 0 1 10.5 3zM11 4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z" fill="${iconColor}"/></g>`);
        }
        let regRx = x + w - 8;
        if (col.unique)  { L.push(`  <text x="${regRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" text-anchor="end">U</text>`);  regRx -= 14; }
        if (col.notNull) { L.push(`  <text x="${regRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="9" fill="${fgMuted}" text-anchor="end">NN</text>`); regRx -= 20; }
        L.push(`  <text x="${regRx}" y="${ry + 14}" font-family="ui-monospace,monospace,sans-serif" font-size="11" fill="${fgMuted}" text-anchor="end">${esc(col.type)}</text>`);
      }
    }
    L.push('</g>');
    // Border + accents (unclipped for crisp rendering)
    const borderStroke = tableAnnColor ?? tblBorder;
    const borderW = tableAnnColor ? 1.5 : 1;
    const tableOpacity = tableAnn === 'drop' ? 'opacity="0.72"' : '';
    L.push(`<g ${tableOpacity}>`);
    L.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="${borderStroke}" stroke-width="${borderW}"/>`);
    L.push(`<rect x="${x}" y="${y}" width="${w}" height="3" rx="2" fill="${accent}"/>`);
    if (changeCount > 0) L.push(`<rect x="${x}" y="${y + 3}" width="3" height="${h - 3}" rx="1" fill="${migModify}"/>`);
    L.push(`<line x1="${x}" y1="${y + TABLE_HEADER_H}" x2="${x + w}" y2="${y + TABLE_HEADER_H}" stroke="${tblBorder}" stroke-width="1"/>`);
    const display = t.schemaName !== 'public' ? `${t.schemaName}.${t.tableName}` : t.tableName;
    const nameDecoration = tableAnn === 'drop' ? ' text-decoration="line-through"' : '';
    // Badges are rendered LEFT of the name so they're never clipped by long table names
    const by = y + TABLE_HEADER_H - 14;
    let nameX = x + 8;
    if (tableAnn === 'add' || tableAnn === 'drop') {
      const badgeLabel = tableAnn === 'add' ? '+NEW' : 'DROP';
      const bw = tableAnn === 'add' ? 28 : 26;
      L.push(`<rect x="${nameX}" y="${by - 7}" width="${bw}" height="14" rx="7" fill="${tableAnnColor}"/>`);
      L.push(`<text x="${nameX + bw / 2}" y="${by + 4}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="white" text-anchor="middle">${badgeLabel}</text>`);
      nameX += bw + 6;
    }
    if (changeCount > 0) {
      L.push(`<circle cx="${nameX + 7}" cy="${by}" r="7" fill="${migModify}"/>`);
      L.push(`<text x="${nameX + 7}" y="${by + 4}" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="white" text-anchor="middle">${changeCount}</text>`);
      nameX += 20;
    }
    if (tableAnn === 'modify' && t.tableFromName) {
      const fromDisplay = t.schemaName !== 'public' ? `${t.schemaName}.${t.tableFromName}` : t.tableFromName;
      // Before name: muted strikethrough, anchored at top of header area
      L.push(`<text x="${nameX}" y="${y + TABLE_HEADER_H - 14}" font-family="system-ui,sans-serif" font-size="11" fill="${fgMuted}" opacity="0.5" text-decoration="line-through">${esc(fromDisplay)}</text>`);
      // After name: amber bold, nudged right+down so it partially overlaps but stays readable
      L.push(`<text x="${nameX + 10}" y="${y + TABLE_HEADER_H - 3}" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${migModify}">${esc(display)}</text>`);
    } else {
      L.push(`<text x="${nameX}" y="${y + TABLE_HEADER_H - 8}" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${fg}"${nameDecoration}>${esc(display)}</text>`);
    }
    L.push('</g>');
  }

  // Collapsed group nodes
  for (const g of collapsedNodes) {
    const a = dark ? 0.25 : 0.17;
    L.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="8" fill="${withAlpha(g.color, a)}" stroke="${g.color}" stroke-width="2"/>`);
    L.push(`<text x="${g.x + g.w / 2}" y="${g.y + g.h / 2 - 5}" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="${g.color}" text-anchor="middle">${esc(g.name)}</text>`);
    L.push(`<text x="${g.x + g.w / 2}" y="${g.y + g.h / 2 + 13}" font-family="system-ui,sans-serif" font-size="11" fill="${fgMuted}" text-anchor="middle">${g.count} tables</text>`);
  }

  L.push('</svg>');
  return L.join('\n');
}
