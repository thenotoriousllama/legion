// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const buttons = ["initialize", "document", "update", "scanDirectory", "lint", "openSettings"];
  buttons.forEach((cmd) => {
    const el = document.getElementById(cmd);
    if (!el) return;
    el.addEventListener("click", () => {
      vscode.postMessage({ command: cmd });
    });
  });

  // Receive status updates from the extension host.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "statusUpdate") {
      const lastScan = document.getElementById("lastScan");
      if (lastScan) {
        lastScan.textContent = msg.text;
        lastScan.classList.remove("muted");
      }
    }
  });
})();
