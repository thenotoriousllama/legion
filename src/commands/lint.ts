import * as vscode from "vscode";

export async function lintWiki(_context: vscode.ExtensionContext): Promise<void> {
  vscode.window.showInformationMessage(
    "Legion: Lint Wiki — v0.1.0 scaffold. Implementation in v0.2.0."
  );
  // TODO v0.2.0:
  //  1. Walk library/knowledge-base/wiki/ and load every page's frontmatter (via gray-matter or
  //     a hand-rolled parser).
  //  2. Construct chunked payloads (mode: "lint", chunk: subset of pages, prior_state: same set).
  //  3. Invoke wiki-guardian per chunk; collect lint_findings from each response.
  //  4. Driver runs the global pass: orphan detection, dead-link sweep across the whole wiki,
  //     ADR chain integrity.
  //  5. Aggregate findings into library/knowledge-base/wiki/meta/<YYYY-MM-DD>-lint-report.md
  //     with the structure documented in wiki-weapon/guides/09-lint-mode.md.
  //  6. Surface error/warning counts in the sidebar.
  //  Lint mode never auto-fixes; it only reports.
}
