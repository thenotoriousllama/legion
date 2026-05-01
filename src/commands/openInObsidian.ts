import * as vscode from "vscode";
import * as path from "path";

/**
 * Open `library/knowledge-base/wiki/` in Obsidian via the obsidian:// URI scheme.
 *
 * Obsidian must be running (or will be launched) and the vault must have been
 * opened in Obsidian at least once so it's registered by name. The vault name
 * is the last path segment of `legion.obsidianVaultPath`.
 *
 * URI used: obsidian://open?vault=<name>&file=library/knowledge-base/wiki/index
 */
export async function openInObsidian(): Promise<void> {
  const config = vscode.workspace.getConfiguration("legion");
  const vaultPath = config.get<string>("obsidianVaultPath", "").trim();

  if (!vaultPath) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: Set legion.obsidianVaultPath to your Obsidian vault folder first.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "legion.obsidianVaultPath"
      );
    }
    return;
  }

  const vaultName = path.basename(vaultPath);
  // Path to the wiki index inside the vault, forward-slash, no .md extension
  // (Obsidian resolves the extension automatically).
  const filePath = "library/knowledge-base/wiki/index";

  const uri = vscode.Uri.parse(
    `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`
  );

  try {
    await vscode.env.openExternal(uri);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Legion: Could not open Obsidian — ${e instanceof Error ? e.message : String(e)}. ` +
        "Make sure Obsidian is installed and the vault has been opened at least once."
    );
  }
}
