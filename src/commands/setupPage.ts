/**
 * Legion Setup — full-page webview in the editor area.
 *
 * Beats the QuickPick chain UX: shows ALL invocation modes and ALL API keys
 * on one screen. User picks a mode, fills the keys they want, clicks Save.
 * Reveals masked previews of already-configured keys without leaking values.
 *
 * Singleton pattern (mirrors DashboardPanel) — calling `open()` twice just
 * focuses the existing panel.
 *
 * Webview ↔ host messages:
 *   • `setupState` (host → webview): full key inventory + current mode
 *   • `saveKey` { key, value } (webview → host): store one key + ack
 *   • `deleteKey` { key } (webview → host): remove a key
 *   • `setMode` { mode } (webview → host): update agentInvocationMode setting
 *   • `paste` { key } (webview → host): read clipboard → save → ack
 *   • `done` (webview → host): close panel + open Document Repository
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  SECRET_KEYS,
  getSetupState,
  setSecret,
  deleteSecret,
  type SecretKey,
  type SetupKeyState,
} from "../util/secretStore";
import {
  getOpenRouterModels,
  formatPrice,
  formatContext,
  type OpenRouterModel,
} from "../util/openrouterModels";

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
      "legionSetup",
      "Legion Setup",
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

    this._panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        key?: SecretKey;
        value?: string;
        mode?: string;
        modelId?: string;
        forceRefresh?: boolean;
      }) => {
        try {
          switch (msg.command) {
            case "ready":
              await this._pushState();
              break;

            case "setMode":
              if (msg.mode) {
                // UI modes ↔ underlying settings:
                //   "direct-anthropic"   → agentInvocationMode=direct-anthropic-api, apiProvider=anthropic
                //   "direct-openrouter"  → agentInvocationMode=direct-anthropic-api, apiProvider=openrouter
                //   "queue-file"         → agentInvocationMode=queue-file (apiProvider untouched)
                // Why split: the underlying `direct-anthropic-api` setting value covers both
                // providers and is disambiguated by `apiProvider`. Without writing both,
                // users who picked "OpenRouter" still got Anthropic-key-required errors.
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
              // Pull the model catalog (24h cached). Streams two replies:
              // "openRouterModelsLoading" so the UI can show a spinner, then
              // "openRouterModels" with the data once resolved.
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
                await cfg.update(
                  "openRouterModel",
                  msg.modelId,
                  vscode.ConfigurationTarget.Global
                );
                await this._pushState();
                await this._sidebarRefresh?.();
                void this._panel.webview.postMessage({
                  type: "toast",
                  message: `OpenRouter model set to ${msg.modelId}.`,
                  kind: "success",
                });
              }
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
    // Initial state push happens via the webview's "ready" message
  }

  private async _pushState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("legion");
    const agentMode = cfg.get<string>("agentInvocationMode", "direct-anthropic-api");
    const apiProvider = cfg.get<string>("apiProvider", "anthropic");
    // Collapse (agentInvocationMode, apiProvider) → single UI mode id that
    // matches the cards rendered in the webview. Legacy `cursor-sdk` users
    // pass through unchanged so we don't clobber their settings just by
    // opening the page; they simply see no card highlighted.
    let uiMode = "direct-anthropic";
    if (agentMode === "queue-file") uiMode = "queue-file";
    else if (agentMode === "cursor-sdk") uiMode = "cursor-sdk";
    else if (apiProvider === "openrouter") uiMode = "direct-openrouter";
    else uiMode = "direct-anthropic";
    const keys = await getSetupState(this._context, uiMode);
    const openRouterModel = cfg.get<string>("openRouterModel", "anthropic/claude-sonnet-4-5");
    void this._panel.webview.postMessage({
      type: "setupState",
      keys,
      mode: uiMode,
      openRouterModel,
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
<title>Legion Setup</title>
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
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 32px 40px 64px;
    line-height: 1.5;
  }

  .container { max-width: 760px; margin: 0 auto; }

  /* ── Hero ───────────────────────────────────────── */
  .hero {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 8px;
  }
  .hero-icon {
    width: 44px; height: 44px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .hero-icon svg {
    width: 100%; height: 100%;
    display: block;
  }
  .hero h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .hero-sub {
    color: var(--muted);
    font-size: 12px;
    margin-top: 36px;
    margin-left: 58px;
    margin-bottom: 28px;
  }

  /* ── Section ─────────────────────────────────────── */
  section { margin-bottom: 32px; }
  .section-header {
    display: flex; align-items: baseline; gap: 8px;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 11px; font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-foreground);
    opacity: 0.85;
  }
  .section-meta { color: var(--muted); font-size: 11px; }

  /* ── Mode picker ─────────────────────────────────── */
  .mode-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  @media (min-width: 700px) {
    .mode-grid { grid-template-columns: repeat(3, 1fr); }
  }
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
    position: absolute;
    top: 10px; right: 12px;
    color: var(--accent);
    font-weight: 700;
    font-size: 14px;
  }
  .mode-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .mode-tagline {
    font-size: 12px;
    margin-bottom: 4px;
  }
  .mode-detail {
    font-size: 10.5px;
    color: var(--muted);
    line-height: 1.4;
  }

  /* ── Key card ────────────────────────────────────── */
  .key-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px 14px;
    background: var(--bg-elevated);
    margin-bottom: 10px;
    transition: border-color 0.15s, background 0.15s;
  }
  .key-card.required-missing {
    border-color: color-mix(in srgb, var(--warn) 60%, var(--border));
    background: color-mix(in srgb, var(--warn) 4%, var(--bg-elevated));
  }
  .key-card.configured {
    border-color: color-mix(in srgb, var(--success) 35%, var(--border));
  }

  .key-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .key-label {
    flex: 1 1 auto;
    min-width: 0;
    display: flex; align-items: baseline; gap: 8px;
  }
  .key-name {
    font-weight: 600;
    font-size: 13px;
  }
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

  .key-input-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px;
  }
  .key-input {
    flex: 1 1 auto; min-width: 0;
    padding: 7px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: var(--radius-sm);
    font-family: var(--vscode-editor-font-family, monospace);
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
  .btn-primary {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-danger:hover {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
  }

  .key-meta {
    display: flex; align-items: center; gap: 10px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
  }
  .key-meta a {
    color: var(--link);
    text-decoration: none;
    cursor: pointer;
  }
  .key-meta a:hover { text-decoration: underline; }

  .key-status-current {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--success);
  }
  .key-status-empty {
    font-style: italic;
    font-size: 11px;
    color: var(--muted);
  }

  /* ── OpenRouter model picker ─────────────────────── */
  .or-toolbar {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
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
  .or-status {
    font-size: 11px; color: var(--muted);
    white-space: nowrap;
  }
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
  .or-item-id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    font-weight: 600;
    word-break: break-all;
  }
  .or-item-meta {
    grid-column: 1 / -1;
    display: flex; flex-wrap: wrap; gap: 6px;
    font-size: 10.5px;
    color: var(--muted);
  }
  .or-meta-pill {
    padding: 2px 7px;
    border-radius: 10px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.18));
    color: var(--vscode-badge-foreground, var(--muted));
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .or-meta-pill.in { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
  .or-meta-pill.out { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .or-empty {
    padding: 20px; text-align: center;
    color: var(--muted); font-size: 12px;
  }

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
    to { opacity: 1; transform: translateX(0); }
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
    <div>
      <h1>Legion Setup</h1>
    </div>
  </header>
  <p class="hero-sub">
    Configure how Legion invokes guardians and which API keys it has access to.
    Keys are stored in your operating system's encrypted secret store
    (DPAPI on Windows, Keychain on macOS, libsecret on Linux) — never in settings.json.
  </p>

  <!-- ── Mode picker ───────────────────────────────────── -->
  <section>
    <div class="section-header">
      <span class="section-title">Invocation mode</span>
      <span class="section-meta">Click a card to switch</span>
    </div>
    <div class="mode-grid" id="modeGrid">
      <!-- Populated by JS -->
    </div>
  </section>

  <!-- ── Required key (for current mode) ───────────────── -->
  <section id="requiredSection" style="display:none">
    <div class="section-header">
      <span class="section-title">Required for this mode</span>
    </div>
    <div id="requiredKeysContainer"></div>
  </section>

  <!-- ── OpenRouter model picker (only when uiMode = direct-openrouter) ── -->
  <section id="orModelSection" style="display:none">
    <div class="section-header">
      <span class="section-title">OpenRouter model</span>
      <span class="section-meta" id="orModelMeta">Searchable; pricing per 1M tokens</span>
    </div>
    <div class="or-toolbar">
      <input class="or-search" id="orSearch" type="text"
             placeholder="Filter models — try 'claude', 'gpt', 'haiku', '200k'…" />
      <button class="btn" id="orRefresh" type="button" title="Re-fetch from openrouter.ai">Refresh</button>
      <span class="or-status" id="orStatus"></span>
    </div>
    <div class="or-list" id="orList">
      <div class="or-empty">Loading models from openrouter.ai…</div>
    </div>
  </section>

  <!-- ── All other keys ────────────────────────────────── -->
  <section>
    <div class="section-header">
      <span class="section-title">Optional providers</span>
      <span class="section-meta">Enable extra capabilities (semantic search, web research, ingest)</span>
    </div>
    <div id="optionalKeysContainer"></div>
  </section>

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
  const MODE_CARDS = [
    {
      id: "direct-anthropic",
      name: "Anthropic",
      tagline: "Claude direct — claude.ai/console.anthropic.com",
      detail: "Calls Anthropic's Messages API directly. Requires an Anthropic API key."
    },
    {
      id: "direct-openrouter",
      name: "OpenRouter",
      tagline: "300+ models via one gateway",
      detail: "OpenAI-compatible. Use Claude, GPT-4, Llama, Gemini, Mistral, and more with one key."
    },
    {
      id: "queue-file",
      name: "Manual",
      tagline: "Write JSON requests, process via /legion-drain",
      detail: "No API key required. Legion writes payloads to .legion/queue/; you process them yourself."
    },
  ];

  let currentMode = "direct-anthropic";
  let currentKeys = [];
  let orModels = [];
  let orFilter = "";
  let orCurrentModel = "";
  let orHasFetched = false;

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

  // ── Key cards ──────────────────────────────────
  function renderKey(key) {
    const card = document.createElement("div");
    const isRequiredForMode = key.required === currentMode;
    const stateClass = key.configured
      ? "configured"
      : isRequiredForMode
      ? "required-missing"
      : "optional";

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
        <button class="btn" data-action="paste" data-key="\${escHtml(key.key)}" type="button"
                title="Paste from clipboard and save">Paste</button>
        <button class="btn btn-primary" data-action="save" data-key="\${escHtml(key.key)}" type="button">Save</button>
        \${key.configured ? \`<button class="btn btn-danger" data-action="delete" data-key="\${escHtml(key.key)}" type="button" title="Remove this key from secret storage">Clear</button>\` : ""}
      </div>
      <div class="key-meta">
        \${key.configured
          ? \`<span class="key-status-current">Current: \${escHtml(key.masked)}</span>\`
          : \`<span class="key-status-empty">Not configured</span>\`}
        \${key.helpUrl ? \`<span>·</span><a data-url="\${escHtml(key.helpUrl)}">Get a key →</a>\` : ""}
      </div>
    \`;

    // Wire buttons
    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const action = btn.getAttribute("data-action");
        const k = btn.getAttribute("data-key");
        if (action === "save") {
          const input = card.querySelector(\`.key-input[data-key="\${k}"]\`);
          const val = input.value;
          if (!val.trim()) {
            toast("Enter a value first.", "warn");
            return;
          }
          vscode.postMessage({ command: "saveKey", key: k, value: val });
          input.value = "";
        } else if (action === "paste") {
          vscode.postMessage({ command: "paste", key: k });
        } else if (action === "delete") {
          vscode.postMessage({ command: "deleteKey", key: k });
        }
      });
    });

    // Save on Enter inside input
    card.querySelector(".key-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const btn = card.querySelector('[data-action="save"]');
        btn?.click();
      }
    });

    // Help link → openExternal
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

    if (requiredKeys.length === 0) {
      requiredSection.style.display = "none";
    } else {
      requiredSection.style.display = "";
      requiredKeys.forEach((k) => required.appendChild(renderKey(k)));
    }
    otherKeys.forEach((k) => optional.appendChild(renderKey(k)));
  }

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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

  // ── Footer buttons ──────────────────────────────
  document.getElementById("btnDone").addEventListener("click", () => {
    vscode.postMessage({ command: "done" });
  });
  document.getElementById("btnClose").addEventListener("click", () => {
    vscode.postMessage({ command: "close" });
  });

  // ── OpenRouter model picker ─────────────────────
  function formatPrice(perToken) {
    if (!isFinite(perToken)) return "n/a";
    if (perToken === 0) return "free";
    const perM = perToken * 1_000_000;
    if (perM >= 100) return "$" + perM.toFixed(0) + "/M";
    if (perM >= 10) return "$" + perM.toFixed(1) + "/M";
    return "$" + perM.toFixed(2) + "/M";
  }
  function formatContext(tokens) {
    if (!tokens) return "?";
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1) + "M";
    if (tokens >= 1000) return Math.round(tokens / 1000) + "k";
    return String(tokens);
  }

  function renderOrSection() {
    const section = document.getElementById("orModelSection");
    section.style.display = currentMode === "direct-openrouter" ? "" : "none";
    if (currentMode !== "direct-openrouter") return;

    if (!orHasFetched) {
      orHasFetched = true;
      vscode.postMessage({ command: "fetchOpenRouterModels" });
    }

    const list = document.getElementById("orList");
    if (!orModels.length) {
      list.innerHTML = '<div class="or-empty">Loading models from openrouter.ai…</div>';
      return;
    }
    const filter = orFilter.trim().toLowerCase();
    const filtered = filter
      ? orModels.filter((m) => {
          const haystack = (m.id + " " + m.name + " " + (m.description || "") + " " + formatContext(m.context_length)).toLowerCase();
          return haystack.includes(filter);
        })
      : orModels;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="or-empty">No models match "' + escHtml(orFilter) + '".</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of filtered.slice(0, 200)) {
      const row = document.createElement("div");
      const isSelected = m.id === orCurrentModel;
      row.className = "or-item" + (isSelected ? " selected" : "");
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
    if (filter) {
      status.textContent = filtered.length + " of " + orModels.length + " models";
    } else {
      status.textContent = orModels.length + " models";
    }
  }

  document.getElementById("orSearch").addEventListener("input", (e) => {
    orFilter = e.target.value;
    renderOrSection();
  });
  document.getElementById("orRefresh").addEventListener("click", () => {
    document.getElementById("orList").innerHTML = '<div class="or-empty">Refreshing from openrouter.ai…</div>';
    vscode.postMessage({ command: "fetchOpenRouterModels", forceRefresh: true });
  });

  // ── Host messages ───────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "setupState") {
      currentMode = msg.mode || "cursor-sdk";
      currentKeys = msg.keys || [];
      orCurrentModel = msg.openRouterModel || "";
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
      if (list) {
        list.innerHTML = '<div class="or-empty" style="color:var(--danger)">Failed to load models: ' + escHtml(msg.message) + '</div>';
      }
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
