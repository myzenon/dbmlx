import { useState } from 'preact/hooks';
import type { TableGroup } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../drag/dragController';
import {
  IconChevronDown,
  IconChevronRight,
  IconCollapseAll,
  IconExpandAll,
  IconEye,
  IconEyeClosed,
} from '../icons';

export function GroupPanel() {
  const groups = useAppStore((s) => s.schema.groups);
  const groupState = useAppStore((s) => s.groups);
  const hiddenTables = useAppStore((s) => s.hiddenTables);
  const [open, setOpen] = useState(true);

  if (groups.length === 0) return null;

  const anyVisible = groups.some((g) => !(groupState[g.name]?.hidden));
  const anyExpanded = groups.some((g) => !(groupState[g.name]?.collapsed));

  const toggleAllHidden = () => {
    const target = anyVisible; // if any visible → hide all; else show all
    for (const g of groups) {
      store.getState().setGroup(g.name, { hidden: target });
    }
    // clear per-table hides when showing all
    if (!target) {
      for (const name of hiddenTables) store.getState().setTableHidden(name, false);
    }
    schedulePersist();
  };
  const toggleAllCollapsed = () => {
    const target = anyExpanded;
    for (const g of groups) {
      store.getState().setGroup(g.name, { collapsed: target });
    }
    schedulePersist();
  };

  return (
    <div class={`ddd-group-panel ${open ? 'is-open' : 'is-closed'}`}>
      <div class="ddd-group-panel__head">
        <button class="ddd-group-panel__toggle" onClick={() => setOpen(!open)} title={open ? 'Close panel' : 'Open panel'}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span>Groups</span>
          <span class="ddd-group-panel__count">{groups.length}</span>
        </button>
        {open ? (
          <div class="ddd-group-panel__actions">
            <button class="ddd-icon-btn" onClick={toggleAllHidden} title={anyVisible ? 'Hide all' : 'Show all'}>
              {anyVisible ? <IconEye size={13} /> : <IconEyeClosed size={13} />}
            </button>
            <button class="ddd-icon-btn" onClick={toggleAllCollapsed} title={anyExpanded ? 'Collapse all' : 'Expand all'}>
              {anyExpanded ? <IconCollapseAll size={13} /> : <IconExpandAll size={13} />}
            </button>
          </div>
        ) : null}
      </div>
      {open ? (
        <ul class="ddd-group-list">
          {groups.map((g) => (
            <GroupRow
              key={g.name}
              group={g}
              state={groupState[g.name]}
              hiddenTables={hiddenTables}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface GroupRowProps {
  group: TableGroup;
  state: { collapsed?: boolean; hidden?: boolean; color?: string } | undefined;
  hiddenTables: Set<string>;
}

function GroupRow({ group, state, hiddenTables }: GroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hidden = state?.hidden ?? false;
  const collapsed = state?.collapsed ?? false;
  const color = state?.color ?? colorForGroup(group.name);

  const toggleHidden = () => {
    store.getState().setGroup(group.name, { hidden: !hidden });
    schedulePersist();
  };
  const toggleCollapsed = () => {
    store.getState().setGroup(group.name, { collapsed: !collapsed });
    schedulePersist();
  };
  const onColorChange = (e: Event) => {
    const next = (e.currentTarget as HTMLInputElement).value;
    store.getState().setGroup(group.name, { color: next });
    schedulePersist();
  };

  return (
    <>
      <li class="ddd-group-row">
        <button
          class="ddd-group-chevron"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse list' : 'Expand table list'}
        >{expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}</button>
        <label class="ddd-group-swatch-wrap" title={`Pick color for ${group.name}`}>
          <span class="ddd-group-swatch" style={{ background: color }} />
          <input
            type="color"
            class="ddd-group-color-input"
            value={normalizeToHex(color)}
            onInput={onColorChange}
          />
        </label>
        <span class="ddd-group-name" title={`${group.tables.length} tables`}>{group.name}</span>
        <span class="ddd-group-count">{group.tables.length}</span>
        <button
          class={`ddd-icon-btn ${hidden ? 'is-off' : ''}`}
          onClick={toggleHidden}
          title={hidden ? 'Show group' : 'Hide group'}
        >{hidden ? <IconEyeClosed size={12} /> : <IconEye size={12} />}</button>
        <button
          class={`ddd-icon-btn ${collapsed ? 'is-on' : ''}`}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand group' : 'Collapse group'}
        >{collapsed ? <IconExpandAll size={12} /> : <IconCollapseAll size={12} />}</button>
      </li>
      {expanded ? (
        <li class="ddd-group-children">
          <ul class="ddd-table-list">
            {group.tables.map((name) => (
              <TableRow key={name} tableName={name} hidden={hiddenTables.has(name)} />
            ))}
          </ul>
        </li>
      ) : null}
    </>
  );
}

function TableRow({ tableName, hidden }: { tableName: string; hidden: boolean }) {
  const shortName = tableName.startsWith('public.') ? tableName.slice(7) : tableName;
  const toggle = () => {
    store.getState().setTableHidden(tableName, !hidden);
    schedulePersist();
  };
  return (
    <li class="ddd-table-row">
      <span class="ddd-table-row__name" title={tableName}>{shortName}</span>
      <button
        class={`ddd-icon-btn ${hidden ? 'is-off' : ''}`}
        onClick={toggle}
        title={hidden ? 'Show table' : 'Hide table'}
      >{hidden ? <IconEyeClosed size={11} /> : <IconEye size={11} />}</button>
    </li>
  );
}

export function colorForGroup(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 60%)`;
}

/** Convert hsl(...) to #rrggbb so <input type="color"> accepts it. Pass-through for hex. */
function normalizeToHex(color: string): string {
  if (color.startsWith('#')) return color.length === 4 ? expandShortHex(color) : color.slice(0, 7);
  const m = /^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/.exec(color);
  if (!m) return '#888888';
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mOff = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + mOff) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function expandShortHex(hex: string): string {
  return '#' + hex.slice(1).split('').map((c) => c + c).join('');
}
