import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { fitToContent, zoomAtCenter } from './viewport';
import { IconAutoLayout, IconFitScreen, IconLayoutCompact, IconLayoutLR, IconLayoutSnowflake, IconMinus, IconPlus } from '../icons';
import type { LayoutAlgorithm } from '../layout/autoLayout';
import { schedulePersist } from '../drag/dragController';

const ALGORITHMS: Array<{ id: LayoutAlgorithm; label: string; desc: string; icon: () => JSX.Element }> = [
  { id: 'top-down', label: 'Top-down', desc: 'Arrange tables from top to bottom based on relationship direction. Ideal for most diagrams.', icon: () => <IconAutoLayout size={16} /> },
  { id: 'left-right', label: 'Left-right', desc: 'Arrange tables from left to right based on relationship direction. Ideal for diagrams with long relationship lineage like ETL pipelines.', icon: () => <IconLayoutLR size={16} /> },
  { id: 'snowflake', label: 'Snowflake', desc: 'Arrange tables in a snowflake shape, with the most connected tables in the center. Ideal for densely connected diagrams like data warehouses.', icon: () => <IconLayoutSnowflake size={16} /> },
  { id: 'compact', label: 'Compact', desc: 'Arrange tables in a compact rectangle layout. Ideal for diagrams with few relationships and tables.', icon: () => <IconLayoutCompact size={16} /> },
];

function ArrangePicker({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const pick = (algo: LayoutAlgorithm) => {
    store.getState().setLayoutAlgorithm(algo);
    store.getState().resetPositions();
    schedulePersist();
    onClose();
  };

  return (
    <div class="ddd-arrange-picker" ref={ref}>
      <div class="ddd-arrange-picker__title">Choose auto arrange algorithm</div>
      {ALGORITHMS.map((a) => (
        <button key={a.id} class="ddd-arrange-picker__item" onClick={() => pick(a.id)}>
          <span class="ddd-arrange-picker__item-icon">{a.icon()}</span>
          <span class="ddd-arrange-picker__item-body">
            <span class="ddd-arrange-picker__item-name">{a.label}</span>
            <span class="ddd-arrange-picker__item-desc">{a.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ZoomButtons() {
  const viewport = useAppStore((s) => s.viewport);
  const [showArrange, setShowArrange] = useState(false);
  const getEl = () => document.querySelector<HTMLElement>('.ddd-viewport');

  return (
    <div class="ddd-zoom">
      <button class="ddd-zoom__btn" title="Zoom out (Ctrl+-)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1 / 1.2, el); }}>
        <IconMinus size={13} />
      </button>
      <ZoomInput zoom={viewport.zoom} />
      <button class="ddd-zoom__btn" title="Zoom in (Ctrl+=)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1.2, el); }}>
        <IconPlus size={13} />
      </button>
      <button class="ddd-zoom__btn" title="Fit to content (Ctrl+1)" onClick={() => { const el = getEl(); if (el) fitToContent(el); }}>
        <IconFitScreen size={13} />
      </button>
      <div class="ddd-zoom__sep" />
      <div class="ddd-has-popup">
        <button class="ddd-zoom__btn" title="Auto re-arrange diagram" onClick={() => setShowArrange((v) => !v)}>
          <IconAutoLayout size={13} />
        </button>
        {showArrange ? <ArrangePicker onClose={() => setShowArrange(false)} /> : null}
      </div>
    </div>
  );
}

function ZoomInput({ zoom }: { zoom: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayed = draft ?? String(Math.round(zoom * 100));

  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft.replace('%', '').trim());
    if (Number.isFinite(n) && n > 0) {
      const nextZoom = Math.max(0.08, Math.min(4, n / 100));
      store.getState().setViewport({ zoom: nextZoom });
    }
    setDraft(null);
  };

  return (
    <label class="ddd-zoom__pct" title="Set zoom (Enter to apply, Ctrl+0 to reset)">
      <input
        class="ddd-zoom__input"
        type="text"
        value={displayed}
        onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={commit}
      />
      <span class="ddd-zoom__pct-symbol" aria-hidden="true">%</span>
    </label>
  );
}
