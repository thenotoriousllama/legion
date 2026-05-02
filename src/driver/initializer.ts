import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { loadSharedConfig } from "./sharedConfig";
import { CommunityGuardianManager } from "../guardians/communityGuardianManager";
import { WIZARD_COMPLETED_FLAG } from "../commands/setupWizard";
import { getSecret, type SecretKey } from "../util/secretStore";

const STRUCTURE = [
  ".legion",
  ".legion/queue",
  ".legion/git-cache",
  ".legion/chunks",
  "library",
  "library/notes",
  "library/knowledge-base",
  "library/knowledge-base/wiki",
  "library/knowledge-base/wiki/entities",
  "library/knowledge-base/wiki/concepts",
  "library/knowledge-base/wiki/decisions",
  "library/knowledge-base/wiki/comparisons",
  "library/knowledge-base/wiki/questions",
  "library/knowledge-base/wiki/meta",
  "library/qa",
  "library/requirements",
  "library/requirements/issues",
  "library/requirements/issues/completed",
  "library/requirements/features",
  "library/requirements/features/completed",
  ".cursor",
  ".cursor/agents",
  ".cursor/skills",
];

export interface GuardianOption extends vscode.QuickPickItem {
  agentName: string;
  weaponName: string;
}

/** Guardians pre-selected when the picker opens. */
const DEFAULT_SELECTED = new Set(["wiki-guardian", "library-guardian"]);

/**
 * Dynamically discover guardians from the `bundled/agents/` folder that was
 * populated by `npm run snapshot`. Each `<name>-guardian.md` agent file is
 * included unless its frontmatter `description:` starts with "RETIRED".
 * The matching weapon is derived as `<name>-weapon` and its existence in
 * `bundled/skills/` is checked (missing weapons produce a warning at copy time,
 * not here). Returns an empty array if the snapshot hasn't been run yet.
 */
export async function discoverGuardians(context: vscode.ExtensionContext): Promise<GuardianOption[]> {
  const bundledAgentsDir = path.join(context.extensionPath, "bundled", "agents");

  let entries: string[];
  try {
    entries = await fs.readdir(bundledAgentsDir);
  } catch {
    return []; // bundled/ not populated — snapshot hasn't been run
  }

  const guardians: GuardianOption[] = [];

  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue;
    const agentName = filename.replace(/\.md$/, "");
    const weaponName = agentName.replace(/-guardian$/, "-weapon");

    // Read description from YAML frontmatter.
    let detail = agentName;
    try {
      const content = await fs.readFile(path.join(bundledAgentsDir, filename), "utf8");
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        const raw = descMatch[1].trim();
        // Skip agents whose description explicitly marks them retired.
        if (raw.startsWith("RETIRED")) continue;
        // Truncate long descriptions for the QuickPick detail line.
        detail = raw.length > 100 ? raw.slice(0, 100) + "…" : raw;
      }
    } catch {
      // Unreadable file — include with name as fallback detail.
    }

    guardians.push({
      label: agentName,
      detail,
      agentName,
      weaponName,
      picked: DEFAULT_SELECTED.has(agentName),
    });
  }

  // wiki-guardian and library-guardian float to the top; rest alphabetically.
  guardians.sort((a, b) => {
    const rank = (g: GuardianOption) =>
      g.agentName === "wiki-guardian" ? 0 : g.agentName === "library-guardian" ? 1 : 2;
    const dr = rank(a) - rank(b);
    return dr !== 0 ? dr : a.agentName.localeCompare(b.agentName);
  });

  return guardians;
}

/**
 * Feature 009: Extend guardian discovery to include installed community guardians.
 * Merges bundled + community guardian lists.
 */
export async function discoverAllGuardians(
  context: vscode.ExtensionContext,
  legionSharedRoot: string
): Promise<GuardianOption[]> {
  const bundled = await discoverGuardians(context);

  const manager = new CommunityGuardianManager(context, legionSharedRoot);
  const community = await manager.listInstalled();

  const communityOptions: GuardianOption[] = community.map((g) => ({
    label: `${g.manifest.displayName} (community)`,
    detail: g.manifest.description,
    agentName: g.manifest.name,
    weaponName: "",
    picked: false,
  }));

  return [...bundled, ...communityOptions];
}

export async function runInitializer(
  repoRoot: string,
  context: vscode.ExtensionContext
): Promise<void> {
  // 1. Discover bundled guardians and let the user pick.
  const available = await discoverGuardians(context);
  if (available.length === 0) {
    vscode.window.showWarningMessage(
      "Legion: No bundled guardians found. Run `npm run snapshot` in the extension repo first, then recompile."
    );
    return;
  }

  // Apply shared team defaults if a .legion-shared/config.json exists
  const sharedCfg = await loadSharedConfig(repoRoot);
  if (sharedCfg?.guardians_default && sharedCfg.guardians_default.length > 0) {
    const sharedSet = new Set(sharedCfg.guardians_default);
    for (const g of available) {
      g.picked = sharedSet.has(g.agentName);
    }
  }

  const guardians = await vscode.window.showQuickPick(available, {
    canPickMany: true,
    placeHolder: `Select guardians to bundle in this repo (Space to toggle, Enter to confirm)${sharedCfg?.guardians_default ? " — defaults from .legion-shared/" : ""}`,
  });
  if (!guardians) {
    vscode.window.showInformationMessage("Legion: Initialize cancelled.");
    return;
  }

  let createdCount = 0;
  let skippedCount = 0;
  const warnings: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Legion: Initializing repository",
      cancellable: false,
    },
    async (progress) => {
      // 2. Directory structure (idempotent — fs.mkdir with recursive doesn't fail if exists)
      progress.report({ message: "Creating directory structure…", increment: 10 });
      for (const dir of STRUCTURE) {
        await fs.mkdir(path.join(repoRoot, dir), { recursive: true });
      }

      // 3. .legionignore (preserve existing)
      progress.report({ message: "Writing .legionignore…", increment: 10 });
      const ignorePath = path.join(repoRoot, ".legionignore");
      if (await exists(ignorePath)) {
        skippedCount++;
      } else {
        await copyTemplate(context, "legionignore.template", ignorePath);
        createdCount++;
      }

      // 4. .legion/config.json
      progress.report({ message: "Writing .legion/config.json…", increment: 10 });
      const configPath = path.join(repoRoot, ".legion", "config.json");
      if (await exists(configPath)) {
        skippedCount++;
      } else {
        await copyTemplate(context, "legion-config.template.json", configPath);
        // Patch in selected guardians
        const config = JSON.parse(await fs.readFile(configPath, "utf8"));
        config.guardians_installed = guardians.map((g) => g.agentName);
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        createdCount++;
      }

      // 5. .legion/file-hashes.json (empty manifest)
      const hashesPath = path.join(repoRoot, ".legion", "file-hashes.json");
      if (await exists(hashesPath)) {
        skippedCount++;
      } else {
        await fs.writeFile(
          hashesPath,
          JSON.stringify({ files: {}, last_scan: null }, null, 2)
        );
        createdCount++;
      }

      // 5b. .legion/address-counter.txt (stable page address counter)
      const counterPath = path.join(repoRoot, ".legion", "address-counter.txt");
      if (await exists(counterPath)) {
        skippedCount++;
      } else {
        await fs.writeFile(counterPath, "1");
        createdCount++;
      }

      // 6. Wiki state files (idempotent — preserve existing)
      progress.report({ message: "Seeding wiki state files…", increment: 20 });
      const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");
      const stateFiles: Array<[string, string]> = [
        ["wiki-index.template.md", "index.md"],
        ["wiki-hot.template.md", "hot.md"],
        ["wiki-log.template.md", "log.md"],
        ["wiki-overview.template.md", "overview.md"],
      ];
      for (const [tpl, dst] of stateFiles) {
        const dstPath = path.join(wikiRoot, dst);
        if (await exists(dstPath)) {
          skippedCount++;
        } else {
          await copyTemplate(context, tpl, dstPath);
          createdCount++;
        }
      }

      // 7. Copy bundled agents + weapons for selected guardians
      progress.report({ message: "Copying bundled guardians…", increment: 50 });

      // Feature 007 Layer 2: Copy .claude-plugin/ template (wiki-guardian only)
      const selectedNames = guardians.map((g) => g.agentName);
      if (selectedNames.includes("wiki-guardian")) {
        await copyClaudePluginTemplate(context, repoRoot);
      }

      const bundledRoot = path.join(context.extensionPath, "bundled");

      // v1.2.11: Always install the `god` skill — it's the meta-orchestration
      // protocol that routes user requests to the correct guardian. Not paired
      // with any single guardian, so it falls outside the per-guardian loop
      // below. Without this, `god` was silently never copied to .cursor/skills/
      // even when the user selected guardians that depend on it for routing.
      const godSrc = path.join(bundledRoot, "skills", "god");
      const godDst = path.join(repoRoot, ".cursor", "skills", "god");
      if (await exists(godDst)) {
        skippedCount++;
      } else if (!(await exists(godSrc))) {
        warnings.push(
          `Bundled skill missing: god/ (run \`npm run snapshot\` in the extension repo before packaging)`
        );
      } else {
        await copyDir(godSrc, godDst);
        createdCount++;
      }

      for (const g of guardians) {
        // Agent file
        const agentSrc = path.join(bundledRoot, "agents", `${g.agentName}.md`);
        const agentDst = path.join(repoRoot, ".cursor", "agents", `${g.agentName}.md`);
        if (await exists(agentDst)) {
          skippedCount++;
        } else if (!(await exists(agentSrc))) {
          warnings.push(`Bundled agent missing: ${g.agentName}.md (run \`npm run snapshot\` in the extension repo before packaging)`);
        } else {
          await fs.copyFile(agentSrc, agentDst);
          createdCount++;
        }

        // Weapon folder
        const weaponSrc = path.join(bundledRoot, "skills", g.weaponName);
        const weaponDst = path.join(repoRoot, ".cursor", "skills", g.weaponName);
        if (await exists(weaponDst)) {
          skippedCount++;
        } else if (!(await exists(weaponSrc))) {
          warnings.push(`Bundled weapon missing: ${g.weaponName}/ (run \`npm run snapshot\`)`);
        } else {
          await copyDir(weaponSrc, weaponDst);
          createdCount++;
        }
      }
    }
  );

  // 9. Auto-fire Setup Wizard on first init if no key is configured for
  //    the current mode. Non-blocking — fires after the progress notification.
  //    We actually check SecretStorage (+ env fallback) so users who already
  //    have CURSOR_API_KEY or LEGION_ANTHROPIC_API_KEY set are not interrupted.
  const wizardDone = context.globalState.get<boolean>(WIZARD_COMPLETED_FLAG);
  if (!wizardDone) {
    const cfg = vscode.workspace.getConfiguration("legion");
    const agentMode = cfg.get<string>("agentInvocationMode", "direct-anthropic-api");
    const apiProvider = cfg.get<string>("apiProvider", "anthropic");
    // Resolve the actual key the user needs based on BOTH settings, not just
    // agentInvocationMode. (Pre-v1.2.13 we only checked anthropicApiKey for
    // direct-anthropic-api mode, which auto-fired the wizard for OpenRouter
    // users who already had their openRouterApiKey set.)
    let requiredKey: SecretKey | null = null;
    if (agentMode === "cursor-sdk") {
      requiredKey = "cursorApiKey";
    } else if (agentMode === "direct-anthropic-api") {
      requiredKey = apiProvider === "openrouter" ? "openRouterApiKey" : "anthropicApiKey";
    }
    if (requiredKey) {
      getSecret(context, requiredKey).then((val) => {
        if (!val) {
          setTimeout(() => {
            vscode.commands.executeCommand("legion.setupWizard");
          }, 1500);
        } else {
          context.globalState.update(WIZARD_COMPLETED_FLAG, true);
        }
      }).catch(() => undefined);
    }
  }

  // 9. Report
  const mcpNote = buildMcpSetupNote(repoRoot);
  const summaryText = `Legion: Initialized. ${createdCount} created, ${skippedCount} skipped (already existed).`;
  const fullSummary = mcpNote ? `${summaryText}\n\n${mcpNote}` : summaryText;

  if (warnings.length > 0) {
    vscode.window.showWarningMessage(`${summaryText} ${warnings.length} warning(s).`, "Show details").then((choice) => {
      if (choice === "Show details") {
        const channel = vscode.window.createOutputChannel("Legion");
        channel.appendLine(fullSummary);
        warnings.forEach((w) => channel.appendLine(`  ⚠ ${w}`));
        channel.show();
      }
    });
  } else {
    const choice = await vscode.window.showInformationMessage(summaryText, "Show setup notes");
    if (choice === "Show setup notes" && mcpNote) {
      const channel = vscode.window.createOutputChannel("Legion");
      channel.appendLine(fullSummary);
      channel.show();
    }
  }
}

// ── Feature 007: Claude Code integration helpers ───────────────────────────────

/**
 * Copy the `.claude-plugin/` template into the target repo (no-clobber).
 * Template source: `templates/claude-plugin/` in the extension directory.
 */
async function copyClaudePluginTemplate(
  context: vscode.ExtensionContext,
  repoRoot: string
): Promise<void> {
  const src = path.join(context.extensionPath, "templates", "claude-plugin");
  const dest = path.join(repoRoot, ".claude-plugin");

  if (await exists(dest)) return; // already installed — no-clobber

  try {
    await copyDir(src, dest);
  } catch {
    // Template may not exist if not yet compiled — skip silently
  }
}

/**
 * Returns a Claude Code MCP setup note string when the MCP server is compiled.
 * Included in the Initialize summary when wiki-guardian is selected.
 */
function buildMcpSetupNote(repoRoot: string): string {
  const mcpServerPath = path.join(repoRoot, "dist", "mcp-server.js");
  // Synchronous check via require — if the file doesn't exist we get an empty note
  const { existsSync } = require("fs") as typeof import("fs");
  if (!existsSync(mcpServerPath)) return "";

  const serverJson = JSON.stringify({
    type: "stdio",
    command: "node",
    args: [mcpServerPath],
    env: { LEGION_REPO_ROOT: repoRoot },
  });

  return `Claude Code MCP Setup (optional — requires dist/mcp-server.js):
  claude mcp add-json legion '${serverJson}'
After registration, run "claude mcp list" to confirm.`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplate(context: vscode.ExtensionContext, tplName: string, dst: string): Promise<void> {
  const src = path.join(context.extensionPath, "templates", tplName);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (await exists(dstPath)) continue; // no-clobber
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}
