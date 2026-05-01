import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

const WIKI_ENTITY_DIR = path.join("library", "knowledge-base", "wiki", "entities");

// Matches top-level exported function/class declarations — same as entityCodeLensProvider
const DEFINITION_RE =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>)/gm;

// Extracts the full function signature (params + return type)
const SIGNATURE_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/m;

const DIAGNOSTIC_SOURCE = "legion";
const DIAGNOSTIC_CODE = "stale-contract";

/**
 * Validates exported function/class contracts in a TypeScript/JavaScript file
 * against their corresponding wiki entity pages. Surfaces a VS Code Warning
 * diagnostic when a signature mismatch is detected.
 *
 * Called on every save of a TS/JS file via the onDidSaveTextDocument listener.
 */
export class ContractValidator {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(private readonly repoRoot: string) {
    this.collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  }

  dispose(): void {
    this.collection.dispose();
  }

  async validateDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.repoRoot) return;
    if (!["typescript", "javascript", "typescriptreact", "javascriptreact"].includes(document.languageId)) return;

    const cfg = vscode.workspace.getConfiguration("legion");
    if (!cfg.get<boolean>("contractValidation", true)) return;

    const text = document.getText();
    const entityDir = path.join(this.repoRoot, WIKI_ENTITY_DIR);
    const diagnostics: vscode.Diagnostic[] = [];

    DEFINITION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = DEFINITION_RE.exec(text)) !== null) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!name) continue;

      // Check both camelCase and kebab-case variants
      const kebab = toKebabCase(name);
      const wikiPage = await this.findEntityPage(entityDir, [name, kebab]);
      if (!wikiPage) continue;

      // Extract signature from current source
      const lineText = text.slice(match.index, text.indexOf("\n", match.index) + 200);
      const sigMatch = lineText.match(SIGNATURE_RE);
      const currentParams = sigMatch?.[2]?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
      const currentReturn = sigMatch?.[3]?.trim() ?? "";

      // Extract signature section from wiki page
      const wikiContent = wikiPage.content;
      const wikiSig = extractWikiSignature(wikiContent);
      if (!wikiSig) continue; // Wiki page has no Signature section — skip validation

      // Compare: check if param count changed or return type keyword changed
      const wikiParams = extractParamCount(wikiSig);
      const wikiReturn = extractReturnType(wikiSig);

      const paramCountChanged =
        wikiParams !== null && Math.abs(currentParams.length - wikiParams) > 0;
      const returnTypeChanged =
        wikiReturn !== null &&
        currentReturn.length > 0 &&
        !returnTypeCompatible(currentReturn, wikiReturn);

      if (paramCountChanged || returnTypeChanged) {
        const pos = document.positionAt(match.index);
        const range = new vscode.Range(pos, new vscode.Position(pos.line, pos.character + name.length + 10));

        const detail = paramCountChanged
          ? `parameter count: wiki has ${wikiParams}, source has ${currentParams.length}`
          : `return type: wiki has "${wikiReturn}", source has "${currentReturn}"`;

        const diagnostic = new vscode.Diagnostic(
          range,
          `Legion: \`${name}\` contract may have changed (${detail}) — wiki page not yet updated.`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = DIAGNOSTIC_CODE;
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(wikiPage.absPath), new vscode.Position(0, 0)),
            `Wiki entity page: ${wikiPage.name}`
          ),
        ];
        diagnostics.push(diagnostic);
      }
    }

    this.collection.set(document.uri, diagnostics);
  }

  clearDocument(document: vscode.TextDocument): void {
    this.collection.delete(document.uri);
  }

  private async findEntityPage(
    entityDir: string,
    names: string[]
  ): Promise<{ name: string; absPath: string; content: string } | null> {
    for (const name of names) {
      const absPath = path.join(entityDir, `${name}.md`);
      try {
        const content = await fs.readFile(absPath, "utf8");
        return { name, absPath, content };
      } catch {}
    }
    return null;
  }
}

// ── Code action provider ──────────────────────────────────────────────────────

/**
 * Provides a "Open wiki page" code action for stale-contract diagnostics.
 */
export class ContractCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly repoRoot: string) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.code !== DIAGNOSTIC_CODE) continue;

      // Extract entity name from the diagnostic message
      const nameMatch = diag.message.match(/`(\w+)`/);
      if (!nameMatch) continue;
      const entityName = nameMatch[1];

      // "Open wiki page" action
      const openAction = new vscode.CodeAction(
        `Legion: Open wiki page for \`${entityName}\``,
        vscode.CodeActionKind.QuickFix
      );
      const entityDir = path.join(this.repoRoot, WIKI_ENTITY_DIR);
      const pagePath =
        path.join(entityDir, `${entityName}.md`) ||
        path.join(entityDir, `${toKebabCase(entityName)}.md`);

      openAction.command = {
        command: "vscode.open",
        title: "Open wiki page",
        arguments: [
          vscode.Uri.file(pagePath),
          { viewColumn: vscode.ViewColumn.Beside },
        ],
      };
      openAction.diagnostics = [diag];
      actions.push(openAction);

      // "Run Update" action
      const updateAction = new vscode.CodeAction(
        "Legion: Run Update Documentation to fix",
        vscode.CodeActionKind.QuickFix
      );
      updateAction.command = {
        command: "legion.update",
        title: "Update Documentation",
      };
      updateAction.diagnostics = [diag];
      actions.push(updateAction);
    }

    return actions;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWikiSignature(content: string): string | null {
  const sigHeading = /^##\s+Signature\s*$/m;
  const nextHeading = /^##\s+/m;
  const sigMatch = sigHeading.exec(content);
  if (!sigMatch) return null;
  const after = content.slice(sigMatch.index + sigMatch[0].length);
  const nextMatch = nextHeading.exec(after);
  return nextMatch ? after.slice(0, nextMatch.index).trim() : after.trim().slice(0, 300);
}

function extractParamCount(sigText: string): number | null {
  // Count commas in a parameter list heuristic
  const parenMatch = sigText.match(/\(([^)]*)\)/);
  if (!parenMatch) return null;
  const params = parenMatch[1].trim();
  if (!params) return 0;
  return params.split(",").filter((p) => p.trim()).length;
}

function extractReturnType(sigText: string): string | null {
  // Look for ": ReturnType" pattern after the closing paren
  const retMatch = sigText.match(/\)\s*:\s*([^\n{]+)/);
  if (!retMatch) return null;
  return retMatch[1].trim().replace(/[;\s]+$/, "");
}

function returnTypeCompatible(current: string, wiki: string): boolean {
  // Normalize: strip whitespace, Promise<T> wrapper for comparison
  const norm = (s: string) =>
    s.toLowerCase().replace(/\s/g, "").replace(/promise<(.+)>/g, "$1");
  const c = norm(current);
  const w = norm(wiki);
  return c === w || c.includes(w) || w.includes(c);
}

function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}
