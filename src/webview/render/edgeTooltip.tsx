import { useAppStore } from '../state/store';

const GROUP_PREFIX = '__group__:';

function displayEndpoint(table: string, cols: string[]): string {
  const t = table.startsWith(GROUP_PREFIX)
    ? `[${table.slice(GROUP_PREFIX.length)}]`
    : table.replace(/^public\./, '');
  return cols.length === 1 ? `${t}.${cols[0]}` : `${t}.(${cols.join(', ')})`;
}

export function EdgeTooltip() {
  const ref = useAppStore((s) => s.hoveredEdgeRef);
  const pos = useAppStore((s) => s.edgeTooltipPos);

  if (!ref || !pos) return null;

  const src = displayEndpoint(ref.source.table, ref.source.columns);
  const tgt = displayEndpoint(ref.target.table, ref.target.columns);
  const srcCard = ref.source.relation === '*' ? 'N' : '1';
  const tgtCard = ref.target.relation === '*' ? 'N' : '1';

  return (
    <div
      class="ddd-edge-tooltip"
      style={{ left: `${pos.x + 14}px`, top: `${pos.y - 10}px` }}
    >
      <span class="ddd-edge-tooltip__path">{src} → {tgt}</span>
      <span class="ddd-edge-tooltip__card">{srcCard} : {tgtCard}</span>
    </div>
  );
}
