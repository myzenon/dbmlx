import * as vscode from 'vscode';
import type { HostToWebview, Layout, ViewportCommand, WebviewToHost } from '../shared/types';
import { emptyLayout, readLayout, sidecarUri, writeLayout } from './layoutStore';
import type { WorkspaceIndex } from './workspaceIndex';

const PERSIST_DEBOUNCE_MS = 200;

export class DiagramPanel {
  private static panels = new Map<string, DiagramPanel>();

  public static createOrShow(context: vscode.ExtensionContext, dbmlUri: vscode.Uri, index: WorkspaceIndex): void {
    const key = dbmlUri.toString();
    const existing = DiagramPanel.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = new DiagramPanel(context, dbmlUri, index);
    DiagramPanel.panels.set(key, panel);
  }

  public static get(dbmlUri: vscode.Uri): DiagramPanel | undefined {
    return DiagramPanel.panels.get(dbmlUri.toString());
  }

  public static getActive(): DiagramPanel | undefined {
    for (const panel of DiagramPanel.panels.values()) {
      if (panel.webviewPanel.active) return panel;
    }
    return undefined;
  }

  public static disposeAll(): void {
    for (const panel of DiagramPanel.panels.values()) panel.dispose();
    DiagramPanel.panels.clear();
  }

  private readonly webviewPanel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private currentLayout: Layout = emptyLayout();
  private lastWrittenSerialized: string | null = null;
  private pendingPersist: Layout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private activeView: string | null = null;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dbmlUri: vscode.Uri,
    private readonly index: WorkspaceIndex,
  ) {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    this.webviewPanel = vscode.window.createWebviewPanel(
      'dbmlx.diagram',
      `dbmlx — ${this.shortName(dbmlUri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [distRoot],
      },
    );

    this.webviewPanel.webview.html = this.renderHtml();
    this.webviewPanel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.handleWebviewMessage(msg),
      null,
      this.disposables,
    );
    this.webviewPanel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.post({ type: 'theme:change', payload: { kind: this.currentThemeKind() } });
      }),
    );

    this.setupWatchers();
  }

  public reveal(): void {
    this.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  public sendViewportCommand(action: ViewportCommand): void {
    this.post({ type: 'viewport:command', payload: { action } });
  }

  public exportSvg(): void {
    this.post({ type: 'export:request' });
  }

  public async resetLayout(): Promise<void> {
    this.currentLayout = { ...this.currentLayout, tables: {} };
    await this.flushPersist(this.currentLayout);
    this.post({ type: 'layout:loaded', payload: this.currentLayout });
    void vscode.window.showInformationMessage('dbmlx: layout reset — auto-layout will re-run.');
  }

  public async pruneOrphans(): Promise<void> {
    const { schema } = this.index.getResolvedSchema(this.dbmlUri);
    const liveTables = new Set(schema.tables.map((t) => t.name));
    const liveGroups = new Set(schema.groups.map((g) => g.name));
    const nextTables: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(this.currentLayout.tables)) {
      if (liveTables.has(k)) nextTables[k] = v;
    }
    const nextGroups: typeof this.currentLayout.groups = {};
    for (const [k, v] of Object.entries(this.currentLayout.groups)) {
      if (liveGroups.has(k)) nextGroups[k] = v;
    }
    const removedTables = Object.keys(this.currentLayout.tables).length - Object.keys(nextTables).length;
    const removedGroups = Object.keys(this.currentLayout.groups).length - Object.keys(nextGroups).length;
    this.currentLayout = { ...this.currentLayout, tables: nextTables, groups: nextGroups };
    await this.flushPersist(this.currentLayout);
    this.post({ type: 'layout:loaded', payload: this.currentLayout });
    void vscode.window.showInformationMessage(`dbmlx: pruned ${removedTables} orphan table(s), ${removedGroups} orphan group(s).`);
  }

  public dispose(): void {
    DiagramPanel.panels.delete(this.dbmlUri.toString());
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { /* noop */ }
    }
    try { this.webviewPanel.dispose(); } catch { /* noop */ }
  }

  private post(msg: HostToWebview): void {
    void this.webviewPanel.webview.postMessage(msg);
  }

  private handleWebviewMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        void this.hydrate();
        return;
      case 'layout:persist':
        this.onLayoutPersist(msg.payload);
        return;
      case 'command:pruneOrphans':
        void this.pruneOrphans();
        return;
      case 'command:resetLayout':
        void this.resetLayout();
        return;
      case 'command:reveal':
        void this.revealTable(msg.payload.tableName);
        return;
      case 'error:log':
        console.error('[dbmlx webview]', msg.payload.message, msg.payload.stack);
        return;
      case 'export:svg':
        void this.saveSvg(msg.payload.svg);
        return;
      case 'export:png':
        void this.savePng(msg.payload.data);
        return;
      case 'view:switch':
        void this.onViewSwitch(msg.payload.view);
        return;
      default:
        return;
    }
  }

  private async revealTable(qualifiedName: string): Promise<void> {
    try {
      const loc = this.index.getTableLocation(qualifiedName);
      if (!loc) {
        void vscode.window.showWarningMessage(`dbmlx: could not find "${qualifiedName}" in source.`);
        return;
      }
      const pos = new vscode.Position(loc.line, 0);
      await vscode.window.showTextDocument(loc.uri, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dbmlx: reveal failed — ${message}`);
    }
  }

  private async hydrate(): Promise<void> {
    // Send layout first so positions are in the store before schema triggers auto-layout.
    await this.sendLayout();
    this.sendSchema();
    this.post({ type: 'theme:change', payload: { kind: this.currentThemeKind() } });
  }

  private sendSchema(): void {
    const { schema, errors } = this.index.getResolvedSchema(this.dbmlUri);
    // Surface the first error from the root file or any include
    const rootError = errors.get(this.dbmlUri.toString())?.error ?? null;
    const firstError = rootError ?? (errors.size > 0 ? [...errors.values()][0]!.error : null);
    this.post({ type: 'schema:update', payload: { schema, parseError: firstError } });
  }

  private async onViewSwitch(view: string | null): Promise<void> {
    await this.flushPendingNow();
    this.activeView = view;
    await this.sendLayout();
  }

  private async flushPendingNow(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    const next = this.pendingPersist;
    this.pendingPersist = null;
    if (next) await this.flushPersist(next);
  }

  private async sendLayout(isExternal = false): Promise<void> {
    this.currentLayout = await readLayout(this.dbmlUri, this.activeView);
    this.post({
      type: isExternal ? 'layout:external-change' : 'layout:loaded',
      payload: this.currentLayout,
    });
  }

  private onLayoutPersist(payload: Partial<Layout>): void {
    const merged: Layout = {
      version: 1,
      viewport: payload.viewport ?? this.currentLayout.viewport,
      tables: payload.tables ?? this.currentLayout.tables,
      groups: payload.groups ?? this.currentLayout.groups,
      edges: payload.edges ?? this.currentLayout.edges,
      viewSettings: payload.viewSettings !== undefined ? payload.viewSettings : this.currentLayout.viewSettings,
    };
    this.currentLayout = merged;
    this.pendingPersist = merged;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const next = this.pendingPersist;
      this.pendingPersist = null;
      if (next) void this.flushPersist(next);
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(layout: Layout): Promise<void> {
    try {
      const serialized = await writeLayout(this.dbmlUri, layout, this.activeView);
      this.lastWrittenSerialized = serialized;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dbmlx: failed to write layout file — ${message}`);
    }
  }

  private async savePng(dataUrl: string): Promise<void> {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    const defaultUri = vscode.Uri.joinPath(
      this.dbmlUri,
      '..',
      this.shortName(this.dbmlUri).replace(/\.dbmlx$/i, '.png'),
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'PNG Image': ['png'] },
      title: 'Export diagram as PNG',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, bytes);
    void vscode.window.showInformationMessage(`dbmlx: diagram exported to ${this.shortName(uri)}`);
  }

  private async saveSvg(svg: string): Promise<void> {
    const defaultUri = vscode.Uri.joinPath(
      this.dbmlUri,
      '..',
      this.shortName(this.dbmlUri).replace(/\.dbmlx$/i, '.svg'),
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'SVG Image': ['svg'] },
      title: 'Export diagram as SVG',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(svg));
    void vscode.window.showInformationMessage(`dbmlx: diagram exported to ${this.shortName(uri)}`);
  }

  private setupWatchers(): void {
    // Re-send schema whenever any .dbmlx file in the index changes (includes may affect us)
    this.disposables.push(
      this.index.onChange(() => this.sendSchema()),
    );

    // Watch layout sidecar for external changes (git pull, etc.)
    const parentUri = vscode.Uri.joinPath(this.dbmlUri, '..');
    const schemaBasename = this.shortName(this.dbmlUri);
    const layoutWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, `${schemaBasename}*.layout.json`),
    );
    const onLayoutFs = async (uri: vscode.Uri) => {
      const currentSidecar = sidecarUri(this.dbmlUri, this.activeView);
      if (uri.toString() !== currentSidecar.toString()) return;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(bytes);
        if (this.lastWrittenSerialized !== null && text === this.lastWrittenSerialized) return;
      } catch {
        return;
      }
      await this.sendLayout(true);
    };
    layoutWatcher.onDidChange(onLayoutFs);
    layoutWatcher.onDidCreate(onLayoutFs);
    this.disposables.push(layoutWatcher);
  }

  private currentThemeKind(): 'light' | 'dark' {
    return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'light';
  }

  private shortName(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    return parts[parts.length - 1] ?? 'diagram';
  }

  private renderHtml(): string {
    const webview = this.webviewPanel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
    );
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>dbmlx</title>
<style>
  html, body, #root { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
