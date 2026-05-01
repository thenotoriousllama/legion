import * as fs from "fs/promises";
import * as path from "path";

/**
 * Legion configuration resolved without any VS Code APIs.
 * Used by the MCP server process (plain Node.js, no extension host).
 *
 * Resolution order:
 * 1. Environment variables
 * 2. `.legion/config.json` in the resolved repoRoot
 * 3. Hardcoded defaults
 */

export interface LegionMcpConfig {
  anthropicApiKey: string;
  cohereApiKey: string;
  model: string;
  maxParallelAgents: number;
  apiProvider: "anthropic" | "openrouter";
  openRouterApiKey: string;
  openRouterModel: string;
  wikiRoot: string;       // absolute path; "" = default
  scanRoots: string[];    // relative to repoRoot; [] = single-root
}

interface StoredConfig {
  api_provider?: string;
  model?: string;
  max_parallel_agents?: number;
  wiki_root?: string;
  scan_roots?: string[];
}

export async function resolveConfig(repoRoot: string): Promise<LegionMcpConfig> {
  let stored: StoredConfig = {};
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".legion", "config.json"), "utf8");
    stored = JSON.parse(raw) as StoredConfig;
  } catch {
    // config file absent — use env / defaults
  }

  const apiProvider = (
    process.env.LEGION_API_PROVIDER || stored.api_provider || "anthropic"
  ) as "anthropic" | "openrouter";

  const wikiRootRel = process.env.LEGION_WIKI_ROOT || stored.wiki_root || "";
  const wikiRoot = wikiRootRel
    ? path.isAbsolute(wikiRootRel) ? wikiRootRel : path.resolve(repoRoot, wikiRootRel)
    : path.join(repoRoot, "library", "knowledge-base", "wiki");

  const scanRoots = (
    (process.env.LEGION_SCAN_ROOTS
      ? process.env.LEGION_SCAN_ROOTS.split(",").map((s) => s.trim()).filter(Boolean)
      : null) ?? stored.scan_roots ?? []
  );

  return {
    anthropicApiKey: process.env.LEGION_ANTHROPIC_API_KEY ?? "",
    cohereApiKey: process.env.LEGION_COHERE_API_KEY ?? "",
    model: process.env.LEGION_MODEL || stored.model || "claude-sonnet-4-5",
    maxParallelAgents: stored.max_parallel_agents ?? 3,
    apiProvider,
    openRouterApiKey: process.env.LEGION_OPENROUTER_API_KEY ?? "",
    openRouterModel: process.env.LEGION_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4-5",
    wikiRoot,
    scanRoots,
  };
}
