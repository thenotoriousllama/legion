/**
 * Legion Dashboard — full-page webview in the editor area.
 *
 * v1.2.18 expanded the original "Setup Page" into a four-tab workspace:
 *
 *   1. **Dashboard**   — repo state cards, quick actions, recent activity feed.
 *   2. **API Keys & Mode** — provider picker, required key, OpenRouter model.
 *   3. **Settings**    — every `legion.*` setting grouped (Performance / Wiki /
 *                        Federation / Research). Each control writes Global
 *                        configuration immediately.
 *   4. **Activity**    — terminal-style scrolling log + progress bar fed by
 *                        the ActivityStream singleton + Cancel button that
 *                        triggers the same CancellationTokenSource the toast
 *                        X uses.
 *
 * Singleton pattern (mirrors DashboardPanel) — calling `open()` twice just
 * focuses the existing panel.
 *
 * Class is still named `SetupPagePanel` for backwards-compat with imports
 * registered in extension.ts; the panel TITLE is "Legion Dashboard".
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  SECRET_KEYS,
  getSetupState,
  setSecret,
  deleteSecret,
  type SecretKey,
} from "../util/secretStore";
import {
  getOpenRouterModels,
} from "../util/openrouterModels";
import { ActivityStream, type ActivityEvent, type ActiveOperation } from "../util/activityStream";
import { detectRepoState, type RepoState } from "../driver/repoState";
import { resolveRepoRoot } from "../util/repoRoot";

export class SetupPagePanel {
  static currentPanel: SetupPagePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _sidebarRefresh?: () => Promise<void>;

  static open(
    context: vscode.ExtensionContext,
    sidebarRefresh?: () => Promise<void>
  ): void {
    if (SetupPagePanel.currentPanel) {
      SetupPagePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "legionDashboard",
      "Legion Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "legion-icon.png");

    SetupPagePanel.currentPanel = new SetupPagePanel(panel, context, sidebarRefresh);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    sidebarRefresh?: () => Promise<void>
  ) {
    this._panel = panel;
    this._context = context;
    this._sidebarRefresh = sidebarRefresh;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Forward live activity events to the webview.
    const stream = ActivityStream.instance;
    this._disposables.push(
      stream.onEvent((event: ActivityEvent) => {
        void this._panel.webview.postMessage({ type: "activityEvent", event });
      })
    );
    this._disposables.push(
      stream.onActiveChanged((op: ActiveOperation | null) => {
        void this._panel.webview.postMessage({
          type: "activeOperation",
          op: op ? { id: op.id, label: op.label, startedAt: op.startedAt } : null,
        });
      })
    );

    // React to settings changes so the Settings tab stays in sync if the user
    // edits settings.json or VS Code's UI directly.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("legion")) {
          void this._pushState();
        }
      })
    );

    this._panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        key?: SecretKey;
        value?: string | number | boolean | string[];
        mode?: string;
        modelId?: string;
        forceRefresh?: boolean;
        path?: string;
        commandId?: string;
      }) => {
        try {
          switch (msg.command) {
            case "ready":
              await this._pushState();
              await this._pushHistory();
              break;

            case "setMode":
              if (msg.mode) {
                const cfg = vscode.workspace.getConfiguration("legion");
                if (msg.mode === "direct-anthropic") {
                  await cfg.update("agentInvocationMode", "direct-anthropic-api", vscode.ConfigurationTarget.Global);
                  await cfg.update("apiProvider", "anthropic", vscode.ConfigurationTarget.Global);
                } else if (msg.mode === "direct-openrouter") {
                  await cfg.update("agentInvocationMode", "direct-anthropic-api", vscode.ConfigurationTarget.Global);
                  await cfg.update("apiProvider", "openrouter", vscode.ConfigurationTarget.Global);
                } else if (msg.mode === "queue-file") {
                  await cfg.update("agentInvocationMode", "queue-file", vscode.ConfigurationTarget.Global);
                }
                await this._pushState();
                await this._sidebarRefresh?.();
              }
              break;

            case "saveKey":
              if (msg.key && typeof msg.value === "string" && msg.value.trim()) {
                await setSecret(this._context, msg.key, msg.value.trim());
                await this._pushState();
                await this._sidebarRefresh?.();
              }
              break;

            case "deleteKey":
              if (msg.key) {
                await deleteSecret(this._context, msg.key);
                await this._pushState();
                await this._sidebarRefresh?.();
              }
              break;

            case "paste":
              if (msg.key) {
                const text = await vscode.env.clipboard.readText();
                if (text?.trim()) {
                  await setSecret(this._context, msg.key, text.trim());
                  await this._pushState();
                  await this._sidebarRefresh?.();
                  void this._panel.webview.postMessage({
                    type: "toast",
                    message: `Pasted ${SECRET_KEYS[msg.key].label} from clipboard.`,
                    kind: "success",
                  });
                } else {
                  void this._panel.webview.postMessage({
                    type: "toast",
                    message: "Clipboard appears empty. Copy your API key first.",
                    kind: "warn",
                  });
                }
              }
              break;

            case "openExternal":
              if (typeof msg.value === "string") {
                await vscode.env.openExternal(vscode.Uri.parse(msg.value));
              }
              break;

            case "done":
              this._panel.dispose();
              await vscode.commands.executeCommand("legion.document");
              break;

            case "close":
              this._panel.dispose();
              break;

            case "fetchOpenRouterModels":
              void this._panel.webview.postMessage({ type: "openRouterModelsLoading" });
              try {
                const { models, cached, fetchedAt } = await getOpenRouterModels(
                  this._context,
                  msg.forceRefresh === true
                );
                void this._panel.webview.postMessage({
                  type: "openRouterModels",
                  models,
                  cached,
                  fetchedAt,
                });
              } catch (e) {
                void this._panel.webview.postMessage({
                  type: "openRouterModelsError",
                  message: e instanceof Error ? e.message : String(e),
                });
              }
              break;

            case "setOpenRouterModel":
              if (msg.modelId) {
                const cfg = vscode.workspace.getConfiguration("legion");
                await cfg.update("openRouterModel", msg.modelId, vscode.ConfigurationTarget.Global);
                await this._pushState();
                await this._sidebarRefresh?.();
                void this._panel.webview.postMessage({
                  type: "toast",
                  message: `OpenRouter model set to ${msg.modelId}.`,
                  kind: "success",
                });
              }
              break;

            case "setSetting":
              // Generic write for the Settings tab. `path` is the legion.* key
              // (e.g. "maxParallelAgents", "federation.peers"). `value` is
              // anything serializable.
              if (msg.path !== undefined) {
                const cfg = vscode.workspace.getConfiguration("legion");
                await cfg.update(msg.path, msg.value, vscode.ConfigurationTarget.Global);
                await this._pushState();
              }
              break;

            case "runCommand":
              if (msg.commandId) {
                await vscode.commands.executeCommand(msg.commandId);
              }
              break;

            case "cancelActive":
              ActivityStream.instance.cancelActive();
              break;

            case "clearLog":
              ActivityStream.instance.clearHistory();
              await this._pushHistory();
              break;
          }
        } catch (err) {
          void this._panel.webview.postMessage({
            type: "toast",
            message: `Error: ${err instanceof Error ? err.message : String(err)}`,
            kind: "error",
          });
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.html = this._buildHtml();
  }

  /** Push full UI state (mode, keys, settings, repo state, active op). */
  private async _pushState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("legion");
    const agentMode = cfg.get<string>("agentInvocationMode", "direct-anthropic-api");
    const apiProvider = cfg.get<string>("apiProvider", "anthropic");
    let uiMode = "direct-anthropic";
    if (agentMode === "queue-file") uiMode = "queue-file";
    else if (agentMode === "cursor-sdk") uiMode = "cursor-sdk";
    else if (apiProvider === "openrouter") uiMode = "direct-openrouter";

    const keys = await getSetupState(this._context, uiMode);
    const openRouterModel = cfg.get<string>("openRouterModel", "anthropic/claude-sonnet-4-5");

    // Repo state for Dashboard tab.
    let repoState: RepoState | null = null;
    try {
      const repoRoot = await resolveRepoRoot({ context: this._context });
      if (repoRoot) repoState = await detectRepoState(repoRoot);
    } catch {
      // No workspace open — Dashboard tab will show an empty state.
    }

    // Snapshot every legion.* setting we render in the Settings tab.
    const settings = {
      maxParallelAgents: cfg.get<number>("maxParallelAgents", 6),
      maxFilesPerChunk: cfg.get<number>("maxFilesPerChunk", 8),
      includeGitBlame: cfg.get<boolean>("includeGitBlame", false),
      documentMode: cfg.get<string>("documentMode", "all"),
      fastModelEnabled: cfg.get<boolean>("fastModelEnabled", false),
      injectCursorContext: cfg.get<boolean>("injectCursorContext", true),
      showCodeLens: cfg.get<boolean>("showCodeLens", true),
      autoGitCommit: cfg.get<boolean>("autoGitCommit", false),
      installPostCommitHook: cfg.get<boolean>("installPostCommitHook", false),
      semanticSearchEnabled: cfg.get<boolean>("semanticSearchEnabled", true),
      obsidianVaultPath: cfg.get<string>("obsidianVaultPath", ""),
      logFoldK: cfg.get<number>("logFoldK", 3),
      "federation.publishManifest": cfg.get<boolean>("federation.publishManifest", false),
      "federation.peers": cfg.get<string[]>("federation.peers", []),
      researchProvider: cfg.get<string>("researchProvider", "model-only"),
      researchRounds: cfg.get<number>("researchRounds", 3),
      anthropicModel: cfg.get<string>("model", "claude-sonnet-4-5"),
    };

    const active = ActivityStream.instance.active;
    void this._panel.webview.postMessage({
      type: "setupState",
      keys,
      mode: uiMode,
      openRouterModel,
      settings,
      repoState,
      activeOp: active ? { id: active.id, label: active.label, startedAt: active.startedAt } : null,
    });
  }

  /** Push the activity ring buffer for the Activity tab on first open. */
  private async _pushHistory(): Promise<void> {
    void this._panel.webview.postMessage({
      type: "activityHistory",
      history: ActivityStream.instance.history(),
    });
  }

  dispose(): void {
    SetupPagePanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
  }

  private _buildHtml(): string {
    const nonce = getNonce();
    const cspSource = this._panel.webview.cspSource;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Legion Dashboard</title>
<style>
  :root {
    --gap: 16px;
    --radius: 10px;
    --radius-sm: 6px;
    --border: var(--vscode-panel-border, rgba(128,128,128,0.25));
    --bg-elevated: var(--vscode-editor-background);
    --bg-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
    --accent: var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --success: var(--vscode-testing-iconPassed, #73c991);
    --warn: var(--vscode-inputValidation-warningForeground, #cca700);
    --danger: var(--vscode-errorForeground, #f44747);
    --muted: var(--vscode-descriptionForeground, #888);
    --link: var(--vscode-textLink-foreground, #3794ff);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    line-height: 1.5;
  }
  .container { max-width: 920px; margin: 0 auto; padding: 24px 32px 64px; }

  /* ── Hero ───────────────────────────────────────── */
  .hero {
    display: flex; align-items: center; gap: 14px;
    margin-bottom: 6px;
  }
  .hero-icon {
    width: 44px; height: 44px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .hero-icon svg { width: 100%; height: 100%; display: block; }
  .hero h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .hero-sub {
    color: var(--muted);
    font-size: 12px;
    margin: 4px 0 24px 58px;
  }

  /* ── Tabs ───────────────────────────────────────── */
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  .tab {
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    transition: color 0.1s, border-color 0.1s;
  }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--accent);
  }
  .tab-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 700;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── Section header ─────────────────────────────── */
  section { margin-bottom: 28px; }
  .section-header {
    display: flex; align-items: baseline; gap: 8px;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 11px; font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.85;
  }
  .section-meta { color: var(--muted); font-size: 11px; }

  /* ── Stat cards (Dashboard tab) ─────────────────── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat-card {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }
  .stat-card.ok { border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
  .stat-card.warn { border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
  .stat-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 18px;
    font-weight: 600;
    line-height: 1.2;
    word-break: break-word;
  }
  .stat-sub {
    margin-top: 4px;
    font-size: 11px;
    color: var(--muted);
  }

  /* ── Quick actions ──────────────────────────────── */
  .quick-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
  }
  .quick-card {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    cursor: pointer;
    transition: border-color 0.1s, transform 0.1s;
    text-align: left;
    font-family: inherit;
    color: inherit;
  }
  .quick-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .quick-card-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .quick-card-detail { font-size: 11px; color: var(--muted); line-height: 1.4; }

  /* ── Mode picker ─────────────────────────────────── */
  .mode-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  @media (min-width: 700px) { .mode-grid { grid-template-columns: repeat(3, 1fr); } }
  .mode-card {
    position: relative;
    padding: 14px 14px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    cursor: pointer;
    transition: border-color 0.12s, transform 0.12s, box-shadow 0.12s;
  }
  .mode-card:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .mode-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .mode-card.active::after {
    content: "✓";
    position: absolute; top: 10px; right: 12px;
    color: var(--accent); font-weight: 700; font-size: 14px;
  }
  .mode-name {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .mode-tagline { font-size: 12px; margin-bottom: 4px; }
  .mode-detail { font-size: 10.5px; color: var(--muted); line-height: 1.4; }

  /* ── Key card ────────────────────────────────────── */
  .key-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    background: var(--bg-elevated);
    margin-bottom: 10px;
    transition: border-color 0.15s, background 0.15s;
  }
  .key-card.required-missing {
    border-color: color-mix(in srgb, var(--warn) 60%, var(--border));
    background: color-mix(in srgb, var(--warn) 4%, var(--bg-elevated));
  }
  .key-card.configured { border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
  .key-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .key-label { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
  .key-name { font-weight: 600; font-size: 13px; }
  .key-badge {
    font-size: 9.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 2px 7px; border-radius: 10px;
    white-space: nowrap;
  }
  .key-badge.required {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }
  .key-badge.optional {
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
    color: var(--muted);
  }
  .key-badge.done {
    background: color-mix(in srgb, var(--success) 18%, transparent);
    color: var(--success);
  }
  .key-input-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .key-input {
    flex: 1 1 auto; min-width: 0;
    padding: 7px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 12px;
    outline: none;
  }
  .key-input:focus { border-color: var(--accent); }
  .btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--vscode-foreground);
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    white-space: nowrap;
  }
  .btn:hover { background: var(--bg-hover); }
  .btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
  .key-meta { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--muted); }
  .key-meta a { color: var(--link); text-decoration: none; cursor: pointer; }
  .key-meta a:hover { text-decoration: underline; }
  .key-status-current { font-family: var(--mono); font-size: 11px; color: var(--success); }
  .key-status-empty { font-style: italic; font-size: 11px; color: var(--muted); }

  /* ── OpenRouter model picker ─────────────────────── */
  .or-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .or-search {
    flex: 1 1 auto; min-width: 0;
    padding: 7px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  .or-search:focus { border-color: var(--accent); }
  .or-status { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .or-list {
    max-height: 380px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }
  .or-item {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.1s;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    align-items: baseline;
  }
  .or-item:last-child { border-bottom: none; }
  .or-item:hover { background: var(--bg-hover); }
  .or-item.selected {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-left: 3px solid var(--accent);
    padding-left: 11px;
  }
  .or-item-id { font-family: var(--mono); font-size: 12px; font-weight: 600; word-break: break-all; }
  .or-item-meta {
    grid-column: 1 / -1;
    display: flex; flex-wrap: wrap; gap: 6px;
    font-size: 10.5px; color: var(--muted);
  }
  .or-meta-pill {
    padding: 2px 7px; border-radius: 10px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.18));
    color: var(--vscode-badge-foreground, var(--muted));
    white-space: nowrap;
    font-family: var(--mono);
  }
  .or-meta-pill.in { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
  .or-meta-pill.out { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .or-empty { padding: 20px; text-align: center; color: var(--muted); font-size: 12px; }

  /* ── Settings rows ──────────────────────────────── */
  .setting-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    margin-bottom: 14px;
    overflow: hidden;
  }
  .setting-group-title {
    padding: 10px 16px;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    background: var(--bg-hover);
    border-bottom: 1px solid var(--border);
  }
  .setting-row {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px 16px;
    align-items: center;
  }
  .setting-row:last-child { border-bottom: none; }
  .setting-label-block { min-width: 0; }
  .setting-name { font-weight: 600; font-size: 12.5px; margin-bottom: 2px; }
  .setting-desc { font-size: 11px; color: var(--muted); line-height: 1.4; }
  .setting-control { justify-self: end; min-width: 140px; max-width: 280px; }
  .setting-input {
    width: 100%;
    padding: 5px 9px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  .setting-input:focus { border-color: var(--accent); }
  .setting-toggle {
    appearance: none;
    width: 36px; height: 20px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    margin: 0;
  }
  .setting-toggle::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--vscode-foreground);
    border-radius: 50%;
    opacity: 0.5;
    transition: transform 0.15s, opacity 0.15s;
  }
  .setting-toggle:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .setting-toggle:checked::after {
    transform: translateX(16px);
    opacity: 1;
    background: var(--accent-fg);
  }
  .setting-slider-row {
    display: flex; align-items: center; gap: 10px;
  }
  .setting-slider { flex: 1; }
  .setting-slider-value {
    min-width: 40px;
    text-align: right;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }
  .setting-array-list {
    grid-column: 1 / -1;
    margin-top: 8px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .setting-array-row { display: flex; gap: 6px; }
  .setting-array-row .setting-input { font-family: var(--mono); }

  /* ── Activity log ───────────────────────────────── */
  .progress-shell {
    margin-bottom: 14px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }
  .progress-shell.idle { opacity: 0.5; }
  .progress-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .progress-label { font-weight: 600; font-size: 12px; }
  .progress-bar {
    width: 100%; height: 8px;
    border-radius: 4px;
    background: var(--vscode-input-background);
    overflow: hidden;
    position: relative;
  }
  .progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, white));
    transition: width 0.25s ease-out;
  }
  .progress-bar-fill.indeterminate {
    width: 30% !important;
    animation: indeterminate 1.4s ease-in-out infinite;
  }
  @keyframes indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(330%); }
  }
  .log-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .log {
    height: 420px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #0a0a0a;
    color: #d4d4d4;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.55;
    padding: 12px 14px;
  }
  .log-line { white-space: pre-wrap; word-break: break-word; }
  .log-line .ts { color: #888; margin-right: 8px; }
  .log-line .lvl {
    display: inline-block;
    min-width: 56px;
    margin-right: 8px;
    padding: 0 6px;
    border-radius: 4px;
    font-weight: 600;
    text-align: center;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .log-line.info  .lvl { background: rgba(64,128,255,0.18); color: #6ea8ff; }
  .log-line.progress .lvl { background: rgba(115,201,145,0.18); color: #73c991; }
  .log-line.warn  .lvl { background: rgba(204,167,0,0.18);   color: #cca700; }
  .log-line.error .lvl { background: rgba(244,71,71,0.2);    color: #f44747; }
  .log-line.done  .lvl { background: rgba(115,201,145,0.25); color: #73c991; }
  .log-line.cancelled .lvl { background: rgba(204,167,0,0.18); color: #cca700; }
  .log-line .err { color: #f44747; margin-left: 8px; opacity: 0.85; }

  /* ── Footer ──────────────────────────────────────── */
  .footer {
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
    flex-wrap: wrap;
  }
  .footer .spacer { flex: 1; }

  /* ── Toast ───────────────────────────────────────── */
  .toast-stack {
    position: fixed;
    bottom: 24px; right: 24px;
    display: flex; flex-direction: column; gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }
  .toast {
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--vscode-notifications-background, #2d2d30);
    color: var(--vscode-notifications-foreground, #ccc);
    border: 1px solid var(--border);
    box-shadow: 0 6px 20px rgba(0,0,0,0.25);
    max-width: 320px;
    animation: toastIn 0.18s ease-out;
    pointer-events: auto;
  }
  .toast.success { border-color: var(--success); }
  .toast.warn { border-color: var(--warn); }
  .toast.error { border-color: var(--danger); }
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="container">

  <header class="hero">
    <div class="hero-icon" aria-hidden="true">
      <svg width="44" height="44" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
        <rect width="128" height="128" rx="22" fill="#1a1d2e"/>
        <path d="M64 14 L110 38 L110 90 L64 114 L18 90 L18 38 Z" fill="none" stroke="#a78bfa" stroke-width="3"/>
        <path d="M64 26 L100 44 L100 84 L64 102 L28 84 L28 44 Z" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.35"/>
        <line x1="48" y1="48" x2="48" y2="80" stroke="#22d3ee" stroke-width="3" stroke-linecap="round"/>
        <line x1="48" y1="80" x2="80" y2="80" stroke="#22d3ee" stroke-width="3" stroke-linecap="round"/>
        <line x1="48" y1="48" x2="80" y2="80" stroke="#22d3ee" stroke-width="1" opacity="0.45" stroke-dasharray="3,3"/>
        <circle cx="48" cy="48" r="6.5" fill="#22d3ee"/>
        <circle cx="48" cy="80" r="6.5" fill="#22d3ee"/>
        <circle cx="80" cy="80" r="6.5" fill="#22d3ee"/>
        <circle cx="64" cy="64" r="3" fill="#a78bfa"/>
        <circle cx="74" cy="50" r="2" fill="#a78bfa" opacity="0.7"/>
      </svg>
    </div>
    <div><h1>Legion Dashboard</h1></div>
  </header>
  <p class="hero-sub" id="heroSub">Repo state, quick actions, and live activity.</p>

  <nav class="tabs" role="tablist">
    <button class="tab active" role="tab" data-tab="dashboard">Dashboard</button>
    <button class="tab" role="tab" data-tab="setup">API Keys &amp; Mode</button>
    <button class="tab" role="tab" data-tab="settings">Settings</button>
    <button class="tab" role="tab" data-tab="activity">Activity <span id="activeBadge" style="display:none" class="tab-badge">●</span></button>
  </nav>

  <!-- ═══ DASHBOARD TAB ═════════════════════════════ -->
  <div class="tab-panel active" data-tab-panel="dashboard">
    <section>
      <div class="section-header">
        <span class="section-title">Repository state</span>
      </div>
      <div class="stat-grid" id="statGrid"></div>
    </section>
    <section>
      <div class="section-header">
        <span class="section-title">Quick actions</span>
        <span class="section-meta">Run common commands without leaving the dashboard</span>
      </div>
      <div class="quick-grid">
        <button class="quick-card" data-cmd="legion.document">
          <div class="quick-card-name">Document Repository</div>
          <div class="quick-card-detail">Full pass — every file in scope. First-time scan or full rebuild.</div>
        </button>
        <button class="quick-card" data-cmd="legion.update">
          <div class="quick-card-name">Update</div>
          <div class="quick-card-detail">Diff-only pass — process files changed since last run.</div>
        </button>
        <button class="quick-card" data-cmd="legion.lintWiki">
          <div class="quick-card-name">Lint Wiki</div>
          <div class="quick-card-detail">Validate frontmatter, wikilinks, contradictions, orphans.</div>
        </button>
        <button class="quick-card" data-cmd="legion.findEntity">
          <div class="quick-card-name">Find Entity</div>
          <div class="quick-card-detail">Semantic search across the wiki — Ctrl+Shift+Alt+L.</div>
        </button>
        <button class="quick-card" data-cmd="legion.initialize">
          <div class="quick-card-name">Initialize Repository</div>
          <div class="quick-card-detail">Scaffold .cursor/, .legion/, library/, and bundled guardians.</div>
        </button>
        <button class="quick-card" data-cmd="legion.openDashboard">
          <div class="quick-card-name">Refresh Dashboard</div>
          <div class="quick-card-detail">Re-detect repo state.</div>
        </button>
      </div>
    </section>
    <section>
      <div class="section-header">
        <span class="section-title">Recent activity</span>
        <span class="section-meta">Last 10 events — full log on the Activity tab</span>
      </div>
      <div class="log" id="dashLog" style="height: 220px"></div>
    </section>
  </div>

  <!-- ═══ API KEYS & MODE TAB ═══════════════════════ -->
  <div class="tab-panel" data-tab-panel="setup">
    <section>
      <div class="section-header">
        <span class="section-title">Invocation mode</span>
        <span class="section-meta">Click a card to switch</span>
      </div>
      <div class="mode-grid" id="modeGrid"></div>
    </section>

    <section id="requiredSection" style="display:none">
      <div class="section-header">
        <span class="section-title">Required for this mode</span>
      </div>
      <div id="requiredKeysContainer"></div>
    </section>

    <section id="orModelSection" style="display:none">
      <div class="section-header">
        <span class="section-title">OpenRouter model</span>
        <span class="section-meta" id="orModelMeta">Searchable; pricing per 1M tokens</span>
      </div>
      <div class="or-toolbar">
        <input class="or-search" id="orSearch" type="text" placeholder="Filter — try 'claude', 'gpt', 'haiku', '200k'…" />
        <button class="btn" id="orRefresh" type="button" title="Re-fetch from openrouter.ai">Refresh</button>
        <span class="or-status" id="orStatus"></span>
      </div>
      <div class="or-list" id="orList">
        <div class="or-empty">Loading models from openrouter.ai…</div>
      </div>
    </section>

    <section>
      <div class="section-header">
        <span class="section-title">Optional providers</span>
        <span class="section-meta">Semantic search, web research, ingest</span>
      </div>
      <div id="optionalKeysContainer"></div>
    </section>
  </div>

  <!-- ═══ SETTINGS TAB ══════════════════════════════ -->
  <div class="tab-panel" data-tab-panel="settings">
    <section>
      <div class="section-header">
        <span class="section-title">Performance</span>
        <span class="section-meta">Speed vs cost vs quality knobs</span>
      </div>
      <div class="setting-group" id="settingsPerf"></div>
    </section>
    <section>
      <div class="section-header">
        <span class="section-title">Wiki</span>
        <span class="section-meta">How pages are written and surfaced</span>
      </div>
      <div class="setting-group" id="settingsWiki"></div>
    </section>
    <section>
      <div class="section-header">
        <span class="section-title">Federation</span>
        <span class="section-meta">Cross-repo wiki sharing</span>
      </div>
      <div class="setting-group" id="settingsFederation"></div>
    </section>
    <section>
      <div class="section-header">
        <span class="section-title">Research</span>
        <span class="section-meta">Autoresearch + ingest providers</span>
      </div>
      <div class="setting-group" id="settingsResearch"></div>
    </section>
  </div>

  <!-- ═══ ACTIVITY TAB ══════════════════════════════ -->
  <div class="tab-panel" data-tab-panel="activity">
    <div class="progress-shell idle" id="progressShell">
      <div class="progress-header">
        <span class="progress-label" id="progressLabel">No active operation</span>
        <button class="btn btn-danger" id="cancelBtn" type="button" disabled>Cancel</button>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" id="progressFill" style="width:0%"></div></div>
    </div>
    <div class="log-toolbar">
      <button class="btn" id="clearLogBtn" type="button">Clear log</button>
      <span class="spacer" style="flex:1"></span>
      <span class="or-status" id="logCount"></span>
    </div>
    <div class="log" id="activityLog"></div>
  </div>

  <div class="footer">
    <button class="btn btn-primary" id="btnDone" type="button">Save &amp; Document Repository</button>
    <button class="btn" id="btnClose" type="button">Close</button>
    <span class="spacer"></span>
    <span style="font-size:11px;color:var(--muted)" id="footerStatus">Ready.</span>
  </div>
</div>

<div class="toast-stack" id="toastStack"></div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();

  // ── Tab nav ─────────────────────────────────────
  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tabPanel === name));
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  // ── State ───────────────────────────────────────
  const MODE_CARDS = [
    { id: "direct-anthropic",  name: "Anthropic",  tagline: "Claude direct — claude.ai/console.anthropic.com", detail: "Calls Anthropic's Messages API directly. Requires an Anthropic API key." },
    { id: "direct-openrouter", name: "OpenRouter", tagline: "300+ models via one gateway", detail: "OpenAI-compatible. Use Claude, GPT-4, Llama, Gemini, Mistral, and more with one key." },
    { id: "queue-file",        name: "Manual",     tagline: "Write JSON requests, process via /legion-drain", detail: "No API key required. Legion writes payloads to .legion/queue/; you process them yourself." },
  ];
  let currentMode = "direct-anthropic";
  let currentKeys = [];
  let orModels = [];
  let orFilter = "";
  let orCurrentModel = "";
  let orHasFetched = false;
  let currentSettings = {};
  let currentActiveOp = null;
  let activityHistory = [];
  let progressTotal = 0;
  let progressCurrent = 0;

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatPrice(perToken) {
    if (!isFinite(perToken)) return "n/a";
    if (perToken === 0) return "free";
    const perM = perToken * 1000000;
    if (perM >= 100) return "$" + perM.toFixed(0) + "/M";
    if (perM >= 10)  return "$" + perM.toFixed(1) + "/M";
    return "$" + perM.toFixed(2) + "/M";
  }
  function formatContext(tokens) {
    if (!tokens) return "?";
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1) + "M";
    if (tokens >= 1000) return Math.round(tokens / 1000) + "k";
    return String(tokens);
  }
  function formatTs(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleString();
  }
  function formatRelative(ts) {
    if (!ts) return "never";
    const ms = Date.now() - new Date(ts).getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + "s ago";
    if (sec < 3600) return Math.round(sec / 60) + "m ago";
    if (sec < 86400) return Math.round(sec / 3600) + "h ago";
    return Math.round(sec / 86400) + "d ago";
  }

  // ── Dashboard tab ───────────────────────────────
  function renderStatGrid(repoState, settings, mode) {
    const grid = document.getElementById("statGrid");
    if (!repoState) {
      grid.innerHTML = '<div class="stat-card warn"><div class="stat-label">Workspace</div><div class="stat-value">No folder open</div><div class="stat-sub">Open a folder to use Legion.</div></div>';
      return;
    }
    const cards = [
      {
        cls: repoState.initialized ? "ok" : "warn",
        label: "Initialized",
        value: repoState.initialized ? "Yes" : "No",
        sub: repoState.initialized ? "library/knowledge-base/wiki/" : "Run Initialize Repository",
      },
      { cls: "", label: "Wiki pages", value: String(repoState.pageCount || 0), sub: "entity pages indexed" },
      {
        cls: repoState.lastScan ? "ok" : "",
        label: "Last scan",
        value: formatRelative(repoState.lastScan),
        sub: repoState.lastScan ? formatTs(repoState.lastScan) : "no scan yet",
      },
      {
        cls: "",
        label: "Active mode",
        value: mode === "direct-anthropic" ? "Anthropic" : mode === "direct-openrouter" ? "OpenRouter" : mode === "queue-file" ? "Manual" : mode,
        sub: settings.fastModelEnabled ? "fast model on" : (settings.maxParallelAgents + " parallel · chunks of " + settings.maxFilesPerChunk),
      },
    ];
    grid.innerHTML = cards.map((c) => \`
      <div class="stat-card \${c.cls}">
        <div class="stat-label">\${escHtml(c.label)}</div>
        <div class="stat-value">\${escHtml(c.value)}</div>
        <div class="stat-sub">\${escHtml(c.sub)}</div>
      </div>
    \`).join("");
  }

  document.querySelectorAll(".quick-card[data-cmd]").forEach((card) => {
    card.addEventListener("click", () => {
      const cmd = card.dataset.cmd;
      if (cmd === "legion.openDashboard") {
        vscode.postMessage({ command: "ready" });
      } else {
        vscode.postMessage({ command: "runCommand", commandId: cmd });
      }
    });
  });

  // ── Mode picker ─────────────────────────────────
  function renderModeGrid() {
    const grid = document.getElementById("modeGrid");
    grid.innerHTML = "";
    for (const m of MODE_CARDS) {
      const card = document.createElement("div");
      card.className = "mode-card" + (m.id === currentMode ? " active" : "");
      card.innerHTML = \`
        <div class="mode-name">\${escHtml(m.name)}</div>
        <div class="mode-tagline">\${escHtml(m.tagline)}</div>
        <div class="mode-detail">\${escHtml(m.detail)}</div>
      \`;
      card.addEventListener("click", () => {
        if (m.id === currentMode) return;
        vscode.postMessage({ command: "setMode", mode: m.id });
      });
      grid.appendChild(card);
    }
  }

  function renderKey(key) {
    const card = document.createElement("div");
    const isRequiredForMode = key.required === currentMode;
    const stateClass = key.configured ? "configured" : isRequiredForMode ? "required-missing" : "optional";
    card.className = "key-card " + stateClass;
    const badgeClass = key.configured ? "done" : isRequiredForMode ? "required" : "optional";
    const badgeText = key.configured ? "Configured" : isRequiredForMode ? "Required" : "Optional";

    card.innerHTML = \`
      <div class="key-row">
        <div class="key-label">
          <span class="key-name">\${escHtml(key.label)}</span>
          <span class="key-badge \${badgeClass}">\${escHtml(badgeText)}</span>
        </div>
      </div>
      <div class="key-input-row">
        <input class="key-input" type="password" autocomplete="off"
               placeholder="\${escHtml(key.configured ? key.masked : 'Paste or type your API key')}"
               data-key="\${escHtml(key.key)}" />
        <button class="btn" data-action="paste" data-key="\${escHtml(key.key)}" type="button" title="Paste from clipboard and save">Paste</button>
        <button class="btn btn-primary" data-action="save" data-key="\${escHtml(key.key)}" type="button">Save</button>
        \${key.configured ? '<button class="btn btn-danger" data-action="delete" data-key="' + escHtml(key.key) + '" type="button" title="Remove this key from secret storage">Clear</button>' : ""}
      </div>
      <div class="key-meta">
        \${key.configured ? '<span class="key-status-current">Current: ' + escHtml(key.masked) + '</span>' : '<span class="key-status-empty">Not configured</span>'}
        \${key.helpUrl ? '<span>·</span><a data-url="' + escHtml(key.helpUrl) + '">Get a key →</a>' : ""}
      </div>
    \`;

    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        const k = btn.getAttribute("data-key");
        if (action === "save") {
          const input = card.querySelector('.key-input[data-key="' + k + '"]');
          const val = input.value;
          if (!val.trim()) { toast("Enter a value first.", "warn"); return; }
          vscode.postMessage({ command: "saveKey", key: k, value: val });
          input.value = "";
        } else if (action === "paste") {
          vscode.postMessage({ command: "paste", key: k });
        } else if (action === "delete") {
          vscode.postMessage({ command: "deleteKey", key: k });
        }
      });
    });
    card.querySelector(".key-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") card.querySelector('[data-action="save"]')?.click();
    });
    card.querySelectorAll("a[data-url]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        vscode.postMessage({ command: "openExternal", value: a.getAttribute("data-url") });
      });
    });
    return card;
  }

  function renderKeys() {
    const required = document.getElementById("requiredKeysContainer");
    const optional = document.getElementById("optionalKeysContainer");
    const requiredSection = document.getElementById("requiredSection");
    required.innerHTML = "";
    optional.innerHTML = "";
    const requiredKeys = currentKeys.filter((k) => k.required === currentMode);
    const otherKeys = currentKeys.filter((k) => k.required !== currentMode);
    if (requiredKeys.length === 0) requiredSection.style.display = "none";
    else { requiredSection.style.display = ""; requiredKeys.forEach((k) => required.appendChild(renderKey(k))); }
    otherKeys.forEach((k) => optional.appendChild(renderKey(k)));
  }

  // ── OpenRouter model picker ─────────────────────
  function renderOrSection() {
    const section = document.getElementById("orModelSection");
    section.style.display = currentMode === "direct-openrouter" ? "" : "none";
    if (currentMode !== "direct-openrouter") return;
    if (!orHasFetched) {
      orHasFetched = true;
      vscode.postMessage({ command: "fetchOpenRouterModels" });
    }
    const list = document.getElementById("orList");
    if (!orModels.length) { list.innerHTML = '<div class="or-empty">Loading models from openrouter.ai…</div>'; return; }
    const filter = orFilter.trim().toLowerCase();
    const filtered = filter
      ? orModels.filter((m) => (m.id + " " + m.name + " " + (m.description || "") + " " + formatContext(m.context_length)).toLowerCase().includes(filter))
      : orModels;
    if (filtered.length === 0) { list.innerHTML = '<div class="or-empty">No models match "' + escHtml(orFilter) + '".</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const m of filtered.slice(0, 200)) {
      const row = document.createElement("div");
      row.className = "or-item" + (m.id === orCurrentModel ? " selected" : "");
      row.innerHTML = \`
        <div class="or-item-id">\${escHtml(m.id)}</div>
        <div></div>
        <div class="or-item-meta">
          <span class="or-meta-pill">\${escHtml(formatContext(m.context_length))} ctx</span>
          <span class="or-meta-pill in">\${escHtml(formatPrice(m.pricing.prompt))} in</span>
          <span class="or-meta-pill out">\${escHtml(formatPrice(m.pricing.completion))} out</span>
          \${m.modality ? '<span class="or-meta-pill">' + escHtml(m.modality) + '</span>' : ""}
        </div>
      \`;
      row.addEventListener("click", () => {
        if (m.id === orCurrentModel) return;
        orCurrentModel = m.id;
        vscode.postMessage({ command: "setOpenRouterModel", modelId: m.id });
        renderOrSection();
      });
      frag.appendChild(row);
    }
    list.innerHTML = "";
    list.appendChild(frag);
    const status = document.getElementById("orStatus");
    status.textContent = filter ? (filtered.length + " of " + orModels.length + " models") : (orModels.length + " models");
  }

  document.getElementById("orSearch").addEventListener("input", (e) => { orFilter = e.target.value; renderOrSection(); });
  document.getElementById("orRefresh").addEventListener("click", () => {
    document.getElementById("orList").innerHTML = '<div class="or-empty">Refreshing from openrouter.ai…</div>';
    vscode.postMessage({ command: "fetchOpenRouterModels", forceRefresh: true });
  });

  // ── Settings tab ────────────────────────────────
  // Each spec: { path, name, desc, kind: "toggle"|"slider"|"number"|"text"|"select"|"array", min?, max?, options?: [{value, label}] }
  const PERF_SETTINGS = [
    { path: "maxParallelAgents", name: "Parallel agents", desc: "Maximum agent invocations running concurrently. I/O-bound, dial up if you have API headroom.", kind: "slider", min: 1, max: 16 },
    { path: "maxFilesPerChunk",  name: "Files per chunk",  desc: "Bigger chunks = fewer LLM calls = faster, but more pages per call. Sweet spot 4–8.", kind: "slider", min: 4, max: 30 },
    { path: "documentMode",      name: "Document mode",    desc: "all = walk every file. diff = skip unchanged (acts like Update). Use 'diff' for fast repeat doc passes.", kind: "select", options: [{value:"all", label:"all"},{value:"diff", label:"diff"}] },
    { path: "fastModelEnabled",  name: "Fast model",       desc: "Swap to claude-haiku-4-5 (or anthropic/claude-haiku-4-5 on OpenRouter). 3-5× lower latency, terser prose.", kind: "toggle" },
    { path: "includeGitBlame",   name: "Git blame",        desc: "Include top-author + churn data per file. Slow (5-50× slower than git log). Off by default.", kind: "toggle" },
  ];
  const WIKI_SETTINGS = [
    { path: "injectCursorContext",   name: "Inject Cursor hot context", desc: "After each pass, write .cursor/rules/wiki-hot-context.md so Cursor auto-loads recent wiki context.", kind: "toggle" },
    { path: "showCodeLens",          name: "Show code lens",            desc: "'Legion wiki page' lens above functions/classes that have an entity page.", kind: "toggle" },
    { path: "autoGitCommit",         name: "Auto git commit",           desc: "Commit wiki changes automatically after each successful pass.", kind: "toggle" },
    { path: "installPostCommitHook", name: "Post-commit hook",          desc: "Install a git post-commit hook that queues Update on every commit.", kind: "toggle" },
    { path: "semanticSearchEnabled", name: "Semantic search index",     desc: "Build the embeddings index after each Document pass. Required by Find Entity.", kind: "toggle" },
    { path: "obsidianVaultPath",     name: "Obsidian vault path",       desc: "Absolute path to your Obsidian vault (so 'Open in Obsidian' jumps to the wiki folder).", kind: "text" },
    { path: "logFoldK",              name: "Log fold k",                desc: "Folds 2^k log entries into a checkpoint. Default 3 → 8 entries per checkpoint.", kind: "slider", min: 1, max: 5 },
  ];
  const FED_SETTINGS = [
    { path: "federation.publishManifest", name: "Publish manifest", desc: "Write federation-manifest.json after each pass so peer repos can reference your entities.", kind: "toggle" },
    { path: "federation.peers",            name: "Peer manifests",   desc: "URLs to remote federation-manifest.json files. Stub pages are written to wiki/external/<repo>/.", kind: "array" },
  ];
  const RES_SETTINGS = [
    { path: "researchProvider", name: "Research provider", desc: "Web search backend for Autoresearch. model-only = no web calls.", kind: "select", options: [
      {value:"model-only", label:"model-only"}, {value:"exa", label:"exa"}, {value:"firecrawl", label:"firecrawl"}, {value:"context7", label:"context7"}
    ]},
    { path: "researchRounds",   name: "Research rounds",   desc: "How many synthesis rounds Autoresearch does. More = deeper coverage, more API calls.", kind: "slider", min: 1, max: 5 },
  ];

  function renderSettingRow(spec) {
    const value = currentSettings[spec.path];
    const row = document.createElement("div");
    row.className = "setting-row";
    let control = "";
    if (spec.kind === "toggle") {
      control = '<input class="setting-toggle" type="checkbox" data-setting="' + spec.path + '"' + (value ? " checked" : "") + ' />';
    } else if (spec.kind === "slider") {
      control = '<div class="setting-slider-row"><input class="setting-slider" type="range" min="' + spec.min + '" max="' + spec.max + '" value="' + (value ?? spec.min) + '" data-setting="' + spec.path + '" /><span class="setting-slider-value" data-slider-display="' + spec.path + '">' + (value ?? spec.min) + '</span></div>';
    } else if (spec.kind === "number") {
      control = '<input class="setting-input" type="number" min="' + spec.min + '" max="' + spec.max + '" value="' + (value ?? "") + '" data-setting="' + spec.path + '" />';
    } else if (spec.kind === "text") {
      control = '<input class="setting-input" type="text" value="' + escHtml(String(value ?? "")) + '" data-setting="' + spec.path + '" />';
    } else if (spec.kind === "select") {
      control = '<select class="setting-input" data-setting="' + spec.path + '">' +
        spec.options.map((o) => '<option value="' + escHtml(o.value) + '"' + (o.value === value ? " selected" : "") + '>' + escHtml(o.label) + '</option>').join("") +
        '</select>';
    } else if (spec.kind === "array") {
      const arr = Array.isArray(value) ? value : [];
      const rows = arr.map((v, i) => '<div class="setting-array-row"><input class="setting-input" type="text" value="' + escHtml(v) + '" data-array-item="' + spec.path + '" data-array-idx="' + i + '" /><button class="btn btn-danger" data-array-del="' + spec.path + '" data-array-idx="' + i + '" type="button">×</button></div>').join("");
      control = '<button class="btn" data-array-add="' + spec.path + '" type="button">Add row</button>';
      row.innerHTML = '<div class="setting-label-block"><div class="setting-name">' + escHtml(spec.name) + '</div><div class="setting-desc">' + escHtml(spec.desc) + '</div></div><div class="setting-control">' + control + '</div><div class="setting-array-list" data-array-list="' + spec.path + '">' + rows + '</div>';
      wireRow(row, spec);
      return row;
    }
    row.innerHTML = '<div class="setting-label-block"><div class="setting-name">' + escHtml(spec.name) + '</div><div class="setting-desc">' + escHtml(spec.desc) + '</div></div><div class="setting-control">' + control + '</div>';
    wireRow(row, spec);
    return row;
  }

  function wireRow(row, spec) {
    const ctrl = row.querySelector('[data-setting]');
    if (ctrl) {
      const writeChange = (val) => {
        if (spec.kind === "slider") {
          const display = row.querySelector('[data-slider-display]');
          if (display) display.textContent = val;
        }
        vscode.postMessage({ command: "setSetting", path: spec.path, value: val });
      };
      if (spec.kind === "toggle") {
        ctrl.addEventListener("change", () => writeChange(ctrl.checked));
      } else if (spec.kind === "slider") {
        ctrl.addEventListener("input", () => {
          const display = row.querySelector('[data-slider-display]');
          if (display) display.textContent = ctrl.value;
        });
        ctrl.addEventListener("change", () => writeChange(Number(ctrl.value)));
      } else if (spec.kind === "number") {
        ctrl.addEventListener("change", () => writeChange(Number(ctrl.value)));
      } else if (spec.kind === "text") {
        let timer = null;
        ctrl.addEventListener("input", () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => writeChange(ctrl.value), 600);
        });
      } else if (spec.kind === "select") {
        ctrl.addEventListener("change", () => writeChange(ctrl.value));
      }
    }
    // Array editor wiring
    row.querySelectorAll('[data-array-add]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = btn.getAttribute("data-array-add");
        const arr = Array.isArray(currentSettings[path]) ? [...currentSettings[path]] : [];
        arr.push("");
        vscode.postMessage({ command: "setSetting", path, value: arr });
      });
    });
    row.querySelectorAll('[data-array-del]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = btn.getAttribute("data-array-del");
        const idx = Number(btn.getAttribute("data-array-idx"));
        const arr = Array.isArray(currentSettings[path]) ? [...currentSettings[path]] : [];
        arr.splice(idx, 1);
        vscode.postMessage({ command: "setSetting", path, value: arr });
      });
    });
    row.querySelectorAll('[data-array-item]').forEach((input) => {
      let timer = null;
      input.addEventListener("input", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const path = input.getAttribute("data-array-item");
          const idx = Number(input.getAttribute("data-array-idx"));
          const arr = Array.isArray(currentSettings[path]) ? [...currentSettings[path]] : [];
          arr[idx] = input.value;
          vscode.postMessage({ command: "setSetting", path, value: arr });
        }, 500);
      });
    });
  }

  function renderSettings() {
    const groups = [
      { id: "settingsPerf",       title: "Performance",    specs: PERF_SETTINGS },
      { id: "settingsWiki",       title: "Wiki",           specs: WIKI_SETTINGS },
      { id: "settingsFederation", title: "Federation",     specs: FED_SETTINGS },
      { id: "settingsResearch",   title: "Research",       specs: RES_SETTINGS },
    ];
    for (const g of groups) {
      const root = document.getElementById(g.id);
      if (!root) continue;
      root.innerHTML = "";
      g.specs.forEach((spec) => root.appendChild(renderSettingRow(spec)));
    }
  }

  // ── Activity tab ────────────────────────────────
  function levelLabel(level) {
    if (level === "info") return "info";
    if (level === "warn") return "warn";
    if (level === "error") return "error";
    if (level === "progress") return "···";
    if (level === "done") return "done";
    if (level === "cancelled") return "stop";
    return level;
  }

  function appendLogLine(target, e) {
    const div = document.createElement("div");
    div.className = "log-line " + e.level;
    const time = new Date(e.ts).toLocaleTimeString();
    div.innerHTML = '<span class="ts">' + escHtml(time) + '</span><span class="lvl">' + escHtml(levelLabel(e.level)) + '</span>' + escHtml(e.message) + (e.error ? '<span class="err">› ' + escHtml(e.error) + '</span>' : "");
    target.appendChild(div);
  }

  function renderLog() {
    const log = document.getElementById("activityLog");
    log.innerHTML = "";
    activityHistory.forEach((e) => appendLogLine(log, e));
    log.scrollTop = log.scrollHeight;
    document.getElementById("logCount").textContent = activityHistory.length + " event" + (activityHistory.length === 1 ? "" : "s");

    // Mini log on dashboard tab — last 10
    const dash = document.getElementById("dashLog");
    if (dash) {
      dash.innerHTML = "";
      activityHistory.slice(-10).forEach((e) => appendLogLine(dash, e));
      dash.scrollTop = dash.scrollHeight;
    }
  }

  function renderProgress() {
    const shell = document.getElementById("progressShell");
    const label = document.getElementById("progressLabel");
    const fill = document.getElementById("progressFill");
    const cancelBtn = document.getElementById("cancelBtn");
    const badge = document.getElementById("activeBadge");
    if (!currentActiveOp) {
      shell.classList.add("idle");
      label.textContent = "No active operation";
      fill.style.width = "0%";
      fill.classList.remove("indeterminate");
      cancelBtn.disabled = true;
      badge.style.display = "none";
      return;
    }
    shell.classList.remove("idle");
    badge.style.display = "";
    cancelBtn.disabled = false;
    const elapsedSec = Math.round((Date.now() - currentActiveOp.startedAt) / 1000);
    label.textContent = currentActiveOp.label + " · " + elapsedSec + "s elapsed";
    if (progressTotal > 0) {
      fill.classList.remove("indeterminate");
      const pct = Math.min(100, Math.max(0, (progressCurrent / progressTotal) * 100));
      fill.style.width = pct.toFixed(1) + "%";
    } else {
      fill.classList.add("indeterminate");
    }
  }

  document.getElementById("cancelBtn").addEventListener("click", () => {
    vscode.postMessage({ command: "cancelActive" });
  });
  document.getElementById("clearLogBtn").addEventListener("click", () => {
    vscode.postMessage({ command: "clearLog" });
  });

  // Tick the elapsed counter every second while an op is active.
  setInterval(() => { if (currentActiveOp) renderProgress(); }, 1000);

  // ── Toast ───────────────────────────────────────
  function toast(message, kind) {
    const stack = document.getElementById("toastStack");
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = message;
    stack.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transition = "opacity 0.2s";
      setTimeout(() => t.remove(), 220);
    }, 2800);
  }

  // ── Footer ──────────────────────────────────────
  document.getElementById("btnDone").addEventListener("click", () => vscode.postMessage({ command: "done" }));
  document.getElementById("btnClose").addEventListener("click", () => vscode.postMessage({ command: "close" }));

  // ── Host messages ───────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "setupState") {
      currentMode = msg.mode || "direct-anthropic";
      currentKeys = msg.keys || [];
      orCurrentModel = msg.openRouterModel || "";
      currentSettings = msg.settings || {};
      currentActiveOp = msg.activeOp || null;
      const configured = currentKeys.filter((k) => k.configured).length;
      const required = currentKeys.filter((k) => k.required === currentMode);
      const requiredDone = required.length === 0 || required.every((k) => k.configured);
      const status = requiredDone
        ? \`Ready · \${configured} key\${configured === 1 ? "" : "s"} configured\`
        : \`Required key for \${escHtml(currentMode)} not yet set\`;
      document.getElementById("footerStatus").textContent = status;
      renderModeGrid();
      renderKeys();
      renderOrSection();
      renderStatGrid(msg.repoState, currentSettings, currentMode);
      renderSettings();
      renderProgress();
    } else if (msg.type === "activityHistory") {
      activityHistory = msg.history || [];
      renderLog();
    } else if (msg.type === "activityEvent") {
      activityHistory.push(msg.event);
      if (activityHistory.length > 500) activityHistory.shift();
      if (msg.event.progress) {
        progressCurrent = msg.event.progress.current;
        progressTotal = msg.event.progress.total;
      }
      renderLog();
      renderProgress();
    } else if (msg.type === "activeOperation") {
      currentActiveOp = msg.op;
      if (!msg.op) { progressCurrent = 0; progressTotal = 0; }
      renderProgress();
    } else if (msg.type === "toast") {
      toast(msg.message, msg.kind);
    } else if (msg.type === "openRouterModelsLoading") {
      const list = document.getElementById("orList");
      if (list) list.innerHTML = '<div class="or-empty">Loading models from openrouter.ai…</div>';
    } else if (msg.type === "openRouterModels") {
      orModels = msg.models || [];
      const meta = document.getElementById("orModelMeta");
      if (meta) {
        const ageMin = Math.round((Date.now() - (msg.fetchedAt || Date.now())) / 60000);
        meta.textContent = msg.cached
          ? \`Searchable · cached \${ageMin === 0 ? "just now" : ageMin + " min ago"}\`
          : "Searchable · fresh from openrouter.ai";
      }
      renderOrSection();
    } else if (msg.type === "openRouterModelsError") {
      const list = document.getElementById("orList");
      if (list) list.innerHTML = '<div class="or-empty" style="color:var(--danger)">Failed to load models: ' + escHtml(msg.message) + '</div>';
    }
  });

  // ── Boot ────────────────────────────────────────
  renderModeGrid();
  vscode.postMessage({ command: "ready" });
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
