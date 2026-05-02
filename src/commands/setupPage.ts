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
      }) => {
        try {
          switch (msg.command) {
            case "ready":
              await this._pushState();
              break;

            case "setMode":
              if (msg.mode) {
                const cfg = vscode.workspace.getConfiguration("legion");
                await cfg.update(
                  "agentInvocationMode",
                  msg.mode,
                  vscode.ConfigurationTarget.Global
                );
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
    const mode = cfg.get<string>("agentInvocationMode", "cursor-sdk");
    const keys = await getSetupState(this._context, mode);
    void this._panel.webview.postMessage({ type: "setupState", keys, mode });
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
    background: linear-gradient(135deg, var(--accent), var(--link));
    color: var(--accent-fg);
    font-weight: 700;
    font-size: 18px;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
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
    <div class="hero-icon">L</div>
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
      id: "cursor-sdk",
      name: "cursor-sdk",
      tagline: "Cursor agent runtime (recommended for Cursor users)",
      detail: "Invokes guardians via @cursor/sdk. Requires a Cursor API key (paid plan)."
    },
    {
      id: "direct-anthropic-api",
      name: "direct-anthropic-api",
      tagline: "Anthropic / OpenRouter — works everywhere",
      detail: "Calls Anthropic Claude or OpenRouter directly. No Cursor subscription needed."
    },
    {
      id: "queue-file",
      name: "queue-file",
      tagline: "Manual processing via /legion-drain",
      detail: "Writes JSON request files to .legion/queue/. No API key required."
    },
  ];

  let currentMode = "cursor-sdk";
  let currentKeys = [];

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

  // ── Host messages ───────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "setupState") {
      currentMode = msg.mode || "cursor-sdk";
      currentKeys = msg.keys || [];
      const configured = currentKeys.filter((k) => k.configured).length;
      const required = currentKeys.filter((k) => k.required === currentMode);
      const requiredDone = required.length === 0 || required.every((k) => k.configured);
      const status = requiredDone
        ? \`Ready · \${configured} key\${configured === 1 ? "" : "s"} configured\`
        : \`Required key for \${escHtml(currentMode)} not yet set\`;
      document.getElementById("footerStatus").textContent = status;
      renderModeGrid();
      renderKeys();
    } else if (msg.type === "toast") {
      toast(msg.message, msg.kind);
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
