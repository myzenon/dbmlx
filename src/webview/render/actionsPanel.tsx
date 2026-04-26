import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { IconChevronDown, IconChevronUp, IconExport } from '../icons';
import { postToHost } from '../vscode';
import { generateSvg, svgToPngDataUrl } from './exportSvg';

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button class="ddd-toggle-row" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span class={`ddd-toggle__track${checked ? ' is-on' : ''}`} />
      <span class="ddd-toggle__text">
        <span class="ddd-toggle__label">{label}</span>
        {hint ? <span class="ddd-toggle__hint">{hint}</span> : null}
      </span>
    </button>
  );
}

export function ActionsPanel() {
  const [open, setOpen] = useState(false);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const showGroupBoundary = useAppStore((s) => s.showGroupBoundary);
  const showCardinalityLabels = useAppStore((s) => s.showCardinalityLabels);
  const mergeConvergentEdges = useAppStore((s) => s.mergeConvergentEdges);
  const showDropRefs = useAppStore((s) => s.showDropRefs);
  const colorizeAddRefs = useAppStore((s) => s.colorizeAddRefs);

  return (
    <div class={`ddd-actions-panel ${open ? 'is-open' : 'is-closed'}`}>
      <button
        class="ddd-actions-panel__handle"
        onClick={() => setOpen(!open)}
        title={open ? 'Hide actions' : 'Show actions'}
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
      </button>
      {open ? (
        <div class="ddd-actions-panel__body">
          <div class="ddd-actions-panel__section">
            <div class="ddd-actions-panel__section-title">View</div>
            <Toggle checked={showOnlyPkFk} onChange={() => store.getState().toggleShowOnlyPkFk()} label="Keys only" hint="Show only PK and FK columns" />
            <Toggle checked={showGroupBoundary} onChange={(v) => store.getState().setShowGroupBoundary(v)} label="Group borders" hint="Bounding box per table group" />
            <Toggle checked={showCardinalityLabels} onChange={(v) => store.getState().setShowCardinalityLabels(v)} label="Cardinality" hint="1/N labels on relation lines" />
            <Toggle checked={mergeConvergentEdges} onChange={(v) => store.getState().setMergeConvergentEdges(v)} label="Merge FK lines" hint="Combine shared-endpoint edges" />
            <Toggle checked={showDropRefs} onChange={(v) => store.getState().setShowDropRefs(v)} label="Dropped refs" hint="Show [drop] refs as red lines" />
            <Toggle checked={colorizeAddRefs} onChange={(v) => store.getState().setColorizeAddRefs(v)} label="Added ref color" hint="Color [add] refs green" />
          </div>
          <div class="ddd-actions-panel__divider" />
          <div class="ddd-actions-panel__section">
            <div class="ddd-actions-panel__section-title">Export</div>
            <button
              class="ddd-actions-btn"
              title="Export diagram as SVG"
              onClick={() => {
                const svg = generateSvg(store.getState());
                postToHost({ type: 'export:svg', payload: { svg } });
              }}
            >
              <IconExport size={12} />
              <span>SVG</span>
            </button>
            <button
              class="ddd-actions-btn"
              title="Export diagram as PNG"
              onClick={() => {
                const svg = generateSvg(store.getState());
                svgToPngDataUrl(svg).then((data) => postToHost({ type: 'export:png', payload: { data } }));
              }}
            >
              <IconExport size={12} />
              <span>PNG</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
