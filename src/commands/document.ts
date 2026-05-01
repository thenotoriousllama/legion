import * as vscode from "vscode";
import { runDocumentPass } from "../driver/documentPass";
import { resolveRepoRoot } from "../util/repoRoot";
import { buildIndex } from "../driver/semanticSearch";

export async function documentRepository(context: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;
  await runDocumentPass(repoRoot, "document", undefined, context);
  // Feature 001: rebuild semantic index after document pass (background, non-blocking)
  const cfg = vscode.workspace.getConfiguration("legion");
  if (cfg.get<boolean>("semanticSearchEnabled", true)) {
    buildIndex(repoRoot).catch(() => undefined);
  }
}
