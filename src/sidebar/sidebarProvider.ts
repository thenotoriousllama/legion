import * as vscode from "vscode";

export class LegionSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "src", "sidebar", "media"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

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
        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "legion"
          );
          break;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "sidebar", "media", "webview.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "sidebar", "media", "webview.js")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>Legion</title>
</head>
<body>
  <div class="legion-sidebar">
    <header>
      <h1>Legion</h1>
      <p class="tagline">Per-repo wiki for code.</p>
    </header>

    <section class="actions">
      <button id="initialize" class="primary" type="button">Initialize Repository</button>
      <button id="document" type="button">Document Repository</button>
      <button id="update" type="button">Update Documentation</button>
      <button id="scanDirectory" type="button">Scan Directory…</button>
      <button id="lint" type="button">Lint Wiki</button>
    </section>

    <section class="status">
      <h2>Last scan</h2>
      <p id="lastScan" class="muted">No scan yet. Click Initialize to begin.</p>
    </section>

    <footer>
      <button id="openSettings" class="link" type="button">Settings</button>
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
