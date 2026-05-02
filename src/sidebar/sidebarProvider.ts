import * as vscode from "vscode";
import * as path from "path";
import { readContradictionInbox } from "../driver/reconciler";
import { detectRepoState, type RepoState } from "../driver/repoState";
import type { WikiCoverage } from "../driver/coverageTracker";
import { buildCoverageSummary, buildModuleBreakdown, loadCoverage } from "../driver/coverageTracker";
import { getSetupState, type SetupKeyState } from "../util/secretStore";

export class LegionSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _pendingState?: RepoState;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Called from activate() with the repo state detected on startup. */
  pushRepoState(state: RepoState): void {
    this._pendingState = state;
    if (this._view) {
      void this._view.webview.postMessage({ type: "repoState", state });
    }
  }

  /**
   * Re-detect repo state from disk and push the fresh state to the webview.
   *
   * Call this after any command that may have changed the wiki on disk
   * (initialize, document, update, scanDirectory). The cached `_pendingState`
   * is updated so subsequent webview reloads (e.g. user collapses + reopens
   * the sidebar) read the fresh state instead of the stale activation snapshot.
   */
  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const repoRoot = folders[0].uri.fsPath;
    const fresh = await detectRepoState(repoRoot);
    this.pushRepoState(fresh);
  }

  /**
   * Re-read SecretStorage key inventory and push a `setupState` message to the
   * webview. Called on activation and any time a key changes (wizard, inline
   * prompt, or onDidChangeConfiguration). Drives the Setup section UI.
   */
  async refreshSetupState(context: vscode.ExtensionContext): Promise<void> {
    if (!this._view) return;
    const cfg = vscode.workspace.getConfiguration("legion");
    const mode = cfg.get<string>("agentInvocationMode", "cursor-sdk");
    const keys = await getSetupState(context, mode);
    void this._view.webview.postMessage({ type: "setupState", keys, mode });
  }

  /** Allow the webview to request a fresh setup-state snapshot on reconnect. */
  private _extContext?: vscode.ExtensionContext;
  setExtensionContext(context: vscode.ExtensionContext): void {
    this._extContext = context;
  }

  /** Push a coverage update to the webview (called from reconciler Step 14). */
  pushCoverage(coverage: WikiCoverage): void {
    if (!this._view) return;
    void this._view.webview.postMessage({
      type: "coverageUpdate",
      summary: buildCoverageSummary(coverage),
      pct: coverage.maturityPct,
      details: buildModuleBreakdown(coverage),
    });
  }

  /** Push a contradiction badge count update to the webview. */
  async refreshContradictionBadge(repoRoot: string): Promise<void> {
    if (!this._view) return;
    const inbox = await readContradictionInbox(repoRoot);
    await this._view.webview.postMessage({ type: "contradictionCount", count: inbox.length });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    this._view = webviewView;
    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Push configState and repoState immediately so the webview never shows
    // placeholder values — messages queued before JS loads are delivered once
    // the script executes.
    const cfg = vscode.workspace.getConfiguration("legion");
    void webviewView.webview.postMessage({
      type: "configState",
      invocationMode: cfg.get<string>("agentInvocationMode", "cursor-cli"),
    });
    if (this._pendingState) {
      void webviewView.webview.postMessage({ type: "repoState", state: this._pendingState });
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case "initialize":
          await vscode.commands.executeCommand("legion.initialize");
          break;
        case "document":
          await vscode.commands.executeCommand("legion.document");
          break;
        case "update":
          await vscode.commands.executeCommand("legion.update");
          break;
        case "scanDirectory":
          await vscode.commands.executeCommand("legion.scanDirectory");
          break;
        case "lint":
          await vscode.commands.executeCommand("legion.lint");
          break;
        case "openInObsidian":
          await vscode.commands.executeCommand("legion.openInObsidian");
          break;
        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "legion"
          );
          break;
        case "requestState": {
          const cfg = vscode.workspace.getConfiguration("legion");
          const apiProvider = cfg.get<string>("apiProvider", "anthropic");
          const invMode = cfg.get<string>("agentInvocationMode", "cursor-cli");
          // Show OpenRouter model or Anthropic model in the badge
          const modelBadge = apiProvider === "openrouter"
            ? `or:${(cfg.get<string>("openRouterModel") || "claude-sonnet-4-5").split("/").pop()}`
            : invMode;
          await webviewView.webview.postMessage({
            type: "configState",
            invocationMode: modelBadge,
            researchProvider: cfg.get<string>("researchProvider", "model-only"),
          });
          // Re-detect repo state on every requestState so the sidebar self-heals
          // when Initialize is run from the Command Palette (or any other entry
          // point that bypasses sidebarProvider.refresh()), and so reopening the
          // panel after Initialize never shows the stale "Not initialized" badge.
          const folders = vscode.workspace.workspaceFolders;
          if (folders?.[0]) {
            const repoRoot = folders[0].uri.fsPath;
            const fresh = await detectRepoState(repoRoot);
            this._pendingState = fresh;
            await webviewView.webview.postMessage({ type: "repoState", state: fresh });
            // Also refresh setup state on requestState
            if (this._extContext) {
              await this.refreshSetupState(this._extContext);
            }

            const inbox = await readContradictionInbox(repoRoot);
            await webviewView.webview.postMessage({
              type: "contradictionCount",
              count: inbox.length,
            });
            const cov = await loadCoverage(repoRoot);
            if (cov && cov.total > 0) {
              await webviewView.webview.postMessage({
                type: "coverageUpdate",
                summary: buildCoverageSummary(cov),
                pct: cov.maturityPct,
                details: buildModuleBreakdown(cov),
              });
            }
          }
          break;
        }
        case "findEntity":
          await vscode.commands.executeCommand("legion.findEntity");
          break;
        case "showCoverageDetails": {
          const foldersX = vscode.workspace.workspaceFolders;
          if (!foldersX?.[0]) break;
          const cov = await loadCoverage(foldersX[0].uri.fsPath);
          if (!cov || cov.total === 0) {
            vscode.window.showInformationMessage("Legion: No coverage data yet. Run Document Repository first.");
            break;
          }
          const items = buildModuleBreakdown(cov).map((line) => ({ label: line }));
          await vscode.window.showQuickPick(
            [{ label: `Total: ${buildCoverageSummary(cov)}` }, ...items],
            { placeHolder: "Knowledge debt — per-module maturity", canPickMany: false }
          );
          break;
        }
        case "viewEntityGraph":
          await vscode.commands.executeCommand("legion.viewEntityGraph");
          break;
        case "foldLog":
          await vscode.commands.executeCommand("legion.foldLog");
          break;
        case "autoresearch":
          await vscode.commands.executeCommand("legion.autoresearch");
          break;
        case "saveConversation":
          await vscode.commands.executeCommand("legion.saveConversation");
          break;
        case "ingestUrl":
          await vscode.commands.executeCommand("legion.ingestUrl");
          break;
        case "drainAgenda":
          await vscode.commands.executeCommand("legion.drainAgenda");
          break;
        case "generateOnboardingBrief":
          await vscode.commands.executeCommand("legion.generateOnboardingBrief");
          break;
        case "openContradictionInbox":
          await vscode.commands.executeCommand("legion.resolveContradiction");
          break;
        case "exportWiki":
          await vscode.commands.executeCommand("legion.exportWiki");
          break;
        case "installPrReviewBot":
          await vscode.commands.executeCommand("legion.installPrReviewBot");
          break;
        case "openDashboard":
          await vscode.commands.executeCommand("legion.openDashboard");
          break;
        case "runWizard":
        case "setupWizard":      // v1.2.5: COMMANDS-array convention
        case "setupReconfigure": // v1.2.5: COMMANDS-array convention
          await vscode.commands.executeCommand("legion.setupWizard");
          break;
        case "enterKey":
          if (msg.key && this._extContext) {
            const { promptForKey } = await import("../commands/setupWizard");
            await promptForKey(this._extContext, msg.key, async () => {
              await this.refreshSetupState(this._extContext!);
            });
          }
          break;
        case "pasteKey":
          if (msg.key && this._extContext) {
            try {
              const text = await vscode.env.clipboard.readText();
              if (text?.trim()) {
                const { setSecret } = await import("../util/secretStore");
                await setSecret(this._extContext, msg.key, text.trim());
                await this.refreshSetupState(this._extContext);
                vscode.window.showInformationMessage("$(check) API key pasted and saved.");
              } else {
                vscode.window.showWarningMessage("Clipboard appears empty. Copy your API key first.");
              }
            } catch {
              vscode.window.showErrorMessage("Could not read clipboard.");
            }
          }
          break;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.js")
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "legion-icon.png")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

  <link rel="stylesheet" href="${cssUri}">
  <title>Legion</title>
</head>
<body>
  <div class="legion-sidebar">

    <!-- ── Header ──────────────────────────── -->
    <header>
      <div class="header-brand">
        <img src="${iconUri}" class="brand-icon-img" alt="Legion" />
        <div class="brand-text">
          <h1>Legion</h1>
          <p>Retreat? Hell, we just got here!</p>
        </div>
        <span id="invocationMode" class="mode-badge">…</span>
      </div>
    </header>

    <!-- ── Status bar ───────────────────────── -->
    <div class="status-bar">
      <div class="status-dot" id="statusDot"></div>
      <span id="wikiStatus">Detecting…</span>
      <span class="status-sep">·</span>
      <span id="pageCount">—</span>
      <span class="status-sep">·</span>
      <span id="lastScan">—</span>
    </div>
    <div class="coverage-bar" id="coverageBar" style="display:none">
      <button id="showCoverageDetails" class="coverage-btn" type="button" title="Per-module coverage breakdown">
        <span id="coverageText" style="font-family:monospace;font-size:10px">—</span>
      </button>
    </div>

    <!-- ── Actions ──────────────────────────── -->
    <div class="actions-area">

      <!-- Primary: Setup (v1.2.8 — moved out of broken setup-card into proven action area) -->
      <button id="setupWizard" class="btn-primary" type="button"
        title="Open the full Legion Setup page — pick invocation mode, configure API keys, paste from clipboard, all on one screen.">
        Open Setup Page
      </button>

      <!-- Primary: Initialize -->
      <button id="initialize" class="btn-primary" type="button"
        title="Scaffold library/, .legion/, .cursor/ and copy selected guardians. Idempotent — safe to re-run.">
        Initialize Repository
      </button>

      <div class="section-divider"></div>

      <!-- 2-column grid -->
      <div class="action-grid">
        <button id="document" class="btn-grid" type="button"
          title="Full scan — chunks all files by module, pre-computes git context, invokes wiki-guardian in parallel.">
          Document
        </button>
        <button id="update" class="btn-grid" type="button"
          title="Incremental — re-scans only files whose hashes changed since the last scan. Fast and cheap.">
          Update
        </button>
        <button id="scanDirectory" class="btn-grid" type="button"
          title="Document or Update scoped to a single directory you choose.">
          Scan Dir…
        </button>
        <button id="lint" class="btn-grid" type="button"
          title="Validate frontmatter, wikilinks, ADR chain integrity, citation density. Reports only — never auto-fixes.">
          Lint Wiki
        </button>
        <button id="findEntity" class="btn-grid" type="button"
          title="Fuzzy-search all wiki pages. Jump to entity page or source file:line. Also: Ctrl+Shift+Alt+L.">
          Find Entity
        </button>
        <button id="viewEntityGraph" class="btn-grid" type="button"
          title="Open the Mermaid entity relationship graph in Markdown preview. Rebuilt after each scan.">
          Graph
        </button>
        <button id="autoresearch" class="btn-grid" type="button"
          title="3-round autonomous research loop. Synthesizes knowledge and files pages. Requires Anthropic API key. Ctrl+Shift+Alt+R">
          Research…
        </button>
        <button id="foldLog" class="btn-grid" type="button"
          title="Roll up the last 2^k log entries into a checkpoint page. Prevents wiki/log.md from growing unbounded.">
          Fold Log…
        </button>
      </div>

      <!-- Contradiction alert (hidden until contradictions exist) -->
      <button id="openContradictionInbox" class="contradiction-btn" type="button">
        <span class="contradiction-count" id="contradictionBadge">0</span>
        <span>contradiction(s) need review</span>
        <span class="contradiction-chevron">›</span>
      </button>

      <div class="section-divider"></div>

      <!-- Obsidian (collapsible) -->
      <details class="obsidian-section">
        <summary>
          <span class="obsidian-icon">◈</span>
          <span class="obsidian-label">Obsidian</span>
          <button id="openInObsidian" class="obsidian-open-btn" type="button"
            title="Open library/knowledge-base/wiki/index.md in your Obsidian vault.">
            Open Wiki
          </button>
        </summary>
        <div class="obsidian-body">
          <ol>
            <li>Open your repo root in Obsidian at least once (registers the vault name).</li>
            <li>Set <code>legion.obsidianVaultPath</code> in Settings to your vault folder.</li>
            <li>Click <strong>Open Wiki</strong> above — Legion fires <code>obsidian://open?vault=…</code>.</li>
          </ol>
          <p class="obsidian-tip"><code>[[wikilinks]]</code>, graph view, backlinks, and Dataview all work natively.</p>
        </div>
      </details>

      <!-- Getting started (collapsible, auto-opens for new repos) -->
      <details class="getting-started" id="gettingStarted">
        <summary>
          Getting started <span class="toggle-icon">›</span>
        </summary>
        <div class="getting-started-body">
          <div class="step">
            <span class="step-num">1</span>
            <span class="step-text"><strong>Initialize</strong> — scaffolds <code>library/</code>, <code>.legion/</code>, copies selected guardians into <code>.cursor/agents/</code>.</span>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <span class="step-text"><strong>Document</strong> — full first scan. Chunks your codebase, invokes wiki-guardian in parallel, writes entity pages to the wiki.</span>
          </div>
          <div class="step">
            <span class="step-num">3</span>
            <span class="step-text"><strong>Update</strong> — run after each commit. Re-scans only changed files. Enable <code>legion.installPostCommitHook</code> to automate.</span>
          </div>
          <p class="hint" style="margin-top:6px">Research: <span id="researchProvider" class="mode-badge" title="Set legion.researchProvider to use Exa, Firecrawl, or Context7">…</span></p>
        </div>
      </details>

    </div>

    <!-- ── Footer ───────────────────────────── -->
    <footer>
      <button id="ingestUrl" class="btn-footer" type="button" title="Scrape a URL with Firecrawl and file it as a wiki source page. Ctrl+Shift+Alt+U">⤓ Ingest URL</button>
      <button id="drainAgenda" class="btn-footer" type="button" title="Research all unchecked items in wiki/research-agenda.md">⟳ Agenda</button>
      <button id="generateOnboardingBrief" class="btn-footer" type="button" title="Generate an ordered onboarding reading list for a module">⊞ Onboard</button>
      <button id="saveConversation" class="btn-footer" type="button" title="File a conversation, meeting note, or insight. Ctrl+Shift+Alt+S">✎ Save</button>
      <button id="exportWiki" class="btn-footer" type="button" title="Export wiki as Docusaurus, static HTML, or Markdown bundle">⤓ Export Wiki…</button>
      <button id="installPrReviewBot" class="btn-footer" type="button" title="Install the Legion GitHub Actions PR review bot">⊕ PR Bot</button>
      <button id="openDashboard" class="btn-footer" type="button" title="Open the Legion Analytics Dashboard — entity trends, maturity, coverage">📊 Dashboard</button>
      <button id="openSettings" class="btn-footer" type="button">⚙</button>
    </footer>

  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
