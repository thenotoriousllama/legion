import * as vscode from "vscode";
import { runDocumentPass } from "../driver/documentPass";

export async function updateDocumentation(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }
  await runDocumentPass(folders[0].uri.fsPath, "update", undefined, context);
}
