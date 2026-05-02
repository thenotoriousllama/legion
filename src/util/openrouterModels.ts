/**
 * OpenRouter model catalog client.
 *
 * Fetches and caches the full list of models available on openrouter.ai
 * along with their pricing, context length, and provider metadata.
 *
 * The catalog is public (no auth required) and refreshed at most once per
 * 24 hours via VS Code globalState. Stale-while-revalidate semantics: if a
 * forced refresh fails (offline, rate limited), we still return the cached
 * copy so the picker never goes blank.
 */
import * as vscode from "vscode";
import * as https from "https";

export interface OpenRouterModel {
  /** Fully-qualified model id, e.g. "anthropic/claude-3.5-sonnet". */
  id: string;
  /** Human-friendly name, e.g. "Anthropic: Claude 3.5 Sonnet". */
  name: string;
  /** Marketing description from openrouter.ai. */
  description: string;
  /** Max input + output tokens the model accepts. */
  context_length: number;
  /** Cost in USD per token (NOT per 1M — divide raw OR API value by 1). */
  pricing: {
    /** USD per input token (string in raw API; we keep it as number). */
    prompt: number;
    /** USD per output token. */
    completion: number;
  };
  /** Top provider metadata (max completion tokens, true context, etc.). */
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
  /** Modality, e.g. "text->text" or "text+image->text". */
  modality?: string;
}

interface CachedCatalog {
  fetched_at: number;
  models: OpenRouterModel[];
}

const CACHE_KEY = "legion.openRouterModelCatalog.v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const API_URL = "https://openrouter.ai/api/v1/models";

/**
 * Return the OpenRouter model catalog. Returns from globalState cache when
 * fresh (<24 h); otherwise hits the network. On network failure with a
 * stale cache, returns the stale copy with `cached: true` so the UI can
 * show a "served from cache" hint if it wants.
 */
export async function getOpenRouterModels(
  context: vscode.ExtensionContext,
  forceRefresh = false
): Promise<{ models: OpenRouterModel[]; cached: boolean; fetchedAt: number }> {
  const cached = context.globalState.get<CachedCatalog>(CACHE_KEY);
  const now = Date.now();

  if (!forceRefresh && cached && now - cached.fetched_at < CACHE_TTL_MS) {
    return { models: cached.models, cached: true, fetchedAt: cached.fetched_at };
  }

  try {
    const fresh = await fetchModelsFromApi();
    const payload: CachedCatalog = { fetched_at: now, models: fresh };
    await context.globalState.update(CACHE_KEY, payload);
    return { models: fresh, cached: false, fetchedAt: now };
  } catch (err) {
    if (cached) {
      // Stale cache is better than a blank picker. Caller can decide whether
      // to surface a "couldn't refresh — showing cached list" warning.
      return { models: cached.models, cached: true, fetchedAt: cached.fetched_at };
    }
    throw err;
  }
}

/**
 * Direct HTTPS GET to openrouter.ai. No auth required for the models list.
 * 10s timeout + 4 MB max response (the raw payload is ~700 kB at the time
 * of writing — comfortably under).
 */
function fetchModelsFromApi(): Promise<OpenRouterModel[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      API_URL,
      {
        method: "GET",
        headers: {
          "User-Agent": "legion-vscode-extension",
          Accept: "application/json",
        },
        timeout: 10_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`OpenRouter models API returned HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX = 4 * 1024 * 1024;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX) {
            req.destroy(new Error("OpenRouter response exceeded 4 MB cap"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as { data?: unknown[] };
            if (!Array.isArray(parsed.data)) {
              reject(new Error("OpenRouter response missing `data` array"));
              return;
            }
            resolve(parsed.data.map(normalize).filter((m): m is OpenRouterModel => m !== null));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("OpenRouter models API timed out after 10 s"));
    });
    req.end();
  });
}

/**
 * Normalize a raw API entry into our trimmed `OpenRouterModel` shape.
 * Pricing values come back as strings (e.g. "0.000003"); we coerce to
 * numbers and tolerate missing/malformed fields by dropping the model.
 */
function normalize(raw: unknown): OpenRouterModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;

  const pricing = (r.pricing ?? {}) as Record<string, unknown>;
  const promptStr = pricing.prompt;
  const completionStr = pricing.completion;

  // Tolerate missing pricing — show "free" or "unknown" in the UI later.
  const promptCost = typeof promptStr === "string" ? Number(promptStr) : Number(promptStr ?? 0);
  const completionCost =
    typeof completionStr === "string" ? Number(completionStr) : Number(completionStr ?? 0);

  const top = (r.top_provider ?? {}) as Record<string, unknown>;
  const arch = (r.architecture ?? {}) as Record<string, unknown>;

  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : r.id,
    description: typeof r.description === "string" ? r.description : "",
    context_length:
      typeof r.context_length === "number"
        ? r.context_length
        : typeof top.context_length === "number"
        ? (top.context_length as number)
        : 0,
    pricing: {
      prompt: Number.isFinite(promptCost) ? promptCost : 0,
      completion: Number.isFinite(completionCost) ? completionCost : 0,
    },
    top_provider: {
      context_length: typeof top.context_length === "number" ? (top.context_length as number) : undefined,
      max_completion_tokens:
        typeof top.max_completion_tokens === "number" ? (top.max_completion_tokens as number) : null,
    },
    modality: typeof arch.modality === "string" ? (arch.modality as string) : undefined,
  };
}

/**
 * Format a per-token cost as `$X.XX/M tokens`. Returns "free" for 0,
 * "n/a" for non-finite. Used by the picker badges.
 */
export function formatPrice(perToken: number): string {
  if (!Number.isFinite(perToken)) return "n/a";
  if (perToken === 0) return "free";
  const perMillion = perToken * 1_000_000;
  if (perMillion >= 100) return `$${perMillion.toFixed(0)}/M`;
  if (perMillion >= 10) return `$${perMillion.toFixed(1)}/M`;
  return `$${perMillion.toFixed(2)}/M`;
}

/**
 * Format a context length as `200k` / `1M` / `8k`. 0 returns "?".
 */
export function formatContext(tokens: number): string {
  if (!tokens) return "?";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
