import type { Table } from '../../shared/types';
import type { LodLevel } from './lod';
import { estimateSize } from '../layout/autoLayout';
import { startDrag } from '../drag/dragController';
import { postToHost } from '../vscode';
import { IconKey, IconNote } from '../icons';

interface TableNodeProps {
  table: Table;
  x: number;
  y: number;
  lod: LodLevel;
  selected: boolean;
  groupColor?: string;
}

export function TableNode({ table, x, y, lod, selected, groupColor }: TableNodeProps) {
  const size = estimateSize(table.columns.length);
  const onPointerDown = (e: PointerEvent) => {
    startDrag(e, table.name, e.currentTarget as HTMLElement);
  };
  const onDblClick = (e: Event) => {
    e.stopPropagation();
    postToHost({ type: 'command:reveal', payload: { tableName: table.name } });
  };

  const selClass = selected ? ' is-selected' : '';
  const headerTitle = table.note ? `${table.name}\n\n${table.note}` : table.name;

  if (lod === 'rect') {
    return (
      <div
        class={`ddd-table ddd-table--rect${selClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        onDblClick={onDblClick}
        title={headerTitle}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          background: groupColor ?? 'var(--ddd-accent)',
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
        onDblClick={onDblClick}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          borderTopColor: groupColor ?? undefined,
        }}
      >
        <div class="ddd-table__header" title={headerTitle}>
          {table.schemaName !== 'public' ? <span class="ddd-table__schema">{table.schemaName}.</span> : null}
          <span class="ddd-table__name">{table.tableName}</span>
          {table.note ? <IconNote size={11} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      class={`ddd-table${selClass}`}
      data-id={table.name}
      onPointerDown={onPointerDown}
      onDblClick={onDblClick}
      style={{
        position: 'absolute',
        transform: `translate3d(${x}px, ${y}px, 0)`,
        borderTopColor: groupColor ?? undefined,
      }}
    >
      <div class="ddd-table__header" title={headerTitle}>
        {table.schemaName !== 'public' ? <span class="ddd-table__schema">{table.schemaName}.</span> : null}
        <span class="ddd-table__name">{table.tableName}</span>
        {table.note ? <IconNote size={11} /> : null}
      </div>
      <ul class="ddd-table__cols">
        {table.columns.map((c) => {
          const title = [
            c.pk ? 'PK' : null,
            c.notNull ? 'NOT NULL' : null,
            c.unique ? 'UNIQUE' : null,
            c.default ? `default: ${c.default}` : null,
            c.note ? `\n${c.note}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <li class="ddd-table__col" key={c.name} title={title || undefined}>
              {c.pk ? <IconKey size={10} /> : <span class="ddd-col-icon-placeholder" />}
              <span class={`ddd-table__col-name${c.pk ? ' is-pk' : ''}`}>{c.name}</span>
              <span class="ddd-table__col-type">{c.type}</span>
              {c.notNull ? <span class="ddd-table__flag" title="not null">!</span> : null}
              {c.unique ? <span class="ddd-table__flag" title="unique">u</span> : null}
              {c.note ? <IconNote size={10} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
