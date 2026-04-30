import * as vscode from "vscode";
import { runInitializer } from "../driver/initializer";

export async function initialize(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: "Multiple folders open — pick the repo root to initialize." }
    );
    if (!pick) return;
    await runInitializer(pick.folder.uri.fsPath, context);
  } else {
    await runInitializer(folders[0].uri.fsPath, context);
  }
}
