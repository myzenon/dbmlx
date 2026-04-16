import { render } from 'preact';
import { App } from './app';
import styleSource from './style.css?inline';
import { store } from './state/store';
import { postToHost } from './vscode';
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
  }
});

window.addEventListener('error', (ev) => {
  postToHost({ type: 'error:log', payload: { message: String(ev.message), stack: ev.error?.stack } });
});

const root = document.getElementById('root');
if (root) render(<App post={postToHost} />, root);

postToHost({ type: 'ready' });
