import type { WebviewToHost } from '../shared/types';

declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage: (msg: unknown) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    };
  }
}

let api: ReturnType<Window['acquireVsCodeApi']> | null = null;

function getApi(): ReturnType<Window['acquireVsCodeApi']> {
  if (!api) api = window.acquireVsCodeApi();
  return api;
}

export function postToHost(msg: WebviewToHost): void {
  getApi().postMessage(msg);
}
