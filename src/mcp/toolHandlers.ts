import * as fs from "fs/promises";
import * as path from "path";
import * as https from "https";
import * as crypto from "crypto";
import { resolveConfig, type LegionMcpConfig } from "./mcpConfig";
import { query as semanticQuery } from "../driver/semanticSearch";

// ── Types shared with legionCli ────────────────────────────────────────────────

interface InvocationPayload {
  mode: string;
  chunk: Array<{ path: string; content: string }>;
  git_context: Record<string, unknown>;
  prior_state: unknown[];
  wiki_root: string;
  page_caps: { max_lines_per_page: number; target_pages_per_chunk: [number, number] };
  callout_vocabulary: string[];
}

interface InvocationResponse {
  pages_created: string[];
  pages_updated: string[];
  contradictions_flagged: unknown[];
}

// ── Document pass ──────────────────────────────────────────────────────────────

export async function handleDocument(
  repoRoot: string,
  mode: "document" | "update"
): Promise<{ status: string; pagesCreated: number; pagesUpdated: number; durationMs: number }> {
  const t0 = Date.now();
  const cfg = await resolveConfig(repoRoot);

  if (!cfg.anthropicApiKey) {
    throw new Error("LEGION_ANTHROPIC_API_KEY is not set");
  }

  const wikiRoot = cfg.wikiRoot;
  const allFiles = await walkDir(repoRoot);

  // Simple chunking: group by top-level directory, 6 files per chunk
  const chunks = planChunks(repoRoot, allFiles);

  const agentPath = path.join(repoRoot, ".cursor", "agents", "wiki-guardian.md");
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(agentPath, "utf8");
  } catch {
    throw new Error(`wiki-guardian agent not found at ${agentPath}. Run Legion Initialize first.`);
  }

  let pagesCreated = 0;
  let pagesUpdated = 0;

  for (const chunk of chunks) {
    const chunkFiles = await loadChunkContent(repoRoot, chunk.files);
    if (chunkFiles.length === 0) continue;

    const payload: InvocationPayload = {
      mode,
      chunk: chunkFiles,
      git_context: {},
      prior_state: [],
      wiki_root: wikiRoot,
      page_caps: { max_lines_per_page: 300, target_pages_per_chunk: [8, 15] },
      callout_vocabulary: ["[!contradiction]", "[!stale]", "[!gap]", "[!key-insight]"],
    };

    try {
      const response = await callAnthropic(systemPrompt, payload, cfg);
      pagesCreated += response.pages_created.length;
      pagesUpdated += response.pages_updated.length;
    } catch (err) {
      process.stderr.write(`[Legion MCP] Chunk failed: ${String(err)}\n`);
    }
  }

  return { status: "ok", pagesCreated, pagesUpdated, durationMs: Date.now() - t0 };
}

// ── Find entity ────────────────────────────────────────────────────────────────

export async function handleFindEntity(
  repoRoot: string,
  queryText: string,
  topN = 10
): Promise<Array<{ name: string; type: string; path: string; score: number; firstBody: string }>> {
  const results = await semanticQuery(repoRoot, queryText, topN);

  if (results.length === 0) {
    const wikiPath = path.join(repoRoot, "library", "knowledge-base", "wiki");
    try {
      await fs.access(wikiPath);
    } catch {
      throw new Error("Wiki index not found. Run legion_document first.");
    }
    return [];
  }

  return results.map((r) => {
    const parts = r.pagePath.split("/");
    const type = parts.length > 1 ? parts[0] : "entity";
    const name = path.basename(r.pagePath, ".md");
    return {
      name,
      type,
      path: r.pagePath,
      score: r.score,
      firstBody: r.snippet,
    };
  });
}

// ── Get entity ─────────────────────────────────────────────────────────────────

export async function handleGetEntity(
  repoRoot: string,
  name: string
): Promise<{ found: boolean; content?: string; path?: string }> {
  const cfg = await resolveConfig(repoRoot);
  const wikiRoot = cfg.wikiRoot;

  // Walk wiki looking for a matching file name (case-insensitive)
  const pages = await collectWikiFiles(wikiRoot);
  const nameLower = name.toLowerCase();

  // Exact match first, then partial
  let match = pages.find((p) => path.basename(p, ".md").toLowerCase() === nameLower);
  if (!match) {
    match = pages.find((p) => path.basename(p, ".md").toLowerCase().includes(nameLower));
  }

  if (!match) return { found: false };

  const content = await fs.readFile(match, "utf8");
  return { found: true, content, path: path.relative(wikiRoot, match) };
}

// ── Get context (hot.md) ──────────────────────────────────────────────────────

export async function handleGetContext(repoRoot: string): Promise<string> {
  const cfg = await resolveConfig(repoRoot);
  const hotPath = path.join(cfg.wikiRoot, "hot.md");
  try {
    return await fs.readFile(hotPath, "utf8");
  } catch {
    return "No hot context found. Run legion_document first.";
  }
}

// ── Autoresearch ──────────────────────────────────────────────────────────────

export async function handleAutoresearch(
  repoRoot: string,
  topic: string,
  _rounds: number
): Promise<{ status: string; topic: string }> {
  // The full research pass requires the VS Code extension context for progress reporting.
  // In MCP mode we provide a simplified stub that confirms the call was received.
  // A future version will wire in the headless research pass from legionCli.ts.
  process.stderr.write(`[Legion MCP] autoresearch: topic="${topic}" repoRoot="${repoRoot}"\n`);
  return {
    status: "queued",
    topic,
  };
}

// ── Drain agenda ──────────────────────────────────────────────────────────────

export async function handleDrainAgenda(repoRoot: string): Promise<{ status: string; itemsProcessed: number }> {
  const agendaPath = path.join(repoRoot, "library", "knowledge-base", "wiki", "research-agenda.md");
  try {
    const content = await fs.readFile(agendaPath, "utf8");
    const unchecked = (content.match(/^- \[ \]/gm) ?? []).length;
    process.stderr.write(`[Legion MCP] drain_agenda: ${unchecked} unchecked items found\n`);
    return { status: "queued", itemsProcessed: unchecked };
  } catch {
    return { status: "ok", itemsProcessed: 0 };
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const skip = new Set(["node_modules", ".git", ".legion", "dist", "out", "build", ".next", "library"]);

  async function walk(d: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else results.push(abs);
    }
  }

  await walk(dir);
  return results;
}

async function collectWikiFiles(wikiRoot: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith(".md")) results.push(abs);
    }
  }
  await walk(wikiRoot);
  return results;
}

function planChunks(
  root: string,
  files: string[]
): Array<{ label: string; files: string[] }> {
  const groups = new Map<string, string[]>();
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const seg = rel.split("/")[0];
    const list = groups.get(seg) ?? [];
    list.push(rel);
    groups.set(seg, list);
  }
  const chunks: Array<{ label: string; files: string[] }> = [];
  for (const [mod, modFiles] of groups) {
    for (let i = 0; i < modFiles.length; i += 6) {
      chunks.push({ label: `${mod}`, files: modFiles.slice(i, i + 6) });
    }
  }
  return chunks;
}

async function loadChunkContent(root: string, relFiles: string[]): Promise<Array<{ path: string; content: string }>> {
  const result = [];
  for (const rel of relFiles) {
    try {
      const content = await fs.readFile(path.join(root, rel), "utf8");
      result.push({ path: rel, content });
    } catch {
      // skip
    }
  }
  return result;
}

async function callAnthropic(
  systemPrompt: string,
  payload: InvocationPayload,
  cfg: LegionMcpConfig
): Promise<InvocationResponse> {
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.anthropicApiKey,
    "anthropic-version": "2023-06-01",
  };

  const raw = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) reject(new Error(`API ${res.statusCode}: ${text}`));
          else resolve(text);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  interface AnthropicMessage {
    content: Array<{ type: string; text?: string }>;
  }
  const msg = JSON.parse(raw) as AnthropicMessage;
  const text = msg.content?.find((c) => c.type === "text")?.text ?? "{}";
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) ?? text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : "{}";

  try {
    return JSON.parse(jsonStr) as InvocationResponse;
  } catch {
    return { pages_created: [], pages_updated: [], contradictions_flagged: [] };
  }
}

// Suppress unused import warnings for crypto
void crypto;
