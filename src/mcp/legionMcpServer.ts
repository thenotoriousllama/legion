#!/usr/bin/env node
/**
 * Legion MCP Server — exposes Legion tools to any MCP host (Claude Code, Cursor, Cline, etc.)
 * over the standard stdio JSON-RPC 2.0 transport.
 *
 * Registration:
 *   Claude Code: claude mcp add-json legion '{"type":"stdio","command":"node","args":["/path/to/dist/mcp-server.js"]}'
 *   Cursor: add to settings.json mcpServers block
 *
 * All logs go to process.stderr (stdout is reserved for JSON-RPC frames).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as path from "path";

import {
  handleDocument,
  handleFindEntity,
  handleGetEntity,
  handleGetContext,
  handleAutoresearch,
  handleDrainAgenda,
} from "./toolHandlers.js";

// ── Repo-root validation ───────────────────────────────────────────────────────
//
// The MCP server accepts a caller-supplied `repoRoot` parameter.  Without
// validation a malicious MCP host could pass `repoRoot: "/"` and trigger a
// full filesystem walk whose contents are then sent to the Anthropic API.
//
// Mitigation strategy (defence-in-depth):
//   1. `repoRoot` must be absolute and fully-normalised (no `..` segments).
//   2. If LEGION_REPO_ROOT is set, `repoRoot` must equal or be a sub-directory
//      of that value.  This is the recommended production configuration — set
//      LEGION_REPO_ROOT in the MCP server launch command to lock it down.
//   3. If LEGION_REPO_ROOT is not set, repoRoot defaults to process.cwd() and
//      any caller-supplied value that is NOT equal to or inside process.cwd()
//      triggers a logged warning (non-fatal, to avoid breaking existing flows).

function validateRepoRoot(candidate: string): string {
  const normalized = path.normalize(candidate);

  if (!path.isAbsolute(normalized)) {
    throw new Error(`Legion MCP: repoRoot must be an absolute path (got: "${candidate}")`);
  }

  const allowedRoot = process.env.LEGION_REPO_ROOT
    ? path.normalize(process.env.LEGION_REPO_ROOT)
    : path.normalize(process.cwd());

  const isAllowed =
    normalized === allowedRoot ||
    normalized.startsWith(allowedRoot + path.sep);

  if (!isAllowed) {
    if (process.env.LEGION_REPO_ROOT) {
      // Hard block when an explicit allowed root is configured.
      throw new Error(
        `Legion MCP: repoRoot "${normalized}" is outside LEGION_REPO_ROOT "${allowedRoot}". ` +
        `Update LEGION_REPO_ROOT to include this path if this is intentional.`
      );
    } else {
      // Soft warning when no explicit root is configured (preserves backward compatibility
      // for multi-repo setups).  Operators should set LEGION_REPO_ROOT to harden this.
      process.stderr.write(
        `[Legion MCP] WARNING: repoRoot "${normalized}" is outside process.cwd() "${allowedRoot}". ` +
        `Set LEGION_REPO_ROOT env var to restrict allowed roots.\n`
      );
    }
  }

  return normalized;
}



const server = new Server(
  { name: "legion", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool schemas ───────────────────────────────────────────────────────────────

const RepoRootArg = z.string().optional().describe("Absolute path to repo root. Defaults to process.cwd().");

const TOOLS = [
  {
    name: "legion_document",
    description: "Run a full Legion Document pass — extract all code entities and file them as wiki pages.",
    inputSchema: { type: "object" as const, properties: { repoRoot: { type: "string", description: "Absolute path to repo root. Defaults to process.cwd()." } } },
  },
  {
    name: "legion_update",
    description: "Run an incremental Legion Update pass — re-index only changed files.",
    inputSchema: { type: "object" as const, properties: { repoRoot: { type: "string" } } },
  },
  {
    name: "legion_find_entity",
    description: "Search Legion wiki pages by semantic query. Returns top N pages ranked by relevance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query." },
        topN: { type: "number", description: "Max results to return. Default 10." },
        repoRoot: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "legion_get_entity",
    description: "Read the full content of a Legion wiki page by entity name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Entity name, e.g. 'JwtService'." },
        repoRoot: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "legion_get_context",
    description: "Read wiki/hot.md — a snapshot of the most recently active wiki entities.",
    inputSchema: { type: "object" as const, properties: { repoRoot: { type: "string" } } },
  },
  {
    name: "legion_autoresearch",
    description: "Research a specific topic and write wiki pages for discovered knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", description: "Topic to research." },
        rounds: { type: "number", description: "Research depth (1-5). Default 2." },
        repoRoot: { type: "string" },
      },
      required: ["topic"],
    },
  },
  {
    name: "legion_drain_agenda",
    description: "Process all items in wiki/research-agenda.md.",
    inputSchema: { type: "object" as const, properties: { repoRoot: { type: "string" } } },
  },
];

// ── Tool registration ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

const CallArgsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  const rawRoot = (typeof a["repoRoot"] === "string" ? a["repoRoot"] : null) ?? process.env.LEGION_REPO_ROOT ?? process.cwd();
  let repoRoot: string;
  try {
    repoRoot = validateRepoRoot(rawRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Legion MCP] Rejected repoRoot: ${msg}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }

  process.stderr.write(`[Legion MCP] tool=${name} repoRoot=${repoRoot}\n`);

  try {
    let result: unknown;

    switch (name) {
      case "legion_document": {
        result = await handleDocument(repoRoot, "document");
        break;
      }
      case "legion_update": {
        result = await handleDocument(repoRoot, "update");
        break;
      }
      case "legion_find_entity": {
        const queryArg = z.string().parse(a["query"]);
        const topN = typeof a["topN"] === "number" ? a["topN"] : 10;
        result = await handleFindEntity(repoRoot, queryArg, topN);
        break;
      }
      case "legion_get_entity": {
        const nameArg = z.string().parse(a["name"]);
        result = await handleGetEntity(repoRoot, nameArg);
        break;
      }
      case "legion_get_context": {
        result = await handleGetContext(repoRoot);
        break;
      }
      case "legion_autoresearch": {
        const topic = z.string().parse(a["topic"]);
        const rounds = typeof a["rounds"] === "number" ? a["rounds"] : 2;
        result = await handleAutoresearch(repoRoot, topic, rounds);
        break;
      }
      case "legion_drain_agenda": {
        result = await handleDrainAgenda(repoRoot);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Legion MCP] Error in ${name}: ${message}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

process.on("SIGTERM", () => { process.exit(0); });
process.on("SIGINT",  () => { process.exit(0); });

// ── Start ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[Legion MCP] Server started — listening on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[Legion MCP] Fatal: ${String(err)}\n`);
  process.exit(1);
});

// Keep TypeScript happy with unused zod import used by other handlers
void RepoRootArg;
void CallArgsSchema;
