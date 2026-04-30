import * as vscode from "vscode";

export async function updateDocumentation(_context: vscode.ExtensionContext): Promise<void> {
  vscode.window.showInformationMessage(
    "Legion: Update Documentation — v0.1.0 scaffold. Implementation in v0.2.0."
  );
  // TODO v0.2.0:
  //  1. Same as document.ts steps 1-2, but only chunk files where hash diff = added | modified.
  //  2. mode: "update" in the payload.
  //  3. Load prior_state from .legion/file-hashes.json's per-file `pages_created`/`pages_updated`
  //     and read the corresponding wiki pages' frontmatter for cross-reference.
  //  4. Same parallel invocation + reconciliation as document.
  //  5. After reconciliation, drain `.legion/queue/` if any post-commit-hook entries exist.
}
