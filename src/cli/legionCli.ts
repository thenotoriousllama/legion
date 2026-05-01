#!/usr/bin/env node
/**
 * Legion headless CLI — runs a Document/Update pass without VS Code.
 * Used by the GitHub Action workflow template and any CI environment.
 *
 * Usage:
 *   node dist/cli.js [options]
 *
 * Options:
 *   --mode       document | update | scan-directory  (default: document)
 *   --repo-root  Path to the target repository root   (default: cwd)
 *   --scope-dir  Limit to this subdirectory           (scan-directory only)
 *   --files      Comma-separated list of relative file paths to scan
 *                (bypasses the repo walk; useful for CI PR diffs)
 *
 * Environment:
 *   LEGION_ANTHROPIC_API_KEY   Required — Anthropic API key
 *   LEGION_MODEL               Optional — Claude model slug (default: claude-sonnet-4-5)
 *
 * Exits 0 on success, 1 on error.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as https from "https";
import * as crypto from "crypto";

// ── Types (inline minimal copies — no vscode dependency) ─────────────────────

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
  decisions_filed: string[];
  contradictions_flagged: unknown[];
  meta_reports_written: string[];
  notification_flags: unknown[];
  entities_detected: unknown[];
  gaps: unknown[];
  lint_findings: unknown[];
  partial_scan: boolean;
  error?: { code: string; message: string };
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string, def = ""): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}

const mode = getArg("--mode", "document") as "document" | "update" | "scan-directory";
const repoRoot = path.resolve(getArg("--repo-root", process.cwd()));
const scopeDir = getArg("--scope-dir") || undefined;
const filesArg = getArg("--files");

const apiKey = process.env.LEGION_ANTHROPIC_API_KEY ?? "";
const model = process.env.LEGION_MODEL ?? "claude-sonnet-4-5";

if (!apiKey) {
  console.error("[legion-cli] LEGION_ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[legion-cli] mode=${mode} repoRoot=${repoRoot}`);

  const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");

  // Collect files to process
  let absFiles: string[];
  if (filesArg) {
    absFiles = filesArg.split(",").map((f) => path.resolve(repoRoot, f.trim()));
  } else {
    absFiles = await walkDir(scopeDir ? path.resolve(repoRoot, scopeDir) : repoRoot);
  }

  console.log(`[legion-cli] ${absFiles.length} file(s) to process`);

  // Chunk by module (6 files max per chunk)
  const chunks = planChunks(repoRoot, absFiles);
  console.log(`[legion-cli] ${chunks.length} chunk(s) planned`);

  // Load agent system prompt
  const agentPath = path.join(repoRoot, ".cursor", "agents", "wiki-guardian.md");
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(agentPath, "utf8");
  } catch {
    console.error(`[legion-cli] Agent not found at ${agentPath}. Run Legion Initialize first.`);
    process.exit(1);
  }

  // Process all chunks sequentially (CLI: no concurrency limit needed)
  const allCreated: string[] = [];
  const allUpdated: string[] = [];
  let totalContradictions = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[legion-cli] Processing chunk ${i + 1}/${chunks.length}: ${chunk.label}`);

    const chunkFiles = await loadChunkContent(repoRoot, chunk.files);
    if (chunkFiles.length === 0) continue;

    const payload: InvocationPayload = {
      mode,
      chunk: chunkFiles,
      git_context: Object.fromEntries(chunkFiles.map((f) => [f.path, {}])),
      prior_state: [],
      wiki_root: wikiRoot,
      page_caps: { max_lines_per_page: 300, target_pages_per_chunk: [8, 15] },
      callout_vocabulary: ["[!contradiction]", "[!stale]", "[!gap]", "[!key-insight]"],
    };

    try {
      const response = await callAnthropic(systemPrompt, payload, apiKey, model);
      if (response.error) {
        console.warn(`[legion-cli] Agent error for chunk ${i + 1}: ${response.error.message}`);
        continue;
      }
      allCreated.push(...response.pages_created);
      allUpdated.push(...response.pages_updated);
      totalContradictions += response.contradictions_flagged.length;
      console.log(
        `[legion-cli] Chunk ${i + 1}: +${response.pages_created.length} pages, ` +
          `~${response.pages_updated.length} updated`
      );
    } catch (e) {
      console.error(`[legion-cli] Chunk ${i + 1} failed: ${String(e)}`);
    }
  }

  console.log(
    `[legion-cli] Done — ${allCreated.length} created, ${allUpdated.length} updated, ` +
      `${totalContradictions} contradiction(s).`
  );

  // Emit structured summary to stdout for the GitHub Action to parse
  const summary = {
    pages_created: allCreated.length,
    pages_updated: allUpdated.length,
    contradictions: totalContradictions,
  };
  process.stdout.write(`\nLEGION_SUMMARY=${JSON.stringify(summary)}\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const skip = new Set([
    "node_modules", ".git", ".legion", "dist", "out", "build", ".next", ".turbo",
  ]);
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
      else if (entry.isFile()) results.push(abs);
    }
  }
  await walk(dir);
  return results;
}

function planChunks(root: string, files: string[]): Array<{ label: string; files: string[] }> {
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
      const slice = modFiles.slice(i, i + 6);
      chunks.push({ label: `${mod} (${slice.length} files)`, files: slice });
    }
  }
  return chunks;
}

async function loadChunkContent(
  root: string,
  relFiles: string[]
): Promise<Array<{ path: string; content: string }>> {
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
  apiKey: string,
  modelSlug: string
): Promise<InvocationResponse> {
  const body = JSON.stringify({
    model: modelSlug,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
  });

  const raw = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Anthropic HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          } else {
            resolve(text);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  interface Envelope {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  }
  const envelope = JSON.parse(raw) as Envelope;
  if (envelope.error) throw new Error(`Anthropic: ${envelope.error.message}`);
  const text = envelope.content?.find((b) => b.type === "text")?.text ?? "";

  try {
    return JSON.parse(text) as InvocationResponse;
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1)) as InvocationResponse;
    throw new Error("Could not parse agent response as JSON.");
  }
}

void main().catch((e) => {
  console.error("[legion-cli] Fatal:", e);
  process.exit(1);
});

// Suppress TS unused import warning
void crypto;
