import * as vscode from "vscode";
import { runDocumentPass } from "../driver/documentPass";

export async function scanDirectory(context: vscode.ExtensionContext): Promise<void> {
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

  await runDocumentPass(root, "scan-directory", dir[0].fsPath, context);
}
