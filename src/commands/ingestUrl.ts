import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { scrapeUrl } from "../driver/searchProviders";
import { runResearchPass } from "../driver/researchPass";
import { type LlmConfig } from "../driver/llmClient";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");

/**
 * Ingest a URL into the wiki.
 *
 * Uses Firecrawl to scrape the URL as clean markdown, then passes the content
 * through a single research round to extract concepts/entities and file a
 * structured wiki source page.
 *
 * Requires `legion.firecrawlApiKey` to be set.
 */
export async function ingestUrl(
  repoRoot: string,
  _context: vscode.ExtensionContext
): Promise<void> {
  if (!repoRoot) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("legion");
  const firecrawlKey = cfg.get<string>("firecrawlApiKey") || process.env.LEGION_FIRECRAWL_API_KEY || "";

  if (!firecrawlKey) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: Ingest URL requires Firecrawl. Set legion.firecrawlApiKey to get started.",
      "Open Settings",
      "Get API Key"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.firecrawlApiKey");
    } else if (choice === "Get API Key") {
      await vscode.env.openExternal(vscode.Uri.parse("https://firecrawl.dev"));
    }
    return;
  }

  const url = await vscode.window.showInputBox({
    prompt: "URL to ingest into the wiki",
    placeHolder: "https://example.com/article-or-docs",
    validateInput: (v) => {
      try { new URL(v); return undefined; } catch { return "Enter a valid URL"; }
    },
  });
  if (!url) return;

  const llmConfig = buildLlmConfig(cfg);
  if (cfg.get<string>("apiProvider", "anthropic") === "anthropic" && !llmConfig.anthropicApiKey) {
    const choice = await vscode.window.showWarningMessage(
      "Legion: Set legion.anthropicApiKey to synthesize the ingested content.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "legion.anthropicApiKey");
    }
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Ingesting ${url}…`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Scraping page content…", increment: 30 });

      let scraped;
      try {
        scraped = await scrapeUrl(url, firecrawlKey);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: Firecrawl scrape failed — ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }

      if (!scraped) {
        vscode.window.showErrorMessage("Legion: Firecrawl returned no content for this URL.");
        return;
      }

      progress.report({ message: "Synthesizing wiki pages…", increment: 30 });

      // Run a single-round research pass with the scraped content pre-loaded
      try {
        const result = await runResearchPass(
          repoRoot,
          scraped.title || url,
          llmConfig,
          1, // single round — we already have the content
          {
            provider: "firecrawl",
            firecrawlApiKey: firecrawlKey,
            maxResults: 1,
          },
          (msg) => progress.report({ message: msg })
        );

        // The source page URL may not be the scraped URL — update it
        const wikiRoot = path.join(repoRoot, WIKI_REL);
        await patchSourceUrl(wikiRoot, result.pagesWritten[0], url);

        progress.report({ message: "Done!", increment: 20 });
        vscode.window.showInformationMessage(
          `Legion: Ingested ${result.pagesWritten.length} page(s) from ${url}`
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: Synthesis failed — ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Ensure the source page has the correct URL in its Sources section. */
async function patchSourceUrl(
  wikiRoot: string,
  relPagePath: string | undefined,
  url: string
): Promise<void> {
  if (!relPagePath) return;
  const absPath = path.join(wikiRoot, relPagePath.replace(/\//g, path.sep));
  try {
    let content = await fs.readFile(absPath, "utf8");
    if (!content.includes(url)) {
      const sourcesHeading = "## Sources";
      if (content.includes(sourcesHeading)) {
        content = content.replace(sourcesHeading, `${sourcesHeading}\n\n1. [Original source](${url})`);
      } else {
        content = content.trimEnd() + `\n\n## Sources\n\n1. [Original source](${url})\n`;
      }
      await fs.writeFile(absPath, content);
    }
  } catch {}
}

function buildLlmConfig(cfg: vscode.WorkspaceConfiguration): LlmConfig {
  const provider = cfg.get<"anthropic" | "openrouter">("apiProvider", "anthropic");
  return {
    provider,
    anthropicApiKey: cfg.get<string>("anthropicApiKey") || process.env.LEGION_ANTHROPIC_API_KEY || "",
    openRouterApiKey: cfg.get<string>("openRouterApiKey") || process.env.LEGION_OPENROUTER_API_KEY || "",
    model: provider === "openrouter"
      ? (cfg.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
      : (cfg.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 4096,
  };
}
