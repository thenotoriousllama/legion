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
    // v1.2.5: setupWizard moved into the auto-wired COMMANDS list.
    "setupWizard",
    "setupReconfigure",
    // v1.2.9: Brand-new ID for the sidebar Setup button. Eliminates any
    // collision/cache risk with the previous "setupWizard" name that was
    // silently failing for several releases.
    "openSetupPage",
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

    // ── Setup state (v1.2.8: setup-card removed; message is a no-op now.
    //   The dedicated Setup Page WebviewPanel is the source of truth for
    //   API-key status. The sidebar just has an "Open Setup Page" button. ──
    if (msg.type === "setupState") {
      // Intentionally no-op. Kept so the host can still send the message
      // without errors — the page's own webview handles its own state.
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

  // ── Setup section renderer ────────────────────────
  // v1.2.8: The setup card in the sidebar (progress ring, per-key rows,
  // complete state) was removed in favor of a single "Open Setup Page"
  // button in the action area. The Setup Page WebviewPanel is the source
  // of truth for API key state.
  //
  // The renderSetupSection function below is dead code (no longer called —
  // the setupState message handler above is a no-op now) but is kept
  // verbatim because its early-return guard `if (!card || ...) return;`
  // makes it harmless: every getElementById will return null since the
  // setup-card HTML is gone, and the function exits cleanly.

  /** SVG icons for the setup rows (monoline, 14×14, currentColor). */
  const ICONS = {
    key: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="setup-row-icon" aria-hidden="true">
      <circle cx="5" cy="8" r="3.5" stroke="currentColor" stroke-width="1.2"/>
      <path d="M8 8h4M10 6.5V8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
    check: `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="5" stroke="currentColor" stroke-width="1"/>
      <path d="M3 5.5l1.8 1.8 3.2-3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    warn: `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path d="M5.5 1L10 9.5H1L5.5 1Z" stroke="currentColor" stroke-width="1"/>
      <path d="M5.5 4.5v2.2M5.5 8h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
    paste: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1" y="3" width="8" height="9" rx="1" stroke="currentColor" stroke-width="1"/>
      <path d="M3 3V2a1 1 0 011-1h5a1 1 0 011 1v7a1 1 0 01-1 1H9" stroke="currentColor" stroke-width="1"/>
    </svg>`,
  };

  let _prevConfiguredCount = -1;

  /**
   * Render (or re-render) the entire Setup section from a SetupKeyState array.
   * @param {Array<{key:string,label:string,configured:boolean,masked:string,required:string|null}>} keys
   * @param {string} mode
   */
  function renderSetupSection(keys, mode) {
    const card = document.getElementById("setupCard");
    const details = document.getElementById("setupDetails");
    const body = document.getElementById("setupBody");
    const ringFill = document.getElementById("setupRingFill");
    const ringText = document.getElementById("setupRingText");
    const ring = document.getElementById("setupRing");
    const completeLine = document.getElementById("setupCompleteLine");
    const incompleteTitle = document.getElementById("setupIncompleteTitle");
    const toggleIcon = document.getElementById("setupToggleIcon");
    if (!card || !body || !ringFill || !ringText) return;

    // Count keys relevant to current mode
    const requiredKeys = keys.filter((k) => k.required === mode);
    const optionalKeys = keys.filter((k) => !k.required);
    const requiredConfigured = requiredKeys.filter((k) => k.configured).length;
    const totalConfigured = keys.filter((k) => k.configured).length;
    const requiredTotal = requiredKeys.length;
    const allRequiredDone = requiredTotal === 0 || requiredConfigured === requiredKeys.length;

    // Show card — it was hidden until first setupState arrived
    card.style.display = "";

    // Progress ring math — circumference = 2π × 12 ≈ 75.4
    const CIRCUMFERENCE = 75.4;
    const displayTotal = requiredTotal > 0 ? requiredTotal : keys.length;
    const displayConfigured = requiredTotal > 0 ? requiredConfigured : totalConfigured;
    const fraction = displayTotal > 0 ? displayConfigured / displayTotal : 0;
    const offset = CIRCUMFERENCE * (1 - fraction);
    ringFill.style.strokeDashoffset = String(offset);
    ringText.textContent = `${displayConfigured}/${displayTotal}`;

    // Pulse ring when a key is newly configured
    if (_prevConfiguredCount >= 0 && displayConfigured > _prevConfiguredCount) {
      ring.classList.remove("pulse");
      void ring.offsetWidth; // force reflow
      ring.classList.add("pulse");
      ring.addEventListener("animationend", () => ring.classList.remove("pulse"), { once: true });
    }
    _prevConfiguredCount = displayConfigured;

    // Complete vs. incomplete summary
    // v1.2.5: class-based visibility. Adds .legion-setup-complete on the
    // card to flip the summary; CSS uses !important so it beats any stale
    // inline display style left over from previous-version webview JS.
    const trulyComplete =
      keys.length > 0 &&
      totalConfigured > 0 &&
      allRequiredDone &&
      (requiredTotal === 0 ? totalConfigured > 0 : requiredConfigured === requiredTotal);

    const wasComplete = card.classList.contains("legion-setup-complete");
    if (trulyComplete) {
      card.classList.add("legion-setup-complete");
      if (details && !wasComplete) {
        // Just became complete — glow + collapse
        card.classList.remove("setup-done-glow");
        void card.offsetWidth;
        card.classList.add("setup-done-glow");
        details.removeAttribute("open");
      }
    } else {
      card.classList.remove("legion-setup-complete");
      if (details) details.setAttribute("open", "");
    }

    // Render rows
    const wizardRow = body.querySelector(".setup-wizard-row");
    // Remove old rows (keep wizard row)
    Array.from(body.children).forEach((ch) => {
      if (!ch.classList.contains("setup-wizard-row")) ch.remove();
    });

    // Insert required keys first, then optional
    const orderedKeys = [...requiredKeys, ...optionalKeys];
    orderedKeys.forEach((k) => {
      const isRequired = k.required === mode;
      const stateClass = k.configured
        ? "setup-configured"
        : isRequired
        ? "setup-required-missing"
        : "setup-optional-missing";

      const badgeText = k.configured
        ? "Configured"
        : isRequired
        ? "Required"
        : "Optional";

      const valueText = k.configured
        ? k.masked || "•••••••••"
        : "Not configured";

      const row = document.createElement("div");
      row.className = `setup-row ${stateClass}`;
      row.setAttribute("data-key", k.key);
      row.setAttribute("title", k.configured ? "Click to reconfigure" : "Click to enter key");
      row.innerHTML = `
        ${ICONS.key}
        <div class="setup-row-info">
          <span class="setup-row-label">${escHtml(k.label)}</span>
          <span class="setup-row-value">${escHtml(valueText)}</span>
        </div>
        <span class="setup-badge">
          ${k.configured ? ICONS.check : k.required === mode ? ICONS.warn : ""}
          ${escHtml(badgeText)}
        </span>
        <button class="setup-paste-btn" data-key="${escHtml(k.key)}" title="Paste from clipboard" type="button">
          ${ICONS.paste}
        </button>`;

      // Row click → enterKey
      row.addEventListener("click", (e) => {
        if (e.target.closest(".setup-paste-btn")) return;
        vscode.postMessage({ command: "enterKey", key: k.key });
      });

      // Paste button
      row.querySelector(".setup-paste-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: "pasteKey", key: k.key });
      });

      if (wizardRow) {
        body.insertBefore(row, wizardRow);
      } else {
        body.appendChild(row);
      }
    });

    // ── v1.2.7 defensive wiring ────────────────────────
    // Re-create the wizard row's button on every render with a fresh inline
    // click handler. This is belt-and-suspenders on top of the COMMANDS-array
    // auto-wiring at script-load time. Reports indicated the auto-wired
    // handler wasn't firing on some installs; this guarantees a working
    // handler exists after every setupState message arrives.
    if (wizardRow) {
      wizardRow.innerHTML = `<button class="setup-wizard-btn" id="setupWizard" type="button">Open Setup Page</button>`;
      const btn = wizardRow.querySelector("#setupWizard");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          // eslint-disable-next-line no-console
          console.log("[Legion] Setup button clicked, posting setupWizard message");
          vscode.postMessage({ command: "setupWizard" });
        });
      }
    }
    // Same defensive treatment for Reconfigure (inside the summary)
    const reconfigBtn = document.getElementById("setupReconfigure");
    if (reconfigBtn && !reconfigBtn.hasAttribute("data-wired")) {
      reconfigBtn.setAttribute("data-wired", "1");
      reconfigBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line no-console
        console.log("[Legion] Reconfigure button clicked, posting setupWizard message");
        const details = document.getElementById("setupDetails");
        if (details) details.setAttribute("open", "");
        vscode.postMessage({ command: "setupWizard" });
      });
    }
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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
