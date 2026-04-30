import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import type { InvocationPayload } from "../types/payload";
import type { InvocationResponse } from "../types/response";

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
    const { stdout } = await exec(
      cliPath,
      ["agent", agentName, "--input", inputPath],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }
    );
    return parseResponse(stdout);
  } finally {
    fs.unlink(inputPath).catch(() => undefined);
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
  _agentName: string,
  _payload: InvocationPayload,
  config: vscode.WorkspaceConfiguration
): Promise<InvocationResponse> {
  const apiKey =
    config.get<string>("anthropicApiKey") ||
    process.env.LEGION_ANTHROPIC_API_KEY ||
    "";
  if (!apiKey) {
    throw new Error(
      "legion.anthropicApiKey or LEGION_ANTHROPIC_API_KEY required for direct-anthropic-api mode."
    );
  }
  // TODO v0.2.0:
  //  1. Read .cursor/agents/<agentName>.md (the Angel) for the system prompt.
  //  2. Read every file referenced in the Angel's "References to skill files" section,
  //     concatenated into the system context.
  //  3. POST /v1/messages with model=claude-sonnet-X, system=<above>, user=<JSON of payload>.
  //  4. Parse model response (it should return a JSON object matching InvocationResponse).
  //  5. Return the parsed response.
  //  Add @anthropic-ai/sdk to package.json dependencies for v0.2.0.
  throw new Error(
    "direct-anthropic-api mode is a v0.2.0 stub. Use cursor-cli or queue-file mode for v0.1.0."
  );
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
