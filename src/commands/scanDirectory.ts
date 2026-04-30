import * as vscode from "vscode";

export async function scanDirectory(_context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }
  const root = folders[0].uri.fsPath;

  const dir = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(root),
    openLabel: "Scan this directory",
  });
  if (!dir || dir.length === 0) return;

  vscode.window.showInformationMessage(
    `Legion: Scan Directory (${dir[0].fsPath}) — v0.1.0 scaffold. Implementation in v0.2.0.`
  );
  // TODO v0.2.0:
  //  1. Same as document.ts but scoped to dir[0].fsPath (filter walk to within this subtree).
  //  2. mode: "scan-directory" in the payload.
}
