import * as vscode from "vscode";
import { runResearchPass } from "../driver/researchPass";
import { scoreBoundary } from "../driver/boundaryScorer";
import type { SearchProviderConfig, SearchProvider } from "../driver/searchProviders";
import type { LlmConfig } from "../driver/llmClient";

export async function autoresearch(
  repoRoot: string,
  _context: vscode.ExtensionContext
): Promise<void> {
  if (!repoRoot) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("legion");
  const provider = cfg.get<"anthropic" | "openrouter">("apiProvider", "anthropic");

  // Build LLM config
  const llmConfig: LlmConfig = {
    provider,
    anthropicApiKey: cfg.get<string>("anthropicApiKey") || process.env.LEGION_ANTHROPIC_API_KEY || "",
    openRouterApiKey: cfg.get<string>("openRouterApiKey") || process.env.LEGION_OPENROUTER_API_KEY || "",
    model:
      provider === "openrouter"
        ? (cfg.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
        : (cfg.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 4096,
  };

  // Validate API key availability
  if (provider === "anthropic" && !llmConfig.anthropicApiKey) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: Set legion.anthropicApiKey (or LEGION_ANTHROPIC_API_KEY env var) to use Autoresearch.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.anthropicApiKey");
    }
    return;
  }
  if (provider === "openrouter" && !llmConfig.openRouterApiKey) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: Set legion.openRouterApiKey (or LEGION_OPENROUTER_API_KEY env var) to use Autoresearch with OpenRouter.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.openRouterApiKey");
    }
    return;
  }

  const maxRounds = cfg.get<number>("researchRounds", 3);

  // Build search provider config
  const searchConfig: SearchProviderConfig = {
    provider: cfg.get<SearchProvider>("researchProvider", "model-only"),
    exaApiKey: cfg.get<string>("exaApiKey") || process.env.LEGION_EXA_API_KEY || "",
    firecrawlApiKey: cfg.get<string>("firecrawlApiKey") || process.env.LEGION_FIRECRAWL_API_KEY || "",
    context7ApiKey: cfg.get<string>("context7ApiKey") || process.env.LEGION_CONTEXT7_API_KEY || "",
    maxResults: cfg.get<number>("researchMaxResults", 5),
  };

  // Warn if provider needs a key that's missing
  if (searchConfig.provider === "exa" && !searchConfig.exaApiKey) {
    const fix = await vscode.window.showWarningMessage(
      "Legion: Exa provider selected but legion.exaApiKey is not set.",
      "Open Settings"
    );
    if (fix === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.exaApiKey");
    }
    return;
  }
  if (searchConfig.provider === "firecrawl" && !searchConfig.firecrawlApiKey) {
    const fix = await vscode.window.showWarningMessage(
      "Legion: Firecrawl provider selected but legion.firecrawlApiKey is not set.",
      "Open Settings"
    );
    if (fix === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.firecrawlApiKey");
    }
    return;
  }

  // ── Topic selection: boundary-first or manual ─────────────────────────────
  let topic = "";

  // Try boundary scorer for suggestions
  const suggestions = await scoreBoundary(repoRoot, 5).catch(() => []);

  if (suggestions.length > 0) {
    const items: vscode.QuickPickItem[] = [
      ...suggestions.map((s) => ({
        label: `$(type-hierarchy) ${s.name}`,
        description: `${s.module} · score: ${s.score.toFixed(2)}`,
        detail: "Frontier entity — high boundary score suggests research value",
      })),
      { label: "$(edit) Enter topic manually…", description: "", detail: "" },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose a suggested frontier topic or enter manually",
      matchOnDescription: true,
    });
    if (!picked) return;

    if (picked.label.startsWith("$(edit)")) {
      const manual = await vscode.window.showInputBox({
        placeHolder: "e.g. React Server Components, PostgreSQL indexing strategies",
        prompt: "Research topic",
      });
      if (!manual) return;
      topic = manual;
    } else {
      // Strip the codicon prefix
      topic = picked.label.replace(/^\$\(\S+\)\s*/, "");
    }
  } else {
    const manual = await vscode.window.showInputBox({
      placeHolder: "e.g. React Server Components, PostgreSQL indexing strategies",
      prompt: "Research topic (Legion will run a 3-round synthesis loop)",
    });
    if (!manual) return;
    topic = manual;
  }

  // ── Run research pass ─────────────────────────────────────────────────────
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Researching "${topic}"`,
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await runResearchPass(
          repoRoot,
          topic,
          llmConfig,
          maxRounds,
          searchConfig,
          (msg) => progress.report({ message: msg })
        );

        const providerNote = result.provider !== "model-only"
          ? ` (via ${result.provider})`
          : " (model knowledge)";
        vscode.window.showInformationMessage(
          `Legion: Research complete — ${result.pagesWritten.length} pages filed in ${result.rounds} round(s)${providerNote}.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: Research failed — ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
}
