import * as vscode from "vscode";

export async function documentRepository(_context: vscode.ExtensionContext): Promise<void> {
  vscode.window.showInformationMessage(
    "Legion: Document Repository — v0.1.0 scaffold. Implementation in v0.2.0."
  );
  // TODO v0.2.0:
  //  1. Walk repo respecting .legionignore (use driver/legionignore.ts).
  //  2. Hash-diff against .legion/file-hashes.json (driver/hashDiff.ts).
  //  3. Plan chunks by module boundary (driver/chunkPlanner.ts) — for `document` mode all files are "added".
  //  4. Pre-compute git_context per file (driver/gitContext.ts).
  //  5. Construct InvocationPayload per chunk (mode: "document", prior_state: []).
  //  6. Invoke wiki-guardian (and library-guardian) in parallel via driver/agentInvoker.ts,
  //     respecting legion.maxParallelAgents.
  //  7. Collect InvocationResponses; run driver/reconciler.ts to update
  //     index.md / <type>/_index.md / log.md / hot.md / .legion/file-hashes.json.
  //  8. Surface scan summary in the sidebar via webview postMessage.
}
