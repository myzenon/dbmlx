import { useState, useEffect, useRef } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import type { Column, ColumnChange, Table } from '../../shared/types';
import type { LodLevel } from './lod';
import { estimateSize } from '../layout/autoLayout';
import { startDrag, schedulePersist } from '../drag/dragController';
import { postToHost } from '../vscode';
import { store, useAppStore } from '../state/store';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { IconKey, IconNote, IconPalette, IconGoToFile, IconInfo } from '../icons';

interface TableNodeProps {
  table: Table;
  x: number;
  y: number;
  lod: LodLevel;
  selected: boolean;
  color?: string;
  fkColumns?: Set<string>;
  highlightedCols?: Set<string>;
}

function TableNodeInner({ table, x, y, lod, selected, color, fkColumns, highlightedCols }: TableNodeProps) {
  const size = estimateSize(table.columns.length);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const [showIcons, setShowIcons] = useState(false);
  const onPointerDown = (e: PointerEvent) => {
    startDrag(e, table.name, e.currentTarget as HTMLElement);
  };

  const selClass = selected ? ' is-selected' : '';
  const headerStyle = color
    ? { background: tint(color, 0.22), borderTopColor: color }
    : undefined;

  if (lod === 'rect') {
    return (
      <div
        class={`ddd-table ddd-table--rect${selClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        title={table.note ? `${table.name}\n\n${table.note}` : table.name}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          background: color ?? 'var(--ddd-accent)',
        }}
      />
    );
  }

  if (lod === 'header') {
    return (
      <div
        class={`ddd-table ddd-table--header-only${selClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          borderTopColor: color ?? undefined,
        }}
      >
        <TableHeader table={table} headerStyle={headerStyle} />
      </div>
    );
  }

  const visibleCols = showOnlyPkFk
    ? table.columns.filter((c) => c.pk || (fkColumns && fkColumns.has(c.name)))
    : table.columns;

  const changes = table.columnChanges ?? {};
  const pkIndexChangeByCol = new Map<string, 'add' | 'drop'>();
  for (const ic of table.indexChanges ?? []) {
    for (const col of ic.columns) pkIndexChangeByCol.set(col, ic.kind);
  }
  const changeCount = Object.keys(changes).length;
  const tableChangeClass = table.tableChange === 'add' ? ' ddd-table--add'
    : table.tableChange === 'drop' ? ' ddd-table--drop'
    : table.tableChange === 'modify' ? ' ddd-table--modify' : '';

  return (
    <div
      class={`ddd-table${selClass}${changeCount > 0 ? ' ddd-table--changed' : ''}${tableChangeClass}`}
      data-id={table.name}
      onPointerDown={onPointerDown}
      onMouseEnter={() => setShowIcons(true)}
      onMouseLeave={() => setShowIcons(false)}
      style={{
        position: 'absolute',
        transform: `translate3d(${x}px, ${y}px, 0)`,
        borderTopColor: color ?? undefined,
      }}
    >
      <TableHeader table={table} configurable showIcons={showIcons} headerStyle={headerStyle} changeCount={changeCount} tableChange={table.tableChange} tableFromName={table.tableFromName} />
      <ul class="ddd-table__cols">
        {visibleCols.map((c) => (
          <ColumnRow key={c.name} col={c} isFk={fkColumns?.has(c.name) ?? false} change={changes[c.name]} pkIndexChange={pkIndexChangeByCol.get(c.name)} tableName={table.name} isHighlighted={highlightedCols?.has(c.name) ?? false} />
        ))}
      </ul>
    </div>
  );
}

export const TableNode = memo(TableNodeInner);

function TableHeader({ table, configurable, showIcons, headerStyle, changeCount, tableChange, tableFromName }: { table: Table; configurable?: boolean; showIcons?: boolean; headerStyle?: Record<string, string>; changeCount?: number; tableChange?: 'add' | 'drop' | 'modify'; tableFromName?: string }) {
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const [showNameTip, setShowNameTip] = useState(false);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const infoRef = useRef<HTMLButtonElement>(null);
  const existing = store.getState().tableColors.get(table.name);

  useEffect(() => {
    if (!showNameTip) return;
    const dismiss = () => setShowNameTip(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('wheel', dismiss, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('wheel', dismiss);
    };
  }, [showNameTip]);

  const onInfoClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (showNameTip) { setShowNameTip(false); return; }
    const r = infoRef.current?.getBoundingClientRect();
    if (r) setTipPos({ x: r.left, y: r.bottom + 4 });
    setShowNameTip(true);
  };

  const applyColor = (c: string) => {
    store.getState().setTableColor(table.name, c);
    schedulePersist();
  };
  const resetColor = () => {
    store.getState().setTableColor(table.name, null);
    schedulePersist();
  };

  const onColorClick = (e: MouseEvent) => {
    e.stopPropagation();
    const tableEl = (e.currentTarget as HTMLElement).closest('.ddd-table') as HTMLElement | null;
    const anchorRect = tableEl?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup(popupAnchorFor(anchorRect));
  };

  const onGoToClick = (e: MouseEvent) => {
    e.stopPropagation();
    postToHost({ type: 'command:reveal', payload: { tableName: table.name } });
  };

  const onHeadPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.ddd-table__note-icon')) e.stopPropagation();
  };

  return (
    <div
      class={`ddd-table__header${showIcons ? ' is-hovered' : ''}`}
      style={headerStyle}
      onPointerDown={onHeadPointerDown}
    >
      <span class="ddd-table__title">
        {tableChange === 'add' ? <span class="ddd-table__change-badge ddd-table__change-badge--add" title="New table being added">+NEW</span> : null}
        {tableChange === 'drop' ? <span class="ddd-table__change-badge ddd-table__change-badge--drop" title="Table being dropped">DROP</span> : null}
        {changeCount ? <span class="ddd-table__change-badge" title={`${changeCount} migration change${changeCount > 1 ? 's' : ''}`}>{changeCount}</span> : null}
        <span class="ddd-table__name-wrap">
          {table.schemaName !== 'public' ? <span class="ddd-table__schema">{table.schemaName}.</span> : null}
          {tableChange === 'modify' && tableFromName ? (
            <>
              <span class="ddd-table__name ddd-table__name--before">{midTruncate(tableFromName, 10)}</span>
              <span class="ddd-table__name ddd-table__name--after">{midTruncate(table.tableName, 10)}</span>
            </>
          ) : (
            <span class="ddd-table__name">{midTruncate(table.tableName, 20)}</span>
          )}
          {table.note ? <TableNoteIcon note={table.note} name={table.name} /> : null}
        </span>
      </span>
      {configurable ? (
        <div class="ddd-table__actions" onPointerDown={(e) => e.stopPropagation()}>
          <button
            ref={infoRef}
            class="ddd-table__info"
            onClick={onInfoClick}
            title="Show full name"
          ><IconInfo size={11} /></button>
          <button
            class="ddd-table__goto"
            onClick={onGoToClick}
            title="Go to definition"
          ><IconGoToFile size={12} /></button>
          <button
            class="ddd-table__gear"
            onClick={onColorClick}
            title="Change color"
          ><IconPalette size={12} /></button>
        </div>
      ) : null}
      {showNameTip && tipPos ? createPortal(
        <div
          class="ddd-name-tip"
          style={{ left: `${tipPos.x}px`, top: `${tipPos.y}px` }}
        >
          {tableChange === 'modify' && tableFromName
            ? `${tableFromName} → ${table.tableName}`
            : table.name}
        </div>,
        document.body,
      ) : null}
      {popup ? createPortal(
        <ColorPopup
          current={existing ?? 'var(--ddd-accent)'}
          x={popup.x}
          y={popup.y}
          onPick={applyColor}
          onReset={resetColor}
          onClose={() => setPopup(null)}
        />,
        document.body,
      ) : null}
    </div>
  );
}

function ColumnRow({ col, isFk, change, pkIndexChange, tableName, isHighlighted }: { col: Column; isFk: boolean; change?: ColumnChange; pkIndexChange?: 'add' | 'drop'; tableName: string; isHighlighted?: boolean }) {
  const onEnter = (e: Event) => {
    store.getState().setHoveredColKey(tableName + '\x1f' + col.name);
    if (!col.note) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.getState().setTooltip({
      title: col.name,
      subtitle: col.type,
      body: col.note,
      x: rect.right + 10,
      y: rect.top,
    });
  };
  const onLeave = () => {
    store.getState().setHoveredColKey(null);
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };

  const changeClass = change
    ? change.kind === 'add' ? ' ddd-col--add'
    : change.kind === 'drop' ? ' ddd-col--drop'
    : ' ddd-col--modify'
    : '';

  if (change?.kind === 'modify') {
    const fromName = change.fromName ?? col.name;
    const fromType = change.fromType ?? col.type;
    const fromPk = change.fromPk ?? col.pk;
    const fromNotNull = change.fromNotNull ?? col.notNull;
    const fromUnique = change.fromUnique ?? col.unique;
    return (
      <li class={`ddd-table__col${isFk ? ' is-fk' : ''}${changeClass}${isHighlighted ? ' is-col-hl' : ''}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
        <div class="ddd-col__before">
          <span class="ddd-table__col-left">
            <span class={`ddd-table__col-name${fromPk ? ' is-pk' : ''}`}>{fromName}</span>
            {fromPk ? <IconKey size={10} /> : null}
            {col.note ? <IconNote size={10} /> : null}
          </span>
          <span class="ddd-table__col-right">
            <span class="ddd-table__col-type">{fromType}</span>
            {fromNotNull ? <span class="ddd-table__badge" title="not null">NN</span> : null}
            {fromUnique ? <span class="ddd-table__badge" title="unique">U</span> : null}
          </span>
        </div>
        <div class="ddd-col__after">
          <span class="ddd-table__col-left">
            <span class={`ddd-table__col-name${col.pk ? ' is-pk' : ''}`}>{col.name}</span>
            {col.pk && !fromPk ? <span class="ddd-pk--add"><IconKey size={10} /></span> : col.pk ? <IconKey size={10} /> : null}
            {col.note ? <IconNote size={10} /> : null}
          </span>
          <span class="ddd-table__col-right">
            <span class="ddd-table__col-type">{col.type}</span>
            {col.notNull ? <span class="ddd-table__badge" title="not null">NN</span> : null}
            {col.unique ? <span class="ddd-table__badge" title="unique">U</span> : null}
          </span>
        </div>
      </li>
    );
  }

  const pkDrop = pkIndexChange === 'drop' && !col.pk;
  const pkAdd  = pkIndexChange === 'add'  && col.pk;

  return (
    <li
      class={`ddd-table__col${isFk ? ' is-fk' : ''}${changeClass}${isHighlighted ? ' is-col-hl' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span class="ddd-table__col-left">
        <span class={`ddd-table__col-name${col.pk ? ' is-pk' : ''}`}>
          {change?.kind === 'add' ? '+\u2009' : ''}{col.name}
        </span>
        {col.pk && !pkAdd ? <IconKey size={10} /> : null}
        {pkAdd  ? <span class="ddd-pk--add"><IconKey size={10} /></span> : null}
        {pkDrop ? <span class="ddd-pk--drop"><IconKey size={10} /></span> : null}
        {col.note ? <IconNote size={10} /> : null}
      </span>
      <span class="ddd-table__col-right">
        <span class="ddd-table__col-type">{col.type}</span>
        {col.notNull ? <span class="ddd-table__badge" title="not null">NN</span> : null}
        {col.unique ? <span class="ddd-table__badge" title="unique">U</span> : null}
      </span>
    </li>
  );
}

function TableNoteIcon({ note, name }: { note: string; name: string }) {
  const onEnter = (e: Event) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.getState().setTooltip({
      title: name,
      body: note,
      x: rect.right + 10,
      y: rect.top,
    });
  };
  const onLeave = () => {
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };
  return (
    <span class="ddd-table__note-icon" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <IconNote size={11} />
    </span>
  );
}

function midTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

/** Mix a hex/hsl color with dark background to produce a subtle tint. Returns rgba. */
function tint(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const n = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.padEnd(6, '0');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
