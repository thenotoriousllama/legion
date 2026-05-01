import * as vscode from "vscode";
import * as path from "path";
import { exportWiki, type ExportTarget } from "../driver/wikiExport";
import { resolveRepoRoot, resolveWikiRoot } from "../util/repoRoot";

/**
 * Legion: Export Wiki — shows a QuickPick to choose export format,
 * then exports the wiki with a progress notification.
 */
export async function exportWikiCommand(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const cfg = vscode.workspace.getConfiguration("legion");
  const outputDirSetting = cfg.get<string>("exportOutputDir", "./docs-export").trim();
  const outputDir = path.isAbsolute(outputDirSetting)
    ? outputDirSetting
    : path.resolve(repoRoot, outputDirSetting);

  const formatItems = [
    {
      label: "$(globe) Docusaurus v3",
      description: "Hosted docs site with sidebar and search",
      target: "docusaurus" as ExportTarget,
    },
    {
      label: "$(file-code) Static HTML",
      description: "Self-contained, zero-dependency site",
      target: "html" as ExportTarget,
    },
    {
      label: "$(markdown) Markdown Bundle",
      description: "Raw Markdown for Confluence, Notion, GitBook",
      target: "markdown" as ExportTarget,
    },
  ];

  const picked = await vscode.window.showQuickPick(formatItems, {
    placeHolder: "Export Wiki As…",
    title: "Legion — choose export format",
  });
  if (!picked) return;

  const wikiRoot = resolveWikiRoot(repoRoot);
  const wikiDir = wikiRoot;
  void wikiDir; // resolved but passed via repoRoot

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Exporting wiki (${picked.target})…`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Collecting pages…", increment: 10 });

      try {
        const result = await exportWiki({
          repoRoot,
          outputDir,
          target: picked.target,
        });

        progress.report({ message: "Done!", increment: 90 });

        const relOutput = path.relative(repoRoot, outputDir);
        const choice = await vscode.window.showInformationMessage(
          `Legion: Wiki exported to ${relOutput}/ (${result.pagesExported} pages, ${result.durationMs}ms)`,
          "Open folder"
        );
        if (choice === "Open folder") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(outputDir)
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Legion: Export failed — ${String(err)}`);
      }
    }
  );
}
