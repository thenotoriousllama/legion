import * as vscode from "vscode";
import * as https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import type { InvocationPayload } from "../types/payload";
import type { InvocationResponse } from "../types/response";
import { callLlm, type LlmConfig } from "./llmClient";

const exec = promisify(execFile);

export type InvocationMode = "cursor-cli" | "queue-file" | "direct-anthropic-api";

/**
 * Invoke a Cursor agent (wiki-guardian, library-guardian, etc.) with a
 * structured payload. Mode is read from the `legion.agentInvocationMode` setting
 * — one of cursor-cli (default), queue-file, or direct-anthropic-api.
 */
export async function invokeAgent(
  agentName: string,
  payload: InvocationPayload,
  repoRoot: string,
  _context: vscode.ExtensionContext
): Promise<InvocationResponse> {
  const config = vscode.workspace.getConfiguration("legion");
  const mode = config.get<InvocationMode>("agentInvocationMode", "cursor-cli");

  switch (mode) {
    case "cursor-cli":
      return invokeCursorCli(agentName, payload, repoRoot, config);
    case "queue-file":
      return invokeQueueFile(agentName, payload, repoRoot);
    case "direct-anthropic-api":
      return invokeAnthropicApi(agentName, payload, config);
    default:
      throw new Error(`Unknown agentInvocationMode: ${mode}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode 1: cursor-cli (default)
// ──────────────────────────────────────────────────────────────────────────────

async function invokeCursorCli(
  agentName: string,
  payload: InvocationPayload,
  repoRoot: string,
  config: vscode.WorkspaceConfiguration
): Promise<InvocationResponse> {
  const cliPath = config.get<string>("cursorCliPath", "cursor");
  const queueDir = path.join(repoRoot, ".legion", "queue");
  await fs.mkdir(queueDir, { recursive: true });
  const inputPath = path.join(queueDir, `cli-input-${Date.now()}.json`);
  await fs.writeFile(inputPath, JSON.stringify(payload));
  try {
    // NOTE: Cursor's headless CLI surface for invoking a specific subagent is
    // still evolving. The current best-known incantation is below; if your
    // Cursor version differs, override `legion.cursorCliPath` or switch to
    // `legion.agentInvocationMode = "queue-file"`.
    const args = ["agent", agentName, "--input", inputPath];
    let result: { stdout: string; stderr: string };
    if (process.platform === "win32") {
      // Cursor's CLI on Windows ships as `cursor.cmd` (a batch shim). Two
      // independent things make a bare `execFile("cursor", ...)` fail:
      //
      //   1. CVE-2024-27980 ("BatBadBut", April 2024) — Node 20.12.2+ refuses
      //      to spawn .bat / .cmd files via execFile/spawn unless `shell: true`
      //      is set, even with an absolute path.
      //   2. Cursor's extension host inherits PATH from when Cursor was
      //      launched. If the cursor bin dir was added to PATH after Cursor
      //      started, the host won't see it until Cursor is fully restarted.
      //
      // We invoke cmd.exe explicitly with hand-quoted args, using
      // `windowsVerbatimArguments` so Node doesn't re-escape our quoting via
      // the standard CRT rules. cmd.exe then handles .cmd extension lookup
      // through PATH correctly.
      const cmdLine = [cliPath, ...args].map(quoteWinShellArg).join(" ");
      result = await exec("cmd.exe", ["/d", "/s", "/c", cmdLine], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
        windowsVerbatimArguments: true,
      });
    } else {
      result = await exec(cliPath, args, {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    return parseResponse(result.stdout);
  } catch (err) {
    if (err instanceof Error && isCommandNotFoundError(err)) {
      throw new Error(buildCliNotFoundMessage(cliPath, err));
    }
    throw err;
  } finally {
    fs.unlink(inputPath).catch(() => undefined);
  }
}

/**
 * Quote an argument for cmd.exe consumption. Wraps the value in double quotes
 * if it contains whitespace or quote characters, and doubles internal quotes
 * per cmd.exe's parsing rules. Tuned for our argument shape (no `%`, no `^`,
 * no `&|<>` metacharacters in real-world payloads — guardian names are
 * validated identifiers and inputPath is a timestamped JSON file under
 * `.legion/queue/` inside the repo root).
 */
function quoteWinShellArg(arg: string): string {
  if (!arg) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Recognize Node's spawn "binary not found" error across platforms and shells.
 * On POSIX it's ENOENT; via cmd.exe it's "is not recognized as an internal or
 * external command"; via PowerShell it's "cannot find the path specified".
 */
function isCommandNotFoundError(err: Error): boolean {
  return (
    /ENOENT/.test(err.message) ||
    /is not recognized as an internal or external command/i.test(err.message) ||
    /cannot find/i.test(err.message)
  );
}

/**
 * Produce a clear, actionable error message when the Cursor CLI can't be
 * located or executed. Replaces the raw `spawn cursor ENOENT` that Node
 * surfaces by default.
 */
function buildCliNotFoundMessage(cliPath: string, originalErr: Error): string {
  const winHint =
    `On Windows, open Cursor's Command Palette and run ` +
    `"Shell Command: Install 'cursor' command in PATH", then RESTART CURSOR ` +
    `(the extension host caches PATH on launch — settings changes alone are ` +
    `not enough). Alternatively, set 'legion.cursorCliPath' in Settings to ` +
    `the absolute path of cursor.cmd ` +
    `(typically C:\\Program Files\\cursor\\resources\\app\\bin\\cursor.cmd).`;
  const unixHint =
    `Make sure 'cursor' is on PATH, or set 'legion.cursorCliPath' in Settings ` +
    `to the absolute path of the binary.`;
  return (
    `Legion could not invoke the Cursor CLI ('${cliPath}'). ` +
    (process.platform === "win32" ? winHint : unixHint) +
    ` As a last resort, switch 'legion.agentInvocationMode' to ` +
    `'direct-anthropic-api' (requires 'legion.anthropicApiKey' or the ` +
    `LEGION_ANTHROPIC_API_KEY env var) — this bypasses the CLI entirely and ` +
    `is the recommended path for Windows + VS Code users per the README.\n\n` +
    `Original error: ${originalErr.message}`
  );
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
