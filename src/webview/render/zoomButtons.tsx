import { useAppStore } from '../state/store';
import { fitToContent, resetView, zoomAtCenter } from './viewport';
import { IconFitScreen, IconMinus, IconPlus } from '../icons';

export function ZoomButtons() {
  const viewport = useAppStore((s) => s.viewport);
  const getEl = () => document.querySelector<HTMLElement>('.ddd-viewport');

  return (
    <div class="ddd-zoom">
      <button class="ddd-zoom__btn" title="Zoom out (Ctrl+-)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1 / 1.2, el); }}>
        <IconMinus size={13} />
      </button>
      <button class="ddd-zoom__btn ddd-zoom__pct" title="Reset view (Ctrl+0)" onClick={() => resetView()}>{Math.round(viewport.zoom * 100)}%</button>
      <button class="ddd-zoom__btn" title="Zoom in (Ctrl+=)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1.2, el); }}>
        <IconPlus size={13} />
      </button>
      <button class="ddd-zoom__btn" title="Fit to content (Ctrl+1)" onClick={() => { const el = getEl(); if (el) fitToContent(el); }}>
        <IconFitScreen size={13} />
      </button>
    </div>
  );
}
