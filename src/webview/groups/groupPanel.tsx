import { useMemo, useState } from 'preact/hooks';
import type { TableGroup } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../drag/dragController';
import { ColorPopup, popupAnchorFor } from '../render/colorPopup';
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCollapseAll,
  IconExpandAll,
  IconEye,
  IconEyeClosed,
  IconFocus,
  IconSearch,
} from '../icons';
import { focusGroup, focusTable } from '../render/viewport';

type AnnotationFilter = 'add' | 'drop' | 'modified';

export function GroupPanel() {
  const groups = useAppStore((s) => s.schema.groups);
  const allTables = useAppStore((s) => s.schema.tables);
  const groupState = useAppStore((s) => s.groups);
  const hiddenTables = useAppStore((s) => s.hiddenTables);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [annFilters, setAnnFilters] = useState<Set<AnnotationFilter>>(new Set());

  const ungroupedTables = useMemo(
    () => allTables.filter((t) => t.groupName === null).map((t) => t.name),
    [allTables],
  );

  // Map table qualified name → which annotation filters it matches
  const tableAnnotations = useMemo(() => {
    const map = new Map<string, Set<AnnotationFilter>>();
    for (const t of allTables) {
      const flags = new Set<AnnotationFilter>();
      if (t.tableChange === 'add') flags.add('add');
      if (t.tableChange === 'drop') flags.add('drop');
      if (t.tableChange === 'modify' || (t.columnChanges && Object.keys(t.columnChanges).length > 0)) flags.add('modified');
      if (flags.size) map.set(t.name, flags);
    }
    return map;
  }, [allTables]);

  const toggleAnnFilter = (f: AnnotationFilter) => {
    setAnnFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const tablePassesFilters = (name: string): boolean => {
    if (!annFilters.size) return true;
    const flags = tableAnnotations.get(name);
    if (!flags) return false;
    for (const f of annFilters) if (flags.has(f)) return true;
    return false;
  };

  if (groups.length === 0 && ungroupedTables.length === 0) return null;

  const lcQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return groups.filter((g) => {
      // Group name matches query → show group (all table filters still apply inside GroupRow)
      if (lcQuery && g.name.toLowerCase().includes(lcQuery) && !annFilters.size) return true;
      return g.tables.some((t) => {
        const nameOk = !lcQuery || g.name.toLowerCase().includes(lcQuery) || t.toLowerCase().includes(lcQuery);
        return nameOk && tablePassesFilters(t);
      });
    });
  }, [groups, lcQuery, annFilters, tableAnnotations]);

  const filteredUngrouped = useMemo(() => {
    return ungroupedTables.filter((t) => {
      const nameOk = !lcQuery || t.toLowerCase().includes(lcQuery);
      return nameOk && tablePassesFilters(t);
    });
  }, [ungroupedTables, lcQuery, annFilters, tableAnnotations]);

  const anyVisible = groups.some((g) => !(groupState[g.name]?.hidden));
  const anyExpanded = groups.some((g) => !(groupState[g.name]?.collapsed));

  const toggleAllHidden = () => {
    const target = anyVisible; // true = hide all, false = show all
    for (const g of groups) {
      store.getState().setGroup(g.name, { hidden: target });
      for (const t of g.tables) store.getState().setTableHidden(t, target);
    }
    schedulePersist();
  };
  const toggleAllCollapsed = () => {
    const target = anyExpanded;
    for (const g of groups) store.getState().setGroup(g.name, { collapsed: target });
    schedulePersist();
  };

  if (!open) {
    return (
      <div class="ddd-group-panel is-closed">
        <button class="ddd-group-panel__handle" onClick={() => setOpen(true)} title="Open Table Groups">
          <IconChevronRight size={12} />
          <span>Groups</span>
        </button>
      </div>
    );
  }

  return (
    <div class="ddd-group-panel is-open">
      <div class="ddd-group-panel__head">
        <span class="ddd-group-panel__title">Table Groups</span>
        <div class="ddd-group-panel__actions">
          <button class="ddd-icon-btn" onClick={toggleAllHidden} title={anyVisible ? 'Hide all' : 'Show all'}>
            {anyVisible ? <IconEye size={13} /> : <IconEyeClosed size={13} />}
          </button>
          <button class="ddd-icon-btn" onClick={toggleAllCollapsed} title={anyExpanded ? 'Collapse all groups' : 'Expand all groups'}>
            {anyExpanded ? <IconCollapseAll size={13} /> : <IconExpandAll size={13} />}
          </button>
          <button class="ddd-icon-btn" onClick={() => setOpen(false)} title="Close">
            <IconClose size={12} />
          </button>
        </div>
      </div>
      <label class="ddd-search">
        <span class="ddd-search__icon"><IconSearch size={12} /></span>
        <input
          class="ddd-search__input"
          type="text"
          placeholder="Search table or group"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <div class="ddd-ann-chips">
        <button
          class={`ddd-ann-chip ddd-ann-chip--add${annFilters.has('add') ? ' is-active' : ''}`}
          onClick={() => toggleAnnFilter('add')}
          title="Show only tables being added"
        >+NEW</button>
        <button
          class={`ddd-ann-chip ddd-ann-chip--drop${annFilters.has('drop') ? ' is-active' : ''}`}
          onClick={() => toggleAnnFilter('drop')}
          title="Show only tables being dropped"
        >DROP</button>
        <button
          class={`ddd-ann-chip ddd-ann-chip--modified${annFilters.has('modified') ? ' is-active' : ''}`}
          onClick={() => toggleAnnFilter('modified')}
          title="Show only tables with column changes"
        >DIFF</button>
      </div>
      <ul class="ddd-group-list">
        {filtered.length === 0 && filteredUngrouped.length === 0 ? (
          <li class="ddd-group-empty">No matches{query ? ` for "${query}"` : ''}</li>
        ) : null}
        {filtered.map((g) => (
          <GroupRow
            key={g.name}
            group={g}
            state={groupState[g.name]}
            hiddenTables={hiddenTables}
            initialExpanded={lcQuery.length > 0 || annFilters.size > 0}
            filter={lcQuery}
            annFilters={annFilters}
            tableAnnotations={tableAnnotations}
          />
        ))}
        {filteredUngrouped.length > 0 ? (
          <NoGroupRow
            tables={filteredUngrouped}
            hiddenTables={hiddenTables}
            initialExpanded={lcQuery.length > 0 || annFilters.size > 0}
            filter={lcQuery}
            tableAnnotations={tableAnnotations}
          />
        ) : null}
      </ul>
    </div>
  );
}

function NoGroupRow({ tables, hiddenTables, initialExpanded, filter, tableAnnotations }: { tables: string[]; hiddenTables: Set<string>; initialExpanded: boolean; filter: string; tableAnnotations: Map<string, Set<AnnotationFilter>> }) {
  const [userExpanded, setUserExpanded] = useState(initialExpanded);
  const expanded = filter.length > 0 ? true : userExpanded;

  const anyVisible = tables.some((t) => !hiddenTables.has(t));
  const toggleAllHidden = () => {
    for (const t of tables) store.getState().setTableHidden(t, anyVisible);
    schedulePersist();
  };

  return (
    <>
      <li class="ddd-group-row">
        <button
          class="ddd-group-chevron"
          onClick={() => setUserExpanded(!userExpanded)}
          title={expanded ? 'Collapse list' : 'Expand table list'}
        >{expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}</button>
        <span class="ddd-group-swatch" style={{ background: 'var(--vscode-badge-background, #888)' }} />
        <span class="ddd-group-name ddd-group-name--ungrouped">No Group</span>
        <span class="ddd-group-count">{tables.length}</span>
        <button
          class={`ddd-icon-btn ${anyVisible ? '' : 'is-off'}`}
          onClick={toggleAllHidden}
          title={anyVisible ? 'Hide all ungrouped' : 'Show all ungrouped'}
        >{anyVisible ? <IconEye size={12} /> : <IconEyeClosed size={12} />}</button>
      </li>
      {expanded ? (
        <li class="ddd-group-children">
          <ul class="ddd-table-list">
            {tables.map((name) => (
              <TableRow key={name} tableName={name} hidden={hiddenTables.has(name)} annFlags={tableAnnotations.get(name)} />
            ))}
          </ul>
        </li>
      ) : null}
    </>
  );
}

interface GroupRowProps {
  group: TableGroup;
  state: { collapsed?: boolean; hidden?: boolean; color?: string } | undefined;
  hiddenTables: Set<string>;
  initialExpanded: boolean;
  filter: string;
  annFilters: Set<AnnotationFilter>;
  tableAnnotations: Map<string, Set<AnnotationFilter>>;
}

function GroupRow({ group, state, hiddenTables, initialExpanded, filter, annFilters, tableAnnotations }: GroupRowProps) {
  const [userExpanded, setUserExpanded] = useState(initialExpanded);
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const hidden = state?.hidden ?? false;
  const collapsed = state?.collapsed ?? false;
  const color = state?.color ?? colorForGroup(group.name);
  // While a filter is active, always expand so matching tables are visible.
  const expanded = filter.length > 0 ? true : userExpanded;

  const toggleHidden = () => {
    const next = !hidden;
    store.getState().setGroup(group.name, { hidden: next });
    for (const t of group.tables) store.getState().setTableHidden(t, next);
    schedulePersist();
  };
  const toggleCollapsed = () => {
    store.getState().setGroup(group.name, { collapsed: !collapsed });
    schedulePersist();
  };
  const applyColor = (c: string) => {
    store.getState().setGroup(group.name, { color: c });
    schedulePersist();
  };
  const resetColor = () => {
    store.getState().setGroup(group.name, { color: undefined });
    schedulePersist();
  };
  const onGearClick = (e: MouseEvent) => {
    e.stopPropagation();
    const rowEl = (e.currentTarget as HTMLElement).closest('.ddd-group-row') as HTMLElement | null;
    const anchorRect = rowEl?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup(popupAnchorFor(anchorRect));
  };

  const memberTables = (filter || annFilters.size)
    ? group.tables.filter((t) => {
        const nameOk = !filter || group.name.toLowerCase().includes(filter) || t.toLowerCase().includes(filter);
        const annOk = !annFilters.size || (() => {
          const flags = tableAnnotations.get(t);
          if (!flags) return false;
          for (const f of annFilters) if (flags.has(f)) return true;
          return false;
        })();
        return nameOk && annOk;
      })
    : group.tables;

  return (
    <>
      <li class="ddd-group-row">
        <button
          class="ddd-group-chevron"
          onClick={() => setUserExpanded(!userExpanded)}
          title={expanded ? 'Collapse list' : 'Expand table list'}
        >{expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}</button>
        <button class="ddd-group-swatch" style={{ background: color }} title="Change color" onClick={onGearClick} />
        <button class="ddd-group-name ddd-group-name--btn" title={`Focus ${group.name}`} onClick={() => focusGroup(group.name)}>{group.name}</button>
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
      {popup ? (
        <ColorPopup
          current={color}
          x={popup.x}
          y={popup.y}
          onPick={applyColor}
          onReset={resetColor}
          onClose={() => setPopup(null)}
        />
      ) : null}
      {expanded ? (
        <li class="ddd-group-children">
          <ul class="ddd-table-list">
            {memberTables.map((name) => (
              <TableRow key={name} tableName={name} hidden={hiddenTables.has(name)} annFlags={tableAnnotations.get(name)} groupName={group.name} groupColor={color} />
            ))}
          </ul>
        </li>
      ) : null}
    </>
  );
}

function TableRow({ tableName, hidden, annFlags, groupName, groupColor }: { tableName: string; hidden: boolean; annFlags?: Set<AnnotationFilter>; groupName?: string; groupColor?: string }) {
  const tableColors = useAppStore((s) => s.tableColors);
  const effectiveColor = tableColors.get(tableName) ?? groupColor;
  const shortName = tableName.startsWith('public.') ? tableName.slice(7) : tableName;
  const toggle = () => {
    const next = !hidden;
    store.getState().setTableHidden(tableName, next);
    if (groupName) {
      const s = store.getState();
      const gs = s.groups[groupName];
      if (!next && gs?.hidden) {
        s.setGroup(groupName, { hidden: false });
      } else if (next) {
        const groupTables = s.schema.groups.find((g) => g.name === groupName)?.tables ?? [];
        const allHidden = groupTables.every((t) => t === tableName || s.hiddenTables.has(t));
        if (allHidden) s.setGroup(groupName, { hidden: true });
      }
    }
    schedulePersist();
  };
  const badge = annFlags?.has('add') ? 'add' : annFlags?.has('drop') ? 'drop' : annFlags?.has('modified') ? 'modified' : null;
  return (
    <li class="ddd-table-row" style={effectiveColor ? { borderLeftColor: effectiveColor } : undefined}>
      <button class="ddd-table-row__name" title={`Focus ${tableName}`} onClick={() => focusTable(tableName)}>{shortName}</button>
      {badge ? <span class={`ddd-table-ann-dot ddd-table-ann-dot--${badge}`} title={badge === 'add' ? 'New table' : badge === 'drop' ? 'Table removed' : 'Has column changes'} /> : null}
      <button
        class={`ddd-icon-btn ${hidden ? 'is-off' : ''}`}
        onClick={toggle}
        title={hidden ? 'Show table' : 'Hide table'}
      >{hidden ? <IconEyeClosed size={11} /> : <IconEye size={11} />}</button>
      <button class="ddd-icon-btn ddd-focus-btn" title={`Focus ${tableName}`} onClick={() => focusTable(tableName)}><IconFocus size={11} /></button>
    </li>
  );
}

export function colorForGroup(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 60%)`;
}
