import * as vscode from "vscode";
import * as crypto from "crypto";
import { loadSnapshots, type Snapshot } from "../driver/snapshotManager";
import { renderLineChart } from "./charts/lineChart";
import { renderStackedAreaChart } from "./charts/stackedAreaChart";
import { renderAdrBarChart } from "./charts/adrBarChart";
import { renderContradictionChart } from "./charts/contradictionChart";
import { renderModuleCoverageChart } from "./charts/moduleCoverageChart";
import { buildMarkdownTable } from "./markdownTable";

// ── Singleton panel ────────────────────────────────────────────────────────────

export class DashboardPanel {
  static currentPanel: DashboardPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _repoRoot: string;
  private readonly _disposables: vscode.Disposable[] = [];

  /** Open (or focus) the Legion Analytics panel. */
  static open(repoRoot: string, context: vscode.ExtensionContext): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "legionDashboard",
      "Legion Analytics",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, repoRoot, context);
  }

  /** Refresh the open panel if it exists. Called by `legion.internal.dashboardRefresh`. */
  static refresh(): void {
    DashboardPanel.currentPanel?._update();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    repoRoot: string,
    _context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._repoRoot = repoRoot;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message: { command: string; chartId?: string }) => {
        if (message.command === "copyTable" && message.chartId) {
          const snapshots = await loadSnapshots(this._repoRoot);
          const table = buildMarkdownTable(message.chartId, snapshots);
          await vscode.env.clipboard.writeText(table);
          vscode.window.showInformationMessage("Legion: Copied to clipboard.");
        } else if (message.command === "refresh") {
          this._update();
        }
      },
      null,
      this._disposables
    );
  }

  private async _update(): Promise<void> {
    const snapshots = await loadSnapshots(this._repoRoot);
    this._panel.webview.html = this._buildHtml(snapshots);
  }

  private _buildHtml(snapshots: Snapshot[]): string {
    const nonce = getNonce();
    const last = snapshots.length ? snapshots[snapshots.length - 1].date.slice(0, 10) : "none";

    const noData = `<p class="no-data">No snapshots yet — run Legion to collect data.</p>`;
    const need2 = `<p class="no-data">Need at least 2 snapshots for trend charts.</p>`;

    const entityChart =
      snapshots.length === 0
        ? noData
        : renderLineChart(
            snapshots.map((s) => ({ date: s.date, value: s.entityCount })),
            { title: "Entity Count Over Time", yLabel: "Entities", color: "#3b82f6" }
          );

    const maturityChart = snapshots.length < 2 ? need2 : renderStackedAreaChart(snapshots);
    const adrChart = renderAdrBarChart(snapshots);
    const contradictionChart = renderContradictionChart(snapshots);
    const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const moduleChart = latestSnapshot
      ? renderModuleCoverageChart(latestSnapshot.byModule)
      : noData;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px;
      margin: 0;
    }
    h2 { margin-bottom: 4px; }
    .meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
    .refresh-btn {
      font-size: 12px;
      padding: 2px 8px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, #ccc);
      border-radius: 3px;
    }
    .chart-section { margin-bottom: 36px; }
    .chart-section h3 { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
    .copy-btn {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      padding: 3px 10px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, #ccc);
      border-radius: 3px;
    }
    .no-data { color: var(--vscode-descriptionForeground); font-style: italic; }
    svg text { font-family: var(--vscode-font-family); }
    svg { max-width: 100%; }
  </style>
</head>
<body>
  <h2>Legion Analytics Dashboard</h2>
  <p class="meta">
    Snapshots: <strong>${snapshots.length}</strong> / 90 &nbsp;·&nbsp;
    Last: <strong>${last}</strong>
    &nbsp;<button class="refresh-btn" onclick="doRefresh()">↻ Refresh</button>
  </p>

  <div class="chart-section">
    <h3>Entity Count Over Time</h3>
    ${entityChart}
    <button class="copy-btn" onclick="copyTable('entity-count')">Copy as Markdown table</button>
  </div>

  <div class="chart-section">
    <h3>Maturity Distribution Over Time</h3>
    ${maturityChart}
    <button class="copy-btn" onclick="copyTable('maturity')">Copy as Markdown table</button>
  </div>

  <div class="chart-section">
    <h3>ADR Filing Rate (Monthly)</h3>
    ${adrChart}
    <button class="copy-btn" onclick="copyTable('adr-rate')">Copy as Markdown table</button>
  </div>

  <div class="chart-section">
    <h3>Contradiction Rate Over Time</h3>
    ${contradictionChart}
    <button class="copy-btn" onclick="copyTable('contradiction-rate')">Copy as Markdown table</button>
  </div>

  <div class="chart-section">
    <h3>Coverage by Module (latest snapshot)</h3>
    ${moduleChart}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function copyTable(chartId) {
      vscode.postMessage({ command: 'copyTable', chartId });
    }
    function doRefresh() {
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables.length = 0;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
