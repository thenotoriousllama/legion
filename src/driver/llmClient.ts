import * as https from "https";

/**
 * Unified LLM client for Legion.
 *
 * Supports two API providers:
 *
 * - "anthropic"   — direct Anthropic Messages API (/v1/messages).
 *                   Uses `legion.anthropicApiKey` + `legion.model`.
 *
 * - "openrouter"  — OpenRouter unified gateway (/api/v1/chat/completions,
 *                   OpenAI-compatible format). Supports 300+ models from
 *                   Anthropic, OpenAI, Google, Meta, Mistral, and more.
 *                   Uses `legion.openRouterApiKey` + `legion.openRouterModel`.
 *
 * Both providers are called with the same interface. The caller supplies a
 * system prompt and a user message; the function returns the assistant text.
 */

export type ApiProvider = "anthropic" | "openrouter";

export interface LlmConfig {
  provider: ApiProvider;
  /** Anthropic API key (required when provider = "anthropic"). */
  anthropicApiKey?: string;
  /** OpenRouter API key (required when provider = "openrouter"). */
  openRouterApiKey?: string;
  /**
   * Model identifier.
   * - Anthropic: "claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"
   * - OpenRouter: fully-qualified "anthropic/claude-sonnet-4-5",
   *               "openai/gpt-4o", "google/gemini-pro", etc.
   */
  model: string;
  maxTokens?: number;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  error?: { message: string };
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the configured LLM provider with a system prompt and a user message.
 * Returns the assistant's text response.
 */
export async function callLlm(
  config: LlmConfig,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  validateConfig(config);

  switch (config.provider) {
    case "openrouter":
      return callOpenRouter(config, systemPrompt, userMessage);
    case "anthropic":
    default:
      return callAnthropic(config, systemPrompt, userMessage);
  }
}

/**
 * Validate the config and throw a user-friendly error if required keys are missing.
 */
export function validateConfig(config: LlmConfig): void {
  if (config.provider === "anthropic" && !config.anthropicApiKey) {
    throw new Error(
      "legion.anthropicApiKey (or LEGION_ANTHROPIC_API_KEY env var) is required when apiProvider is 'anthropic'."
    );
  }
  if (config.provider === "openrouter" && !config.openRouterApiKey) {
    throw new Error(
      "legion.openRouterApiKey (or LEGION_OPENROUTER_API_KEY env var) is required when apiProvider is 'openrouter'."
    );
  }
  if (!config.model) {
    throw new Error(
      "No model specified. Set legion.model (Anthropic) or legion.openRouterModel (OpenRouter)."
    );
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropic(
  config: LlmConfig,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const body = JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens ?? 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = await httpsPost("api.anthropic.com", "/v1/messages", body, {
    "x-api-key": config.anthropicApiKey ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });

  const envelope = JSON.parse(raw) as AnthropicResponse;
  if (envelope.error) throw new Error(`Anthropic API error: ${envelope.error.message}`);

  const textBlock = envelope.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("Anthropic API returned no text content.");
  return textBlock.text;
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

/**
 * OpenRouter uses the OpenAI chat completions format.
 * System prompt is passed as messages[0] with role "system".
 * Docs: https://openrouter.ai/docs/requests
 */
async function callOpenRouter(
  config: LlmConfig,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const body = JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens ?? 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  const raw = await httpsPost("openrouter.ai", "/api/v1/chat/completions", body, {
    Authorization: `Bearer ${config.openRouterApiKey ?? ""}`,
    "HTTP-Referer": "https://github.com/thenotoriousllama/legion",
    "X-Title": "Legion VS Code Extension",
    "content-type": "application/json",
  });

  const envelope = JSON.parse(raw) as OpenRouterResponse;
  if (envelope.error) throw new Error(`OpenRouter API error: ${envelope.error.message}`);

  const content = envelope.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter API returned no content.");
  return content;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsPost(
  hostname: string,
  path_: string,
  body: string,
  headers: Record<string, string | number>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: path_,
        method: "POST",
        headers: {
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${hostname}: ${text.slice(0, 300)}`));
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
