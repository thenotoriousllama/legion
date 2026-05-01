import * as vscode from "vscode";
import { foldLog } from "../driver/logFold";

export async function runFoldLog(context: vscode.ExtensionContext): Promise<void> {
  void context;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }
  const repoRoot = folders[0].uri.fsPath;
  const cfg = vscode.workspace.getConfiguration("legion");
  const defaultK = cfg.get<number>("logFoldK", 3);

  // Step 1: Choose dry-run or commit
  const mode = await vscode.window.showQuickPick(
    [
      { label: "$(eye) Dry-run", description: "Preview fold content without writing", id: "dry" },
      { label: "$(check) Commit", description: "Write fold page and update log.md + index.md", id: "commit" },
    ],
    { placeHolder: "Fold mode" }
  );
  if (!mode) return;

  // Step 2: Choose k value
  const kOptions = [1, 2, 3, 4, 5].map((k) => ({
    label: `k=${k} → ${Math.pow(2, k)} entries`,
    k,
    picked: k === defaultK,
  }));
  const kPick = await vscode.window.showQuickPick(kOptions, {
    placeHolder: `How many entries to fold? (default: k=${defaultK})`,
  });
  if (!kPick) return;

  const k = kPick.k;
  const dryRun = mode.id === "dry";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: ${dryRun ? "Previewing" : "Writing"} log fold k=${k}…`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await foldLog(repoRoot, k, dryRun);

        if (dryRun) {
          // Show the proposed fold content in a new untitled document
          const doc = await vscode.workspace.openTextDocument({
            content: result.content,
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          vscode.window.showInformationMessage(
            `Legion: Fold preview — ${result.entryCount} entries → ${result.foldId} (not written).`
          );
        } else if (!result.wrote) {
          vscode.window.showInformationMessage(
            `Legion: Fold already exists — ${result.foldId}. Nothing written.`
          );
        } else {
          vscode.window.showInformationMessage(
            `Legion: Log folded — ${result.entryCount} entries → wiki/folds/${result.foldId}.md`
          );
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: Fold failed — ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
}
