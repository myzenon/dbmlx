import * as vscode from 'vscode';
import { DiagramPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dddbml.openDiagram', async () => {
      const uri = resolveActiveDbmlUri();
      if (!uri) {
        vscode.window.showErrorMessage('dddbml: open a .dbml file first.');
        return;
      }
      DiagramPanel.createOrShow(context, uri);
    }),

    vscode.commands.registerCommand('dddbml.resetLayout', async () => {
      const uri = resolveActiveDbmlUri();
      if (!uri) return;
      DiagramPanel.get(uri)?.resetLayout();
    }),

    vscode.commands.registerCommand('dddbml.pruneOrphans', async () => {
      const uri = resolveActiveDbmlUri();
      if (!uri) return;
      DiagramPanel.get(uri)?.pruneOrphans();
    }),
  );
}

export function deactivate(): void {
  DiagramPanel.disposeAll();
}

function resolveActiveDbmlUri(): vscode.Uri | null {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.dbml')) {
    return editor.document.uri;
  }
  return null;
}
