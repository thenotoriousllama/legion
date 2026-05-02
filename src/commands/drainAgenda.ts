import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { loadAgenda, markDone, ensureAgendaFile } from "../driver/researchAgenda";
import { runResearchPass } from "../driver/researchPass";
import { type LlmConfig } from "../driver/llmClient";
import type { SearchProviderConfig, SearchProvider } from "../driver/searchProviders";
import { resolveRepoRoot } from "../util/repoRoot";
import { getSecret } from "../util/secretStore";

/**
 * Process all unchecked items in `wiki/research-agenda.md` using Autoresearch.
 * Marks each item done as it completes, then records `last_agenda_drain` timestamp.
 */
export async function drainAgenda(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const cfg = vscode.workspace.getConfiguration("legion");
  const apiProvider = cfg.get<string>("apiProvider", "anthropic");
  const anthropicKey = await getSecret(context, "anthropicApiKey");
  const openRouterKey = await getSecret(context, "openRouterApiKey");

  if (apiProvider === "anthropic" && !anthropicKey) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: No Anthropic API key configured. Set one to run Research Agenda.",
      "Enter API Key",
      "Open Settings"
    );
    if (choice === "Enter API Key") {
      await vscode.commands.executeCommand("legion.setupWizard");
    } else if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@id:legion.anthropicApiKey");
    }
    return;
  }

  await ensureAgendaFile(repoRoot);

  const items = await loadAgenda(repoRoot);
  if (items.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "Legion: Research agenda is empty. Open wiki/research-agenda.md to add topics.",
      "Open Agenda"
    );
    if (choice === "Open Agenda") {
      const agendaPath = path.join(
        repoRoot, "library", "knowledge-base", "wiki", "research-agenda.md"
      );
      const doc = await vscode.workspace.openTextDocument(agendaPath);
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  const llmConfig: LlmConfig = {
    provider: apiProvider as "anthropic" | "openrouter",
    anthropicApiKey: anthropicKey,
    openRouterApiKey: openRouterKey,
    model: apiProvider === "openrouter"
      ? (cfg.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
      : (cfg.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 4096,
  };

  const searchConfig: SearchProviderConfig = {
    provider: cfg.get<SearchProvider>("researchProvider", "model-only"),
    exaApiKey: cfg.get<string>("exaApiKey") || process.env.LEGION_EXA_API_KEY || "",
    firecrawlApiKey: cfg.get<string>("firecrawlApiKey") || process.env.LEGION_FIRECRAWL_API_KEY || "",
    context7ApiKey: cfg.get<string>("context7ApiKey") || process.env.LEGION_CONTEXT7_API_KEY || "",
    maxResults: cfg.get<number>("researchMaxResults", 5),
  };

  const maxRounds = cfg.get<number>("researchRounds", 3);
  const maxParallel = cfg.get<number>("maxParallelAgents", 3);

  let drainSucceeded = false;
  let completedCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Draining research agenda (${items.length} items)`,
      cancellable: false,
    },
    async (progress) => {
      let completed = 0;
      let failed = 0;
      const errors: string[] = [];

      let cursor = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const idx = cursor++;
          if (idx >= items.length) return;
          const item = items[idx];

          progress.report({
            message: `[${idx + 1}/${items.length}] "${item.topic}"…`,
            increment: Math.floor(90 / items.length),
          });

          try {
            await runResearchPass(
              repoRoot,
              item.topic,
              llmConfig,
              maxRounds,
              searchConfig,
              () => undefined
            );
            await markDone(repoRoot, item.lineIdx);
            completed++;
          } catch (e) {
            failed++;
            errors.push(`"${item.topic}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      const workers = Array.from(
        { length: Math.min(maxParallel, items.length) },
        worker
      );
      await Promise.all(workers);

      progress.report({ message: "Done!", increment: 10 });

      completedCount = completed;
      drainSucceeded = failed === 0 || completed > 0;

      const summary = `Legion: Agenda drained — ${completed} researched, ${failed} failed.`;
      if (errors.length > 0) {
        vscode.window.showWarningMessage(summary, "Show errors").then((choice) => {
          if (choice === "Show errors") {
            const ch = vscode.window.createOutputChannel("Legion");
            errors.forEach((e) => ch.appendLine(e));
            ch.show();
          }
        });
      } else {
        vscode.window.showInformationMessage(summary);
      }
    }
  );

  // Feature 004: update last_agenda_drain timestamp on success
  if (drainSucceeded && completedCount > 0) {
    await updateLastDrainTimestamp(repoRoot);

    // Auto-commit if configured (Feature 004)
    const autoCommit = cfg.get<boolean>("autoGitCommit", false);
    if (autoCommit) {
      await runAutoGitCommit(repoRoot);
    }
  }
}

async function updateLastDrainTimestamp(repoRoot: string): Promise<void> {
  const configPath = path.join(repoRoot, ".legion", "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8").catch(() => "{}");
    const existing = JSON.parse(raw) as Record<string, unknown>;
    existing["last_agenda_drain"] = new Date().toISOString();
    const tmp = configPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
    await fs.rename(tmp, configPath);
  } catch {
    // Non-fatal: log but don't block the drain result
    const ch = vscode.window.createOutputChannel("Legion");
    ch.appendLine("[Legion] Warning: could not update last_agenda_drain in .legion/config.json");
  }
}

async function runAutoGitCommit(repoRoot: string): Promise<void> {
  const { execSync } = await import("child_process");
  try {
    execSync("git add library/knowledge-base/wiki/", { cwd: repoRoot });
    execSync('git commit -m "legion: scheduled agenda drain [skip ci]"', { cwd: repoRoot });
  } catch {
    // Non-fatal
  }
}
