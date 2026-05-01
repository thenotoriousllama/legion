import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import {
  saveSharedConfig,
  loadSharedConfig,
  ensureSharedDir,
  type SharedConfig,
} from "../driver/sharedConfig";
import { resolveRepoRoot } from "../util/repoRoot";

/**
 * Interactive wizard to create or update `.legion-shared/config.json`.
 * Guides the user through guardian selection, model choice, ignore patterns,
 * Cohere API key (optional — enables semantic search), and monorepo scan roots.
 */
export async function createSharedConfig(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const existing = await loadSharedConfig(repoRoot);

  // ── Step 1: Guardian defaults ───────────────────────────────────────────────
  const KNOWN_GUARDIANS = [
    "wiki-guardian", "library-guardian", "mind-guardian", "auth-guardian",
    "db-guardian", "devops-guardian", "payments-guardian", "asset-guardian",
    "quality-guardian", "security-guardian", "react-guardian", "ux-ui-guardian",
    "design-system-guardian", "seo-aeo-guardian",
  ];

  let guardianDefaults: string[] = existing?.guardians_default ?? ["wiki-guardian", "library-guardian"];

  const guardianPick = await vscode.window.showQuickPick(
    KNOWN_GUARDIANS.map((name) => ({
      label: name,
      picked: guardianDefaults.includes(name),
    })),
    {
      canPickMany: true,
      placeHolder: "Select default guardians for this team (pre-selected on Initialize)",
    }
  );
  if (!guardianPick) return;
  guardianDefaults = guardianPick.map((g) => g.label);

  // ── Step 2: Model ───────────────────────────────────────────────────────────
  const cfg = vscode.workspace.getConfiguration("legion");
  const currentModel = existing?.model ?? cfg.get<string>("model", "claude-sonnet-4-5");
  const modelInput = await vscode.window.showInputBox({
    prompt: "Default model for this team (Anthropic or OpenRouter model ID)",
    value: currentModel,
    placeHolder: "claude-sonnet-4-5 or anthropic/claude-sonnet-4-5",
  });
  if (modelInput === undefined) return;

  // ── Step 3: Max parallel agents ─────────────────────────────────────────────
  const parallelOptions = [1, 2, 3, 4, 5, 6, 8].map((n) => ({
    label: `${n} agent${n !== 1 ? "s" : ""}`,
    description: n === 3 ? "(recommended)" : "",
    value: n,
    picked: (existing?.max_parallel_agents ?? 3) === n,
  }));
  const parallelPick = await vscode.window.showQuickPick(parallelOptions, {
    placeHolder: "Max parallel agents for Document/Update passes",
  });
  if (!parallelPick) return;

  // ── Step 4: Fold schedule ───────────────────────────────────────────────────
  const foldPick = await vscode.window.showQuickPick(
    [
      { label: "Weekly", description: "Fold log once a week", value: "weekly" as const, picked: (existing?.fold_schedule ?? "weekly") === "weekly" },
      { label: "Daily", description: "Fold log daily", value: "daily" as const, picked: existing?.fold_schedule === "daily" },
      { label: "Manual", description: "Only fold when explicitly run", value: "manual" as const, picked: existing?.fold_schedule === "manual" },
    ],
    { placeHolder: "Log fold schedule" }
  );
  if (!foldPick) return;

  // ── Step 5: Additional ignore extensions ───────────────────────────────────
  const ignoreInput = await vscode.window.showInputBox({
    prompt: "Additional file extensions to ignore (comma-separated, or leave blank)",
    value: (existing?.ignore_extensions ?? []).join(", "),
    placeHolder: ".min.js, .bundle.js, .generated.ts",
  });
  if (ignoreInput === undefined) return;
  const ignoreExtensions = ignoreInput
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("."));

  // ── Step 6: Cohere API key (Feature 001 — semantic search) ─────────────────
  const existingCohereKey = cfg.get<string>("cohereApiKey", "") || process.env.LEGION_COHERE_API_KEY || "";
  const cohereInput = await vscode.window.showInputBox({
    prompt: "Cohere API key (optional — enables semantic search for Find Entity). Leave blank for TF-IDF fallback.",
    value: existingCohereKey,
    placeHolder: "Leave blank to use offline TF-IDF search",
    password: true,
    ignoreFocusOut: true,
  });
  if (cohereInput === undefined) return; // user pressed Escape

  if (cohereInput.trim()) {
    await cfg.update("cohereApiKey", cohereInput.trim(), vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(
      "Legion: Cohere API key saved. Tip: prefer LEGION_COHERE_API_KEY env var to avoid committing keys."
    );
  }

  // ── Step 7: Monorepo scan roots (Feature 005) ───────────────────────────────
  const currentScanRoots = cfg.get<string[]>("scanRoots", []).join(", ");
  const scanRootsInput = await vscode.window.showInputBox({
    prompt: "Monorepo sub-paths to scan separately (comma-separated, or leave blank for single-root mode)",
    value: currentScanRoots,
    placeHolder: "packages/api, packages/web, packages/shared",
  });
  if (scanRootsInput === undefined) return;

  const scanRoots = scanRootsInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (scanRoots.length > 0) {
    await cfg.update("scanRoots", scanRoots, vscode.ConfigurationTarget.Workspace);
  }

  // ── Write config ─────────────────────────────────────────────────────────────
  await ensureSharedDir(repoRoot);

  const config: SharedConfig = {
    version: 1,
    guardians_default: guardianDefaults,
    model: modelInput || currentModel,
    max_parallel_agents: parallelPick.value,
    fold_schedule: foldPick.value,
    ...(ignoreExtensions.length > 0 ? { ignore_extensions: ignoreExtensions } : {}),
    ...(existing?.research_agenda_shared ? { research_agenda_shared: existing.research_agenda_shared } : {}),
    ...(existing?.api_provider ? { api_provider: existing.api_provider } : {}),
  };

  await saveSharedConfig(repoRoot, config);

  const sharedIgnorePath = path.join(repoRoot, ".legion-shared", "legionignore");
  try {
    await fs.access(sharedIgnorePath);
  } catch {
    const ignoreLines = [
      "# Team-wide ignore patterns — extends .legionignore",
      "# Add patterns here to skip files for all team members",
      "",
      ...(ignoreExtensions.length > 0 ? ignoreExtensions.map((ext) => `**/*${ext}`) : ["# **/*.example"]),
      "",
    ];
    await fs.writeFile(sharedIgnorePath, ignoreLines.join("\n"));
  }

  const choice = await vscode.window.showInformationMessage(
    `Legion: Shared config written to .legion-shared/. Commit this directory to share with your team.`,
    "Open config",
    "Show in Explorer"
  );
  if (choice === "Open config") {
    const configPath = path.join(repoRoot, ".legion-shared", "config.json");
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
  } else if (choice === "Show in Explorer") {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(path.join(repoRoot, ".legion-shared"))
    );
  }
}
