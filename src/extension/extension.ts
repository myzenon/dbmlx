import * as vscode from 'vscode';
import { DiagramPanel } from './panel';
import { WorkspaceIndex } from './workspaceIndex';
import { DiagnosticsProvider } from './diagnosticsProvider';
import { registerLspProviders } from './lspProviders';
import { registerSqlConverterCommands } from './sqlConverter';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = await WorkspaceIndex.create(context);
  const _diagnostics = new DiagnosticsProvider(index);
  context.subscriptions.push(_diagnostics);
  registerLspProviders(index, context);
  registerSqlConverterCommands(index, context);

  context.subscriptions.push(
    vscode.commands.registerCommand('dbmlx.openDiagram', async () => {
      const uri = resolveActiveDbmlxUri();
      if (!uri) {
        vscode.window.showErrorMessage('dbmlx: open a .dbmlx file first.');
        return;
      }
      DiagramPanel.createOrShow(context, uri, index);
    }),

    vscode.commands.registerCommand('dbmlx.resetLayout', async () => {
      const active = DiagramPanel.getActive();
      if (active) return active.resetLayout();
      const uri = resolveActiveDbmlxUri();
      if (uri) DiagramPanel.get(uri)?.resetLayout();
    }),

    vscode.commands.registerCommand('dbmlx.pruneOrphans', () => {
      const active = DiagramPanel.getActive();
      if (active) return active.pruneOrphans();
      const uri = resolveActiveDbmlxUri();
      if (uri) DiagramPanel.get(uri)?.pruneOrphans();
    }),

    vscode.commands.registerCommand('dbmlx.zoomIn',       () => DiagramPanel.getActive()?.sendViewportCommand('zoomIn')),
    vscode.commands.registerCommand('dbmlx.zoomOut',      () => DiagramPanel.getActive()?.sendViewportCommand('zoomOut')),
    vscode.commands.registerCommand('dbmlx.resetView',    () => DiagramPanel.getActive()?.sendViewportCommand('resetView')),
    vscode.commands.registerCommand('dbmlx.fitToContent', () => DiagramPanel.getActive()?.sendViewportCommand('fitToContent')),
    vscode.commands.registerCommand('dbmlx.exportSvg',    () => DiagramPanel.getActive()?.exportSvg()),
  );
}

export function deactivate(): void {
  DiagramPanel.disposeAll();
}

function resolveActiveDbmlxUri(): vscode.Uri | null {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.dbmlx')) {
    return editor.document.uri;
  }
  return null;
}
