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

import {
  handleDocument,
  handleFindEntity,
  handleGetEntity,
  handleGetContext,
  handleAutoresearch,
  handleDrainAgenda,
} from "./toolHandlers.js";

// ── Server definition ──────────────────────────────────────────────────────────

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
  const repoRoot = (typeof a["repoRoot"] === "string" ? a["repoRoot"] : null) ?? process.env.LEGION_REPO_ROOT ?? process.cwd();

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
