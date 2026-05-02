import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as https from "https";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SearchResult {
  pagePath: string;
  score: number;
  title: string;
  snippet: string;
}

interface EmbeddingCache {
  version: number;
  lastIndexed: string;
  pages: Record<string, { hash: string; vector: number[] }>;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Cosine similarity between two equal-length dense vectors. */
export function cosineSimil(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed a batch of texts using Cohere's embed-english-v3.0 model.
 * Batches into groups of 96 (Cohere per-request limit).
 */
export async function embedText(
  texts: string[],
  apiKey: string,
  inputType: "search_document" | "search_query" = "search_document"
): Promise<number[][]> {
  const BATCH_SIZE = 96;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      texts: batch,
      model: "embed-english-v3.0",
      input_type: inputType,
    });
    const raw = await httpsPost("api.cohere.ai", "/v1/embed", body, {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    });
    const parsed = JSON.parse(raw) as { embeddings: number[][] };
    results.push(...parsed.embeddings);
  }

  return results;
}

/**
 * Build or incrementally update the embedding index at `.legion/embeddings.json`.
 * When `changedPaths` is provided, only those pages are re-embedded.
 * When omitted, all wiki pages are compared against the cache by SHA-256 hash.
 * If `cohereApiKey` is not available, exits early (TF-IDF needs no index file).
 *
 * Pass `context` (v1.2.0+) so the key is read from SecretStorage first.
 */
export async function buildIndex(
  repoRoot: string,
  changedPaths?: string[],
  context?: import("vscode").ExtensionContext
): Promise<void> {
  const apiKey = context ? await resolveApiKeyWithContext(context) : resolveApiKey();
  if (!apiKey) return;

  const cachePath = path.join(repoRoot, ".legion", "embeddings.json");
  const cache = await loadCache(cachePath);

  const wikiDir = path.join(repoRoot, "library", "knowledge-base", "wiki");
  const pages = await collectWikiPages(wikiDir);

  const toEmbedPaths: string[] = [];
  const toEmbedTexts: string[] = [];

  for (const [pagePath, content] of pages) {
    if (changedPaths && !changedPaths.some((cp) => pagePath.includes(cp) || cp.includes(pagePath))) {
      continue;
    }
    const hash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
    if (cache.pages[pagePath]?.hash === hash) continue;
    toEmbedPaths.push(pagePath);
    toEmbedTexts.push(content.slice(0, 4096));
  }

  if (toEmbedTexts.length === 0) return;

  try {
    const vectors = await embedText(toEmbedTexts, apiKey, "search_document");
    for (let i = 0; i < toEmbedPaths.length; i++) {
      const content = pages.get(toEmbedPaths[i])!;
      const hash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
      cache.pages[toEmbedPaths[i]] = { hash, vector: vectors[i] };
    }
    cache.lastIndexed = new Date().toISOString();
    await fs.mkdir(path.join(repoRoot, ".legion"), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    // Non-fatal: log to stderr, session falls back to TF-IDF
    process.stderr.write(`[Legion] Cohere embed error: ${String(err)}\n`);
  }
}

/**
 * Search the wiki by semantic query.
 * Uses Cohere dense vectors when an API key is available; falls back to TF-IDF otherwise.
 */
export async function query(
  repoRoot: string,
  queryText: string,
  topN = 10
): Promise<SearchResult[]> {
  const apiKey = resolveApiKey();
  const wikiDir = path.join(repoRoot, "library", "knowledge-base", "wiki");
  const pages = await collectWikiPages(wikiDir);

  if (!pages.size) return [];

  if (apiKey) {
    return querySemantic(repoRoot, queryText, topN, apiKey, pages);
  }
  return queryTfIdf(queryText, topN, pages);
}

// ── Cohere semantic path ───────────────────────────────────────────────────────

async function querySemantic(
  repoRoot: string,
  queryText: string,
  topN: number,
  apiKey: string,
  pages: Map<string, string>
): Promise<SearchResult[]> {
  const cachePath = path.join(repoRoot, ".legion", "embeddings.json");
  const cache = await loadCache(cachePath);

  let queryVec: number[];
  try {
    const vecs = await embedText([queryText], apiKey, "search_query");
    queryVec = vecs[0];
  } catch {
    return queryTfIdf(queryText, topN, pages);
  }

  const THRESHOLD = 0.25;
  const scores: { pagePath: string; score: number; content: string }[] = [];

  for (const [pagePath, content] of pages) {
    const cached = cache.pages[pagePath];
    if (!cached?.vector) continue;
    const score = cosineSimil(queryVec, cached.vector);
    if (score >= THRESHOLD) scores.push({ pagePath, score, content });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topN).map(({ pagePath, score, content }) => ({
    pagePath,
    score,
    title: extractTitle(content),
    snippet: content.slice(0, 200).replace(/\n/g, " "),
  }));
}

// ── TF-IDF fallback ────────────────────────────────────────────────────────────

async function queryTfIdf(
  queryText: string,
  topN: number,
  pages: Map<string, string>
): Promise<SearchResult[]> {
  const corpus = new Map<string, string[]>();
  for (const [p, content] of pages) corpus.set(p, tokenize(content));

  const docVectors = buildTfIdfVectors(corpus);
  const qTokens = tokenize(queryText);
  const queryVec = buildTfIdfVectors(new Map([["__q__", qTokens]])).get("__q__")!;

  const THRESHOLD = 0.05;
  const scores: { pagePath: string; score: number; content: string }[] = [];

  for (const [pagePath, docVec] of docVectors) {
    if (pagePath === "__q__") continue;
    const score = sparseCosineSim(queryVec, docVec);
    if (score > THRESHOLD) {
      scores.push({ pagePath, score, content: pages.get(pagePath) ?? "" });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topN).map(({ pagePath, score, content }) => ({
    pagePath,
    score,
    title: extractTitle(content),
    snippet: content.slice(0, 200).replace(/\n/g, " "),
  }));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildTfIdfVectors(corpus: Map<string, string[]>): Map<string, Map<string, number>> {
  const N = corpus.size;
  const df = new Map<string, number>();

  for (const tokens of corpus.values()) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const docVectors = new Map<string, Map<string, number>>();
  for (const [docId, tokens] of corpus) {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const tfScore = count / tokens.length;
      const idfScore = Math.log(N / (1 + (df.get(term) ?? 0)));
      vec.set(term, tfScore * idfScore);
    }
    docVectors.set(docId, vec);
  }

  return docVectors;
}

function sparseCosineSim(
  queryVec: Map<string, number>,
  docVec: Map<string, number>
): number {
  let dot = 0, normQ = 0, normD = 0;
  for (const [term, weight] of queryVec) {
    dot += weight * (docVec.get(term) ?? 0);
    normQ += weight * weight;
  }
  for (const w of docVec.values()) normD += w * w;
  const denom = Math.sqrt(normQ) * Math.sqrt(normD);
  return denom === 0 ? 0 : dot / denom;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveApiKey(): string {
  if (process.env.LEGION_COHERE_API_KEY) return process.env.LEGION_COHERE_API_KEY;
  try {
    // Lazy import to avoid bundling vscode in the MCP server build
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode") as typeof import("vscode");
    return vscode.workspace.getConfiguration("legion").get<string>("cohereApiKey", "") ?? "";
  } catch {
    return "";
  }
}

/**
 * Like resolveApiKey() but also checks SecretStorage (v1.2.0+). Call this
 * from extension-context paths (document.ts, update.ts). The non-async
 * resolveApiKey() is kept for the MCP server and other no-context paths.
 */
export async function resolveApiKeyWithContext(
  context: import("vscode").ExtensionContext
): Promise<string> {
  // env var first (same as resolveApiKey)
  if (process.env.LEGION_COHERE_API_KEY) return process.env.LEGION_COHERE_API_KEY;
  try {
    const { getSecret } = await import("../util/secretStore");
    const stored = await getSecret(context, "cohereApiKey");
    if (stored) return stored;
  } catch {}
  return resolveApiKey(); // settings.json fallback
}

async function collectWikiPages(wikiDir: string): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  await walkWikiDir(wikiDir, wikiDir, pages);
  return pages;
}

async function walkWikiDir(
  rootDir: string,
  dir: string,
  pages: Map<string, string>
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkWikiDir(rootDir, abs, pages);
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
      try {
        const content = await fs.readFile(abs, "utf8");
        const relPath = path.relative(rootDir, abs).replace(/\\/g, "/");
        pages.set(relPath, content);
      } catch {
        // skip unreadable files
      }
    }
  }
}

async function loadCache(cachePath: string): Promise<EmbeddingCache> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as EmbeddingCache;
  } catch {
    return { version: 1, lastIndexed: "", pages: {} };
  }
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "";
}

function httpsPost(
  hostname: string,
  urlPath: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Cohere API ${res.statusCode}: ${text}`));
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
}
