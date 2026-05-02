import * as vscode from "vscode";
import * as path from "path";
import { LegionSidebarProvider } from "./sidebar/sidebarProvider";
import { initialize } from "./commands/initialize";
import { documentRepository } from "./commands/document";
import { updateDocumentation } from "./commands/update";
import { scanDirectory } from "./commands/scanDirectory";
import { lintWiki } from "./commands/lint";
import { openInObsidian } from "./commands/openInObsidian";
import { findEntity } from "./commands/findEntity";
import { runFoldLog } from "./commands/foldLog";
import { autoresearch } from "./commands/autoresearch";
import { saveConversation } from "./commands/saveConversation";
import { archaeologyFile } from "./commands/archaeology";
import { generateOnboardingBrief } from "./commands/onboardingBrief";
import { ingestUrl } from "./commands/ingestUrl";
import { drainAgenda } from "./commands/drainAgenda";
import { drainPostCommitQueue } from "./driver/queue";
import { runDocumentPass } from "./driver/documentPass";
import { EntityHoverProvider } from "./providers/entityHoverProvider";
import { EntityCodeLensProvider } from "./providers/entityCodeLensProvider";
import { ContractValidator, ContractCodeActionProvider } from "./providers/contractValidator";
import { detectRepoState, ensureLocalState } from "./driver/repoState";
import { injectHotContext, readContradictionInbox } from "./driver/reconciler";
import { registerChatParticipant } from "./providers/chatParticipant";
import { WikiTreeProvider } from "./providers/wikiTreeProvider";
import { WikilinkCompletionProvider } from "./providers/wikilinkCompletionProvider";
import { BacklinksProvider } from "./providers/backlinksProvider";
import { resolveContradiction } from "./commands/resolveContradiction";
import { createSharedConfig } from "./commands/createSharedConfig";
import { clearSessionRoot } from "./util/repoRoot";
import { exportWikiCommand } from "./commands/exportWiki";
import { installPrReviewBot } from "./commands/installPrReviewBot";
import { parseCron, isOverdue } from "./driver/cronParser";
import { DashboardPanel } from "./dashboard/dashboardPanel";
import { installGuardian } from "./commands/installGuardian";
import { updateGuardians } from "./commands/updateGuardians";
import { migrateSettingsKeysToSecretStorage, getSetupState, setSecret, SECRET_KEYS, type SecretKey } from "./util/secretStore";
import { setupWizard } from "./commands/setupWizard";
import { SetupPagePanel } from "./commands/setupPage";
import * as fs from "fs/promises";

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  // repoRoot kept for non-command initialization (watchers, providers, startup tasks)
  const repoRoot = folders?.[0]?.uri.fsPath ?? "";

  // ── Sidebar ───────────────────────────────────────────────────────────────────
  const sidebarProvider = new LegionSidebarProvider(context.extensionUri);
  sidebarProvider.setExtensionContext(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("legion.sidebar", sidebarProvider)
  );

  // ── Status bar (multi-root indicator — Feature 005) ───────────────────────────
  let activeRootBar: vscode.StatusBarItem | undefined;
  if (folders && folders.length > 1) {
    activeRootBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    activeRootBar.text = "$(folder) Legion: (pick root)";
    activeRootBar.tooltip = "Click to switch Legion active workspace root";
    activeRootBar.command = "legion.clearActiveRoot";
    activeRootBar.show();
    context.subscriptions.push(activeRootBar);
  }

  // ── Commands ──────────────────────────────────────────────────────────────────
  // These four mutate the wiki on disk. Wrap each so the sidebar re-detects
  // RepoState (initialized flag, page count, last-scan timestamp) afterwards
  // — otherwise the badge stays stuck on the activation snapshot until reload.
  context.subscriptions.push(
    vscode.commands.registerCommand("legion.initialize", async () => {
      await initialize(context);
      await sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("legion.document", async () => {
      await documentRepository(context);
      await sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("legion.update", async () => {
      await updateDocumentation(context);
      await sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("legion.scanDirectory", async () => {
      await scanDirectory(context);
      await sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("legion.lint", () => lintWiki(context)),
    vscode.commands.registerCommand("legion.openInObsidian", () => openInObsidian()),
    // Feature 005: findEntity now resolves root via context
    vscode.commands.registerCommand("legion.findEntity", () => findEntity(context)),
    vscode.commands.registerCommand("legion.internal.coverageUpdate", (coverage) => {
      sidebarProvider.pushCoverage(coverage);
    }),
    vscode.commands.registerCommand("legion.drainQueue", () => {
      if (repoRoot) {
        drainPostCommitQueue(repoRoot, () => runDocumentPass(repoRoot, "update", undefined, context));
      }
    }),
    vscode.commands.registerCommand("legion.viewEntityGraph", async () => {
      if (!repoRoot) return;
      const graphUri = vscode.Uri.file(
        path.join(repoRoot, "library", "knowledge-base", "wiki", "graph.md")
      );
      try {
        await vscode.commands.executeCommand("markdown.showPreview", graphUri);
      } catch {
        const doc = await vscode.workspace.openTextDocument(graphUri);
        await vscode.window.showTextDocument(doc);
      }
    }),
    vscode.commands.registerCommand("legion.foldLog", () => runFoldLog(context)),
    vscode.commands.registerCommand("legion.autoresearch", () => autoresearch(repoRoot, context)),
    vscode.commands.registerCommand("legion.saveConversation", () => saveConversation(repoRoot)),
    vscode.commands.registerCommand("legion.archaeologyFile", () => archaeologyFile(repoRoot, context)),
    vscode.commands.registerCommand("legion.generateOnboardingBrief", () => generateOnboardingBrief(repoRoot, context)),
    vscode.commands.registerCommand("legion.ingestUrl", () => ingestUrl(repoRoot, context)),
    vscode.commands.registerCommand("legion.drainAgenda", () => drainAgenda(repoRoot, context)),
    vscode.commands.registerCommand("legion.resolveContradiction", () => resolveContradiction(repoRoot)),
    // Feature 005: createSharedConfig now receives context
    vscode.commands.registerCommand("legion.createSharedConfig", () => createSharedConfig(repoRoot, context)),
    // Feature 005: clearActiveRoot — resets session selection
    vscode.commands.registerCommand("legion.clearActiveRoot", () => {
      clearSessionRoot(context);
      if (activeRootBar) activeRootBar.text = "$(folder) Legion: (pick root)";
      vscode.window.showInformationMessage("Legion: Active root cleared — next command will show picker.");
    }),
    // Feature 003: Export Wiki
    vscode.commands.registerCommand("legion.exportWiki", () => exportWikiCommand(repoRoot, context)),
    // Feature 006: PR Review Bot
    vscode.commands.registerCommand("legion.installPrReviewBot", () => installPrReviewBot(repoRoot, context)),
    // Feature 010: Analytics Dashboard
    vscode.commands.registerCommand("legion.openDashboard", () => DashboardPanel.open(repoRoot, context)),
    vscode.commands.registerCommand("legion.internal.dashboardRefresh", () => DashboardPanel.refresh()),
    // Feature 009: Community Guardian Ecosystem
    vscode.commands.registerCommand("legion.installGuardian", () => installGuardian(repoRoot, context)),
    vscode.commands.registerCommand("legion.updateGuardians", () => updateGuardians(repoRoot, context)),
    vscode.commands.registerCommand("legion.internal.contradictionCount", async (count: number) => {
      const foldersC = vscode.workspace.workspaceFolders;
      if (foldersC?.[0]) {
        const inbox = await readContradictionInbox(foldersC[0].uri.fsPath);
        sidebarProvider.refreshContradictionBadge(foldersC[0].uri.fsPath);
        void inbox;
      }
      void count;
    }),
    // v1.2.0: Setup Wizard (legacy QuickPick chain, kept available)
    vscode.commands.registerCommand("legion.setupWizardClassic", () => setupWizard(context, sidebarProvider)),
    // v1.2.6: Setup Page — full webview in editor area (default for "Setup Wizard")
    vscode.commands.registerCommand("legion.setupWizard", () => {
      SetupPagePanel.open(context, async () => {
        await sidebarProvider.refreshSetupState(context).catch(() => undefined);
      });
    }),
    // v1.2.9: Brand-new command name + ID for the sidebar button. The
    // sidebar's `setupWizard` button has been silently failing for several
    // releases despite identical wiring to working buttons. Hypothesis: a
    // stale cached webview or a name collision somewhere in Cursor's
    // routing. Using a completely fresh `openSetupPage` name end-to-end —
    // new button ID, new posted command, new VS Code command — eliminates
    // any chance of collision with prior state.
    vscode.commands.registerCommand("legion.openSetupPage", () => {
      SetupPagePanel.open(context, async () => {
        await sidebarProvider.refreshSetupState(context).catch(() => undefined);
      });
    }),
    // v1.2.0: onDidChangeConfiguration — move any API key set via Settings UI
    // into SecretStorage immediately, clearing the plaintext setting.
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      const apiKeySettings: SecretKey[] = [
        "cursorApiKey", "anthropicApiKey", "openRouterApiKey",
        "cohereApiKey", "exaApiKey", "firecrawlApiKey", "context7ApiKey",
      ];
      const cfg = vscode.workspace.getConfiguration("legion");
      for (const key of apiKeySettings) {
        if (!e.affectsConfiguration(`legion.${key}`)) continue;
        const value = cfg.get<string>(key, "").trim();
        if (!value) continue;
        try {
          await setSecret(context, key, value);
          await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
          await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
          // Refresh sidebar so the Setup section updates immediately
          await sidebarProvider.refreshSetupState(context);
        } catch {
          vscode.window.showWarningMessage(
            `Legion: Could not move ${SECRET_KEYS[key].label} to encrypted storage — ` +
              `key retained in settings.json. Try reloading the window.`
          );
        }
      }
    })
  );

  // @legion Chat participant
  registerChatParticipant(context, repoRoot);

  // Wiki browser: tree, wikilink completion, backlinks
  if (repoRoot) {
    const wikiTreeProvider = new WikiTreeProvider(repoRoot);
    const wikilinkProvider = new WikilinkCompletionProvider(repoRoot);
    const backlinksProvider = new BacklinksProvider(repoRoot);

    context.subscriptions.push(
      vscode.window.registerTreeDataProvider("legion.wikiTree", wikiTreeProvider),
      vscode.window.registerTreeDataProvider("legion.backlinks", backlinksProvider),
      vscode.languages.registerCompletionItemProvider(
        { language: "markdown", scheme: "file" },
        wikilinkProvider,
        "["
      ),
      vscode.commands.registerCommand("legion.refreshWikiTree", () => {
        wikiTreeProvider.refresh();
        wikilinkProvider.invalidateCache();
        backlinksProvider.invalidateCache();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        backlinksProvider.setActiveFile(editor?.document.uri.fsPath);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath.includes(path.join("library", "knowledge-base", "wiki"))) {
          wikilinkProvider.invalidateCache();
          backlinksProvider.invalidateCache();
          backlinksProvider.setActiveFile(vscode.window.activeTextEditor?.document.uri.fsPath);
        }
      })
    );

    backlinksProvider.setActiveFile(vscode.window.activeTextEditor?.document.uri.fsPath);
  }

  // Watch hot.md for changes and auto-refresh .cursor/rules/wiki-hot-context.md
  if (repoRoot) {
    const hotPattern = new vscode.RelativePattern(
      repoRoot,
      "library/knowledge-base/wiki/hot.md"
    );
    const hotWatcher = vscode.workspace.createFileSystemWatcher(hotPattern);
    const onHotChanged = () => {
      const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");
      injectHotContext(repoRoot, wikiRoot).catch(() => undefined);
    };
    hotWatcher.onDidChange(onHotChanged);
    hotWatcher.onDidCreate(onHotChanged);
    context.subscriptions.push(hotWatcher);
  }

  // Language providers (hover + code lens + contract validation)
  if (repoRoot) {
    const langs = ["typescript", "javascript", "typescriptreact", "javascriptreact"];
    const hoverProvider = new EntityHoverProvider(repoRoot);
    const codeLensProvider = new EntityCodeLensProvider(repoRoot);
    const contractValidator = new ContractValidator(repoRoot);
    const contractActionProvider = new ContractCodeActionProvider(repoRoot);

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(langs, hoverProvider),
      vscode.languages.registerCodeLensProvider(langs, codeLensProvider),
      vscode.languages.registerCodeActionsProvider(langs, contractActionProvider),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        contractValidator.validateDocument(doc).catch(() => undefined);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        contractValidator.clearDocument(doc);
      }),
      { dispose: () => contractValidator.dispose() }
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("legion.refreshContractDiagnostics", async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await contractValidator.validateDocument(editor.document);
          vscode.window.showInformationMessage("Legion: Contract diagnostics refreshed.");
        }
      })
    );
  }

  // Startup: detect repo state, scaffold, push to sidebar
  if (repoRoot) {
    (async () => {
      // v1.2.0: migrate any plaintext API keys from settings.json to SecretStorage
      await migrateSettingsKeysToSecretStorage(context).catch(() => undefined);

      const state = await detectRepoState(repoRoot);

      if (state.initialized && !state.hasLocalState) {
        await ensureLocalState(repoRoot);
        vscode.window.showInformationMessage(
          "Legion: Wiki detected. Local state scaffolded — ready to Document or Update."
        );
      }

      sidebarProvider.pushRepoState(state);

      // v1.2.0: push initial setup state (key inventory) to sidebar
      await sidebarProvider.refreshSetupState(context).catch(() => undefined);

      if (state.initialized) {
        const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");
        await injectHotContext(repoRoot, wikiRoot).catch(() => undefined);
      }

      await drainPostCommitQueue(repoRoot, () =>
        runDocumentPass(repoRoot, "update", undefined, context)
      ).catch(() => undefined);

      // Feature 004: check research schedule on activate
      await checkResearchSchedule(context, repoRoot).catch(() => undefined);
    })().catch(() => undefined);
  }
}

// ── Feature 004: scheduled research check ─────────────────────────────────────

async function checkResearchSchedule(
  context: vscode.ExtensionContext,
  repoRoot: string
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("legion");
  const enabled = cfg.get<boolean>("researchScheduleEnabled", false);
  const schedExpr = cfg.get<string>("researchSchedule", "").trim();
  if (!enabled || !schedExpr) return;

  let cron: ReturnType<typeof parseCron>;
  try {
    cron = parseCron(schedExpr);
  } catch {
    const ch = vscode.window.createOutputChannel("Legion");
    ch.appendLine(`[Legion] Invalid cron expression: "${schedExpr}" — schedule disabled`);
    return;
  }

  let lastRun: Date | null = null;
  try {
    const raw = await fs.readFile(`${repoRoot}/.legion/config.json`, "utf8");
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const ts = stored["last_agenda_drain"];
    if (typeof ts === "string") lastRun = new Date(ts);
  } catch {
    // config absent = never run
  }

  const now = new Date();
  if (!isOverdue(cron, lastRun, now)) return;

  // Check if there are any unchecked agenda items
  try {
    const agendaPath = path.join(repoRoot, "library", "knowledge-base", "wiki", "research-agenda.md");
    const agendaContent = await fs.readFile(agendaPath, "utf8");
    if (!agendaContent.match(/^- \[ \]/m)) return; // no pending items
  } catch {
    return; // agenda file absent
  }

  const lastLabel = lastRun
    ? `${Math.round((now.getTime() - lastRun.getTime()) / 86_400_000)} day(s) ago`
    : "never";

  const choice = await vscode.window.showInformationMessage(
    `Legion: Research agenda drain is due (last run: ${lastLabel}). Run now?`,
    "Run Now",
    "Snooze 1 day",
    "Disable Schedule"
  );

  if (choice === "Run Now") {
    await vscode.commands.executeCommand("legion.drainAgenda");
  } else if (choice === "Snooze 1 day") {
    await updateLegionConfigField(repoRoot, "last_agenda_drain",
      new Date(Date.now() + 864e5).toISOString());
    vscode.window.showInformationMessage("Legion: Snoozed — next check in ~24 hours.");
  } else if (choice === "Disable Schedule") {
    await cfg.update("researchScheduleEnabled", false, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage("Legion: Research schedule disabled.");
  }

  void context;
}

async function updateLegionConfigField(
  repoRoot: string,
  key: string,
  value: unknown
): Promise<void> {
  const configPath = `${repoRoot}/.legion/config.json`;
  try {
    const raw = await fs.readFile(configPath, "utf8").catch(() => "{}");
    const existing = JSON.parse(raw) as Record<string, unknown>;
    existing[key] = value;
    const tmp = configPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
    await fs.rename(tmp, configPath);
  } catch {
    // non-fatal
  }
}

export function deactivate(): void {
  // No-op; nothing to clean up explicitly.
}
