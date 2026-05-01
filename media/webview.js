// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  // ── Button → command wiring ───────────────────────
  const COMMANDS = [
    "initialize",
    "document",
    "update",
    "scanDirectory",
    "lint",
    "findEntity",
    "viewEntityGraph",
    "autoresearch",
    "foldLog",
    "saveConversation",
    "ingestUrl",
    "drainAgenda",
    "generateOnboardingBrief",
    "showCoverageDetails",
    "openContradictionInbox",
    "openSettings",
  ];

  COMMANDS.forEach((cmd) => {
    const el = document.getElementById(cmd);
    if (!el) return;
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // prevent <details> toggle for openInObsidian
      vscode.postMessage({ command: cmd });
    });
  });

  // openInObsidian is inside a <details> summary — needs stopPropagation
  const obsidianBtn = document.getElementById("openInObsidian");
  if (obsidianBtn) {
    obsidianBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ command: "openInObsidian" });
    });
  }

  // ── Request initial state from host ──────────────
  vscode.postMessage({ command: "requestState" });

  // ── Handle messages from extension host ──────────
  window.addEventListener("message", (event) => {
    const msg = event.data;

    // Config state (invocation mode badge)
    if (msg.type === "configState") {
      const badge = document.getElementById("invocationMode");
      if (badge && msg.invocationMode) {
        badge.textContent = msg.invocationMode;
      }
      const providerBadge = document.getElementById("researchProvider");
      if (providerBadge && msg.researchProvider) {
        providerBadge.textContent = msg.researchProvider;
        providerBadge.title = msg.researchProvider === "model-only"
          ? "Autoresearch uses model knowledge only. Set legion.researchProvider to use Exa, Firecrawl, or Context7."
          : `Autoresearch uses ${msg.researchProvider} for real web content.`;
      }
    }

    // Repo state (wiki init status, page count, last scan)
    if (msg.type === "repoState") {
      const state = msg.state;

      const dot = document.getElementById("statusDot");
      const wikiStatus = document.getElementById("wikiStatus");
      const lastScan = document.getElementById("lastScan");
      const pageCount = document.getElementById("pageCount");
      const initBtn = document.getElementById("initialize");
      const gettingStarted = document.getElementById("gettingStarted");

      if (dot) {
        dot.className = "status-dot " + (state.initialized ? "active" : "error");
      }

      if (wikiStatus) {
        wikiStatus.textContent = state.initialized ? "Initialized" : "Not initialized";
      }

      if (lastScan) {
        if (state.lastScan) {
          const d = new Date(state.lastScan);
          lastScan.textContent = formatRelative(d);
          lastScan.title = d.toLocaleString();
        } else {
          lastScan.textContent = state.initialized ? "Never scanned" : "—";
        }
      }

      if (pageCount) {
        pageCount.textContent = state.pageCount > 0 ? state.pageCount + " pages" : "—";
      }

      // Demote Initialize button and auto-close Getting Started when initialized
      if (initBtn) {
        if (state.initialized) {
          initBtn.textContent = "Re-initialize Repository";
          initBtn.className = "btn-primary demoted";
          initBtn.title = "Re-run initialization to update guardian selection or repair missing files. Idempotent.";
          if (gettingStarted) gettingStarted.removeAttribute("open");
        } else {
          initBtn.textContent = "Initialize Repository";
          initBtn.className = "btn-primary";
          if (gettingStarted) gettingStarted.setAttribute("open", "");
        }
      }
    }

    // Last scan update after a scan completes
    if (msg.type === "statusUpdate") {
      const lastScan = document.getElementById("lastScan");
      if (lastScan) {
        lastScan.textContent = msg.text;
      }
    }

    // Page count update
    if (msg.type === "pageCountUpdate") {
      const el = document.getElementById("pageCount");
      if (el && msg.count != null) {
        el.textContent = msg.count + " pages";
      }
    }

    // Contradiction count (hidden at 0)
    if (msg.type === "coverageUpdate") {
      const bar = document.getElementById("coverageBar");
      const text = document.getElementById("coverageText");
      if (bar && text && msg.summary) {
        text.textContent = msg.summary;
        bar.style.display = "";
      }
    }

    if (msg.type === "contradictionCount") {
      const btn = document.getElementById("openContradictionInbox");
      const badge = document.getElementById("contradictionBadge");
      if (btn && badge) {
        badge.textContent = String(msg.count);
        if (msg.count > 0) {
          btn.classList.add("visible");
        } else {
          btn.classList.remove("visible");
        }
      }
    }
  });

  // ── Helpers ───────────────────────────────────────

  function formatRelative(date) {
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    const diffDay = Math.floor(diffHr / 24);
    return diffDay + "d ago";
  }
})();
