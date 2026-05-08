import * as vscode from 'vscode';
import { DiagramPanel } from './panel';
import { WorkspaceIndex } from './workspaceIndex';
import { registerLspProviders } from './lspProviders';
import { registerSqlConverterCommands } from './sqlConverter';
import type { QualifiedName } from '../shared/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = await WorkspaceIndex.create(context);
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
    vscode.commands.registerCommand('dbmlx.exportPng',    () => DiagramPanel.getActive()?.exportPng()),

    vscode.commands.registerCommand('dbmlx.focusTableInDiagram', (rawName?: string) => {
      if (typeof rawName !== 'string') {
        vscode.window.showInformationMessage('Click the "Focus in diagram" CodeLens link above a Table definition.');
        return;
      }
      const stripped = rawName.replace(/"/g, '');
      // Search every open diagram (regardless of whether it was opened on a root
      // or a module file) for a table matching the clicked header.
      const candidates = [stripped, `public.${stripped}`] as QualifiedName[];
      const found = DiagramPanel.findTableAndPanel(candidates);
      if (!found) {
        if (DiagramPanel.count === 0) {
          vscode.window.showWarningMessage('dbmlx: diagram not open — run "DBMLX: Open Diagram" first.');
        } else {
          vscode.window.showWarningMessage(`dbmlx: table "${stripped}" not found in any open diagram.`);
        }
        return;
      }
      found.panel.focusTableInDiagram(found.table.name);
    }),
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
