import * as vscode from "vscode";
import { runDocumentPass } from "../driver/documentPass";
import { resolveRepoRoot } from "../util/repoRoot";
import { buildIndex } from "../driver/semanticSearch";

export async function updateDocumentation(context: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;
  await runDocumentPass(repoRoot, "update", undefined, context);
  // Feature 001: incrementally refresh semantic index after update pass (background)
  const cfg = vscode.workspace.getConfiguration("legion");
  if (cfg.get<boolean>("semanticSearchEnabled", true)) {
    buildIndex(repoRoot, undefined, context).catch(() => undefined);
  }
}
