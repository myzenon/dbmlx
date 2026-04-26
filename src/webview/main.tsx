import { render } from 'preact';
import { App } from './app';
import styleSource from './style.css?inline';
import { store } from './state/store';
import { postToHost } from './vscode';
import { fitToContent, focusTable, resetView, zoomAtCenter } from './render/viewport';
import { generateSvg, svgToPngDataUrl } from './render/exportSvg';
import type { HostToWebview } from '../shared/types';

{
  const s = document.createElement('style');
  s.textContent = styleSource;
  document.head.appendChild(s);
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  const state = store.getState();
  switch (msg.type) {
    case 'schema:update':
      state.setSchema(msg.payload.schema, msg.payload.parseError);
      return;
    case 'layout:loaded':
    case 'layout:external-change':
      state.setLayout(msg.payload);
      return;
    case 'theme:change':
      state.setTheme(msg.payload.kind);
      return;
    case 'viewport:command': {
      const el = document.querySelector<HTMLElement>('.ddd-viewport');
      if (!el) return;
      switch (msg.payload.action) {
        case 'zoomIn':       zoomAtCenter(1.2, el); return;
        case 'zoomOut':      zoomAtCenter(1 / 1.2, el); return;
        case 'resetView':    resetView(); return;
        case 'fitToContent': fitToContent(el); return;
      }
      return;
    }
    case 'export:request':
      postToHost({ type: 'export:svg', payload: { svg: generateSvg(store.getState()) } });
      return;
    case 'export:png:request':
      void svgToPngDataUrl(generateSvg(store.getState())).then((data) =>
        postToHost({ type: 'export:png', payload: { data } }));
      return;
    case 'diagram:focusTable':
      focusTable(msg.name);
      return;
  }
});

window.addEventListener('error', (ev) => {
  postToHost({ type: 'error:log', payload: { message: String(ev.message), stack: ev.error?.stack } });
});

const root = document.getElementById('root');
if (root) render(<App post={postToHost} />, root);

postToHost({ type: 'ready' });
