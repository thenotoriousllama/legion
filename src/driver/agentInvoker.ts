import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs/promises";
import * as path from "path";
import type { InvocationPayload } from "../types/payload";
import type { InvocationResponse } from "../types/response";
import { callLlm, type LlmConfig } from "./llmClient";

/**
 * The set of agent invocation modes Legion supports.
 *
 * - `cursor-sdk` — invoke via the official `@cursor/sdk` (Cursor TypeScript
 *   SDK). Uses `Agent.prompt` against a local-runtime agent backed by
 *   Cursor's infrastructure. Requires `CURSOR_API_KEY` (or the
 *   `legion.cursorApiKey` setting). This is the recommended mode for users
 *   on a paid Cursor plan and is the new default in v1.1.0+.
 * - `cursor-cli` — DEPRECATED alias that resolves to `cursor-sdk`. Earlier
 *   releases shelled out to `cursor agent <name> --input <path>`, but that
 *   CLI surface was never publicly supported by Cursor and silently failed.
 *   Existing user configurations naming `cursor-cli` continue to work and
 *   transparently route through the SDK path.
 * - `queue-file` — write request files to `.legion/queue/` for manual
 *   processing by a Cursor slash command. Useful as an escape hatch.
 * - `direct-anthropic-api` — call Anthropic (or OpenRouter) directly. No
 *   Cursor dependency, just an API key. Recommended for VS Code users and
 *   anyone without a Cursor subscription.
 */
export type InvocationMode =
  | "cursor-sdk"
  | "cursor-cli"
  | "queue-file"
  | "direct-anthropic-api";

/**
 * Invoke a Cursor agent (wiki-guardian, library-guardian, etc.) with a
 * structured payload. Mode is read from the `legion.agentInvocationMode`
 * setting.
 */
export async function invokeAgent(
  agentName: string,
  payload: InvocationPayload,
  repoRoot: string,
  _context: vscode.ExtensionContext
): Promise<InvocationResponse> {
  const config = vscode.workspace.getConfiguration("legion");
  const mode = config.get<InvocationMode>("agentInvocationMode", "cursor-sdk");

  switch (mode) {
    case "cursor-sdk":
    case "cursor-cli": // deprecated alias — kept for backwards compatibility
      return invokeCursorSdk(agentName, payload, repoRoot, config);
    case "queue-file":
      return invokeQueueFile(agentName, payload, repoRoot);
    case "direct-anthropic-api":
      return invokeAnthropicApi(agentName, payload, config);
    default:
      throw new Error(`Unknown agentInvocationMode: ${mode}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode 1: cursor-sdk (default in v1.1.0+; cursor-cli is a deprecated alias)
//
// Invokes the guardian via the official `@cursor/sdk` package. Replaces the
// legacy CLI shell-out approach which never actually worked end-to-end —
// `cursor agent <name> --input <path>` was never a publicly-supported Cursor
// CLI surface, so the bare-spawn path silently produced garbage that
// `parseResponse()` couldn't parse. The SDK is the documented programmatic
// interface to Cursor agents.
//
// Architecture notes:
//   • The SDK is shipped inside the VSIX as a runtime `node_modules/`
//     dependency; esbuild marks it `--external:@cursor/sdk` so the 5.78 MB
//     pre-bundled webpack output isn't re-bundled. See `package.json` and
//     `.vscodeignore`.
//   • The SDK eagerly loads native `sqlite3` at module top-level, which means
//     each Marketplace VSIX must ship the platform-correct `.node` binary.
//     The release pipeline (`.github/workflows/release.yml`) builds one VSIX
//     per supported platform via `vsce package --target <platform>`. There
//     is no `@cursor/sdk-win32-arm64` package on npm yet — Windows-on-ARM
//     users should select `direct-anthropic-api` mode.
// ──────────────────────────────────────────────────────────────────────────────

async function invokeCursorSdk(
  agentName: string,
  payload: InvocationPayload,
  repoRoot: string,
  config: vscode.WorkspaceConfiguration
): Promise<InvocationResponse> {
  // Lazy-require the SDK so that an environment without the native sqlite3
  // binary (e.g. Windows-on-ARM where no @cursor/sdk-win32-arm64 exists) only
  // explodes for users who actually selected this mode, not on extension
  // activation. The plain string literal is intentional — esbuild marks
  // `@cursor/sdk` as external, so this resolves at runtime via Node's normal
  // CommonJS resolution against the VSIX's bundled node_modules/.
  let Agent: typeof import("@cursor/sdk").Agent;
  let CursorAgentError: typeof import("@cursor/sdk").CursorAgentError;
  try {
    const sdk = require("@cursor/sdk") as typeof import("@cursor/sdk");
    Agent = sdk.Agent;
    CursorAgentError = sdk.CursorAgentError;
  } catch (loadErr) {
    throw new Error(
      `Legion could not load @cursor/sdk. This typically happens on platforms ` +
        `where Cursor doesn't ship the SDK's native binaries (e.g. Windows on ` +
        `ARM, where @cursor/sdk-win32-arm64 doesn't exist on npm yet), or when ` +
        `the VSIX you installed targets a different OS/architecture. Switch ` +
        `'legion.agentInvocationMode' to 'direct-anthropic-api' (requires ` +
        `'legion.anthropicApiKey' or the LEGION_ANTHROPIC_API_KEY env var) to ` +
        `bypass the SDK entirely.\n\nOriginal load error: ` +
        (loadErr instanceof Error ? loadErr.message : String(loadErr))
    );
  }

  // ── Resolve API key + model ──────────────────────────────────────────────
  const apiKey =
    config.get<string>("cursorApiKey") ||
    process.env.LEGION_CURSOR_API_KEY ||
    process.env.CURSOR_API_KEY ||
    "";
  if (!apiKey) {
    throw new Error(
      `Legion: cursor-sdk mode requires a Cursor API key. Set ` +
        `'legion.cursorApiKey' in Settings, or export the CURSOR_API_KEY ` +
        `environment variable. Get a key at ` +
        `https://cursor.com/dashboard/cloud-agents (you'll need a paid Cursor ` +
        `plan). Alternatively, switch 'legion.agentInvocationMode' to ` +
        `'direct-anthropic-api' (uses Anthropic / OpenRouter — set ` +
        `'legion.anthropicApiKey' or LEGION_ANTHROPIC_API_KEY) which works on ` +
        `every platform and doesn't require a Cursor subscription.`
    );
  }
  const modelId = config.get<string>("cursorSdkModel") || "composer-2";

  // ── Load agent system prompt + referenced skills ─────────────────────────
  // Mirrors the loading logic in invokeAnthropicApi so behavior is consistent
  // across SDK / Anthropic-direct modes.
  const agentPath = path.join(repoRoot, ".cursor", "agents", `${agentName}.md`);
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(agentPath, "utf8");
  } catch {
    throw new Error(
      `cursor-sdk: agent file not found at ${agentPath}. ` +
        "Run Legion: Initialize Repository first."
    );
  }

  const skillRefs = extractSkillRefs(systemPrompt);
  const skillContents: string[] = [];
  for (const ref of skillRefs) {
    const refPath = path.join(repoRoot, ".cursor", ref.replace(/^\//, ""));
    try {
      const content = await fs.readFile(refPath, "utf8");
      skillContents.push(`\n\n<!-- skill: ${ref} -->\n${content}`);
    } catch {
      // Missing skill — skip silently (matches direct-anthropic-api behavior)
    }
  }
  const fullSystem = systemPrompt + skillContents.join("");

  // ── Build the prompt ─────────────────────────────────────────────────────
  // The SDK's Agent.prompt() takes a single prompt string (no separate system
  // role like Anthropic Messages API). We concatenate the guardian's system
  // prompt + skills with the JSON payload, and add an explicit instruction
  // to respond with JSON only — the SDK runs an *agent* (with tool access)
  // rather than a pure LLM call, so we need to discourage it from wandering
  // off and using tools when all we want is the structured guardian output.
  const fullPrompt =
    `${fullSystem}\n\n---\n\n# INVOCATION PAYLOAD\n\n` +
    `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n` +
    `Respond with the structured JSON output specified in the system prompt ` +
    `above. Output JSON only — no surrounding markdown fence, no commentary. ` +
    `Do not invoke tools or read additional files unless the system prompt ` +
    `explicitly instructs you to.`;

  // ── Invoke the agent ─────────────────────────────────────────────────────
  // Agent.prompt() is the SDK's one-shot pattern — it disposes itself, no
  // try/finally with [Symbol.asyncDispose]() needed. Local runtime so the
  // agent runs against the user's repo on their machine (matches Legion's
  // existing local-execution model).
  try {
    const result = await Agent.prompt(fullPrompt, {
      apiKey,
      model: { id: modelId },
      local: { cwd: repoRoot },
    });

    if (result.status === "error") {
      throw new Error(
        `cursor-sdk: agent run failed (status=error). Run ID: ${result.id}. ` +
          `Inspect at https://cursor.com/dashboard/cloud-agents.`
      );
    }
    if (typeof result.result !== "string" || result.result.trim().length === 0) {
      throw new Error(
        `cursor-sdk: agent returned no text result (status=${result.status}, ` +
          `run id=${result.id}).`
      );
    }
    return parseResponse(result.result);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(
        `cursor-sdk: agent failed to start — ${err.message}` +
          (err.isRetryable ? " (retryable)" : " (not retryable)") +
          `\n\nIf this is an auth error, verify 'legion.cursorApiKey' is set ` +
          `correctly (get one at https://cursor.com/dashboard/cloud-agents). ` +
          `If you don't have a Cursor subscription, switch ` +
          `'legion.agentInvocationMode' to 'direct-anthropic-api'.`
      );
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode 2: queue-file
// Extension writes a request file; a Cursor slash command (`/legion-drain`)
// processes it. Useful when the CLI surface is flaky or you want manual control.
// ──────────────────────────────────────────────────────────────────────────────

async function invokeQueueFile(
  agentName: string,
  payload: InvocationPayload,
  repoRoot: string
): Promise<InvocationResponse> {
  const queueDir = path.join(repoRoot, ".legion", "queue");
  await fs.mkdir(queueDir, { recursive: true });
  const id = `${agentName}-${Date.now()}`;
  const reqPath = path.join(queueDir, `${id}-request.json`);
  const respPath = path.join(queueDir, `${id}-response.json`);

  await fs.writeFile(
    reqPath,
    JSON.stringify({ agent: agentName, payload, request_id: id }, null, 2)
  );

  // Poll for the response file. 10 minute timeout.
  const startTime = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const content = await fs.readFile(respPath, "utf8");
      await Promise.all([
        fs.unlink(reqPath).catch(() => undefined),
        fs.unlink(respPath).catch(() => undefined),
      ]);
      return parseResponse(content);
    } catch {
      // Not yet — wait 1s and retry
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `Queue-file invocation timed out after 10 minutes. Run /legion-drain in Cursor to process .legion/queue/${id}-request.json.`
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode 3: direct-anthropic-api
// Bypasses Cursor entirely — useful for headless or CI runs.
// v0.2.0: full implementation. v0.1.0: stub.
// ──────────────────────────────────────────────────────────────────────────────

async function invokeAnthropicApi(
  agentName: string,
  payload: InvocationPayload,
  config: vscode.WorkspaceConfiguration
): Promise<InvocationResponse> {
  // ── Build LLM config (Anthropic or OpenRouter) ────────────────────────────
  const provider = config.get<"anthropic" | "openrouter">("apiProvider", "anthropic");
  const llmConfig: LlmConfig = {
    provider,
    anthropicApiKey:
      config.get<string>("anthropicApiKey") || process.env.LEGION_ANTHROPIC_API_KEY || "",
    openRouterApiKey:
      config.get<string>("openRouterApiKey") || process.env.LEGION_OPENROUTER_API_KEY || "",
    model:
      provider === "openrouter"
        ? (config.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
        : (config.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 8192,
  };

  // 1. Load agent system prompt from .cursor/agents/<agentName>.md
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const agentPath = path.join(repoRoot, ".cursor", "agents", `${agentName}.md`);
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(agentPath, "utf8");
  } catch {
    throw new Error(
      `direct-api: agent file not found at ${agentPath}. ` +
        "Run Legion: Initialize Repository first."
    );
  }

  // 2. Append skill files referenced in the agent's ## References section
  const skillRefs = extractSkillRefs(systemPrompt);
  const skillContents: string[] = [];
  for (const ref of skillRefs) {
    const refPath = path.join(repoRoot, ".cursor", ref.replace(/^\//, ""));
    try {
      const content = await fs.readFile(refPath, "utf8");
      skillContents.push(`\n\n<!-- skill: ${ref} -->\n${content}`);
    } catch {
      // Skill file missing — skip, don't abort.
    }
  }
  const fullSystem = systemPrompt + skillContents.join("");

  // 3. Call the configured LLM provider
  const text = await callLlm(llmConfig, fullSystem, JSON.stringify(payload, null, 2));

  // 4. Parse the agent's JSON response (may be wrapped in chatter/markdown)
  return parseResponse(text);
}

/** Extract skill/reference file paths from an agent's ## References section. */
function extractSkillRefs(agentContent: string): string[] {
  const refs: string[] = [];
  // Match markdown links like [label](path) or bare paths under ## References
  const section = agentContent.match(/##\s+References[\s\S]*?(?=^##|\z)/m)?.[0] ?? "";
  const linkRe = /\[.*?\]\(([^)]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(section)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

/** Simple HTTPS POST using Node's built-in https module (no npm dependency). */
function httpsPost(
  hostname: string,
  path_: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: path_,
        method: "POST",
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Anthropic HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseResponse(stdoutOrContent: string): InvocationResponse {
  // The Angel may emit JSON with surrounding chatter. Try to extract the JSON object.
  const trimmed = stdoutOrContent.trim();
  // Fast path: pure JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Slow path: find the first `{` and last `}` and try.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch (e) {
        throw new Error(
          `Could not parse agent response as JSON: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    throw new Error("Agent response did not contain a JSON object.");
  }
}
