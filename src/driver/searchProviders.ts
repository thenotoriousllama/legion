import * as https from "https";
import * as http from "http";

/**
 * Unified search provider abstraction for Autoresearch.
 * Supports Exa (neural web search), Firecrawl (scrape+search), and Context7
 * (library/framework documentation). Each provider returns a list of
 * SearchResult objects that the research pass injects into Anthropic synthesis
 * prompts as grounded source material.
 */

export type SearchProvider = "model-only" | "exa" | "firecrawl" | "context7";

export interface SearchResult {
  title: string;
  url: string;
  /** Full or truncated content suitable for embedding in a prompt. */
  content: string;
  publishedDate?: string;
}

export interface SearchProviderConfig {
  provider: SearchProvider;
  exaApiKey?: string;
  firecrawlApiKey?: string;
  context7ApiKey?: string;
  maxResults?: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search for the given topic using the configured provider.
 * Returns [] when provider is "model-only" or when an API key is missing.
 */
export async function searchTopic(
  topic: string,
  config: SearchProviderConfig
): Promise<SearchResult[]> {
  const max = config.maxResults ?? 5;
  switch (config.provider) {
    case "exa":
      if (!config.exaApiKey) return [];
      return searchExa(topic, config.exaApiKey, max);
    case "firecrawl":
      if (!config.firecrawlApiKey) return [];
      return searchFirecrawl(topic, config.firecrawlApiKey, max);
    case "context7":
      return searchContext7(topic, config.context7ApiKey ?? "", max);
    case "model-only":
    default:
      return [];
  }
}

/**
 * Scrape a single URL using Firecrawl (for deep-dive fetches in Round 2).
 * Returns null when Firecrawl is not configured.
 */
export async function scrapeUrl(
  url: string,
  firecrawlApiKey: string
): Promise<SearchResult | null> {
  if (!firecrawlApiKey) return null;
  return firecrawlScrape(url, firecrawlApiKey);
}

// ── Exa ───────────────────────────────────────────────────────────────────────

/**
 * Exa neural search — finds semantically relevant pages and returns clean text.
 * API: POST https://api.exa.ai/search
 * Docs: https://docs.exa.ai/reference/search
 */
async function searchExa(
  query: string,
  apiKey: string,
  numResults: number
): Promise<SearchResult[]> {
  const body = JSON.stringify({
    query,
    numResults,
    type: "neural",
    contents: {
      text: { maxCharacters: 4000 },
      highlights: { numSentences: 3, highlightsPerUrl: 2 },
    },
  });

  const raw = await postJson("api.exa.ai", "/search", body, {
    "x-api-key": apiKey,
  });

  interface ExaResult {
    title?: string;
    url?: string;
    text?: string;
    highlights?: string[];
    publishedDate?: string;
  }
  interface ExaResponse {
    results?: ExaResult[];
    error?: { message: string };
  }

  const res = JSON.parse(raw) as ExaResponse;
  if (res.error) throw new Error(`Exa: ${res.error.message}`);

  return (res.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "",
    url: r.url ?? "",
    content: r.text ?? r.highlights?.join(" ") ?? "",
    publishedDate: r.publishedDate,
  }));
}

// ── Firecrawl ─────────────────────────────────────────────────────────────────

/**
 * Firecrawl search — searches the web and returns clean markdown.
 * API: POST https://api.firecrawl.dev/v1/search
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/search
 */
async function searchFirecrawl(
  query: string,
  apiKey: string,
  limit: number
): Promise<SearchResult[]> {
  const body = JSON.stringify({
    query,
    limit,
    lang: "en",
    scrapeOptions: { formats: ["markdown"] },
  });

  const raw = await postJson("api.firecrawl.dev", "/v1/search", body, {
    Authorization: `Bearer ${apiKey}`,
  });

  interface FirecrawlItem {
    url?: string;
    title?: string;
    description?: string;
    markdown?: string;
  }
  interface FirecrawlResponse {
    data?: FirecrawlItem[];
    success?: boolean;
    error?: string;
  }

  const res = JSON.parse(raw) as FirecrawlResponse;
  if (res.error) throw new Error(`Firecrawl: ${res.error}`);

  return (res.data ?? []).map((r) => ({
    title: r.title ?? r.url ?? "",
    url: r.url ?? "",
    content: (r.markdown ?? r.description ?? "").slice(0, 4000),
  }));
}

/**
 * Firecrawl scrape — fetch a single URL as clean markdown.
 * API: POST https://api.firecrawl.dev/v1/scrape
 */
async function firecrawlScrape(url: string, apiKey: string): Promise<SearchResult | null> {
  const body = JSON.stringify({ url, formats: ["markdown"] });

  const raw = await postJson("api.firecrawl.dev", "/v1/scrape", body, {
    Authorization: `Bearer ${apiKey}`,
  });

  interface ScrapeResponse {
    data?: { markdown?: string; metadata?: { title?: string } };
    success?: boolean;
  }

  const res = JSON.parse(raw) as ScrapeResponse;
  if (!res.data) return null;

  return {
    title: res.data.metadata?.title ?? url,
    url,
    content: (res.data.markdown ?? "").slice(0, 8000),
  };
}

// ── Context7 ──────────────────────────────────────────────────────────────────

/**
 * Context7 — fetches library/framework documentation.
 * Best for topics like "React Server Components", "Prisma migrations", etc.
 * API: GET https://context7.com/api/v1/search?query=...&tokens=5000
 * No API key required for basic usage; an API key unlocks higher limits.
 */
async function searchContext7(
  query: string,
  apiKey: string,
  maxResults: number
): Promise<SearchResult[]> {
  // Step 1: Search for relevant library documentation
  const searchPath = `/api/v1/search?query=${encodeURIComponent(query)}&tokens=5000`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let raw: string;
  try {
    raw = await getJson("context7.com", searchPath, headers);
  } catch {
    return []; // Context7 is best-effort — fail gracefully
  }

  interface C7Doc {
    id?: string;
    title?: string;
    description?: string;
    tokens?: number;
    trust_score?: number;
  }
  interface C7SearchResponse {
    results?: C7Doc[];
  }

  const res = JSON.parse(raw) as C7SearchResponse;
  const topDocs = (res.results ?? [])
    .sort((a, b) => (b.trust_score ?? 0) - (a.trust_score ?? 0))
    .slice(0, maxResults);

  if (topDocs.length === 0) return [];

  // Step 2: Fetch content for top result(s)
  const results: SearchResult[] = [];
  for (const doc of topDocs.slice(0, 2)) {
    if (!doc.id) continue;
    try {
      const docPath = `/api/v1/${doc.id}?tokens=5000`;
      const docRaw = await getJson("context7.com", docPath, headers);
      interface C7Content { content?: string; id?: string; title?: string }
      const docContent = JSON.parse(docRaw) as C7Content;
      results.push({
        title: doc.title ?? doc.id ?? "Context7 Doc",
        url: `https://context7.com/${doc.id}`,
        content: (docContent.content ?? doc.description ?? "").slice(0, 4000),
      });
    } catch {
      // Skip docs that fail to fetch
    }
  }

  return results;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function postJson(
  hostname: string,
  path_: string,
  body: string,
  extraHeaders: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: path_,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${hostname}: ${text.slice(0, 200)}`));
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

function getJson(
  hostname: string,
  path_: string,
  extraHeaders: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib: typeof https = hostname.startsWith("localhost") ? (http as unknown as typeof https) : https;
    lib.get(
      { hostname, path: path_, headers: { accept: "application/json", ...extraHeaders } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(text);
          }
        });
      }
    ).on("error", reject);
  });
}
