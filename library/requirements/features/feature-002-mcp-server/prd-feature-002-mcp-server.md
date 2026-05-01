# Feature #002: MCP Server — Legion Tools for Claude Code, Cursor, and Any MCP Host

> **Legion VS Code Extension** — Feature PRD #002 of 6
>
> **Status:** Ready for implementation
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Phase Overview

### Goals

Model Context Protocol (MCP) has become the dominant standard for exposing tools to AI coding agents. Cursor, Claude Code, Cline, Windsurf, and similar hosts all speak MCP over stdio. Legion already performs sophisticated code-entity extraction, wiki management, semantic search, and research automation — capabilities that AI agents desperately need when working inside a codebase. Today those capabilities are only accessible via VS Code commands or the `legionCli.ts` headless CLI.

This PRD wraps Legion's core capabilities as a standalone MCP server so any MCP host can call Legion tools mid-conversation: a Claude Code session can run `legion_find_entity` to look up the `JwtService` wiki page, trigger a `legion_document` pass after writing new code, or have the agent auto-drain the research agenda. The server is a thin JSON-RPC 2.0 stdio layer over the existing `legionCli.ts` business logic — no new agent logic is introduced, just a protocol adapter.

The output is a compiled `dist/mcp-server.js` (built by a dedicated esbuild target) that users register once per machine in their MCP host. Claude Code registers it with a single `claude mcp add-json` command; Cursor registers it in `mcpServers` in `settings.json`.

### Scope

- New entry point: `src/mcp/legionMcpServer.ts`
- Transport: stdio (MCP standard for local process-based servers)
- Protocol: JSON-RPC 2.0 over stdin/stdout, no HTTP layer
- 7 tools exposed: `legion_document`, `legion_update`, `legion_find_entity`, `legion_get_entity`, `legion_get_context`, `legion_autoresearch`, `legion_drain_agenda`
- Compiled separately: `"compile:mcp"` npm script via esbuild
- `repoRoot` defaults to `process.cwd()` in all tools when not supplied
- Registration docs for Claude Code and Cursor in `README.md`

### Out of scope

- HTTP/SSE transport (remote MCP servers) — the Legion MCP server is always local; HTTP transport is a future PRD
- Authentication / per-tool auth — stdio MCP servers inherit the process owner's identity; no auth layer needed
- New Legion business logic — this is purely a protocol wrapper over existing `legionCli.ts` functions
- Streaming tool responses — MCP spec supports streaming but Legion's current outputs are complete blobs; add streaming in a follow-up if needed

### Dependencies

- **Blocks:** none
- **Blocked by:** `feature-001-semantic-search` (the `legion_find_entity` tool uses the new semantic search module; can ship without it using fuzzy fallback, but semantic results are superior)
- **External:** MCP host registration. `@modelcontextprotocol/sdk` npm package (current stable: `1.x`).

---

## User Stories

### US-2.1 — Agent-triggered document pass

**As a** Claude Code / Cursor agent working inside a repo, **I want to** call `legion_document` after writing new TypeScript code, **so that** the wiki pages for the newly created entities are generated before I reference them in subsequent steps.

**Acceptance criteria:**
- AC-2.1.1 Given the MCP server is running and registered, when the agent calls `legion_document` with `{repoRoot: "/path/to/repo"}`, then the full Document pass runs and the tool returns `{status: "ok", pagesCreated: N, pagesUpdated: M, durationMs: D}`.
- AC-2.1.2 Given the Document pass fails (e.g., Anthropic API key missing), the tool returns a JSON-RPC error response with `code: -32000` and a descriptive `message`.
- AC-2.1.3 Given `repoRoot` is omitted, the server uses `process.cwd()` as the root.

### US-2.2 — Semantic entity lookup

**As a** AI agent mid-conversation, **I want to** call `legion_find_entity` to look up a code entity by semantic description, **so that** I can retrieve the canonical Legion wiki page for that entity and ground my next steps in the actual codebase documentation.

**Acceptance criteria:**
- AC-2.2.1 Given a valid query string, `legion_find_entity` returns an array of up to `topN` results, each with `{name, type, path, score, firstBody}`.
- AC-2.2.2 Results are ranked by relevance score (semantic if Cohere key is present, TF-IDF otherwise).
- AC-2.2.3 If the wiki index does not exist, the tool returns an informative message suggesting the user run `legion_document` first.

### US-2.3 — Entity page read

**As a** AI agent, **I want to** call `legion_get_entity` with an entity name, **so that** I can read the full wiki page content (frontmatter, body, code snippets, backlinks) and use it as grounded context.

**Acceptance criteria:**
- AC-2.3.1 Given an entity name that exists in the wiki, `legion_get_entity` returns the full markdown content of the page.
- AC-2.3.2 Given an entity name that does not exist, the tool returns `{found: false}` rather than an error.
- AC-2.3.3 Entity lookup is case-insensitive and attempts partial match if exact match fails.

### US-2.4 — Research and agenda drain

**As a** AI agent running an autonomous research loop, **I want to** call `legion_autoresearch` and `legion_drain_agenda` to trigger Legion's built-in research facilities, **so that** the wiki knowledge base grows without me having to implement a research loop myself.

**Acceptance criteria:**
- AC-2.4.1 `legion_autoresearch` runs the autoresearch command for the specified topic and returns a summary of pages created/updated.
- AC-2.4.2 `legion_drain_agenda` processes all pending items in `wiki/research-agenda.md` and returns the count of items processed.
- AC-2.4.3 Both tools respect the `repoRoot` parameter.

### US-2.5 — One-command registration in Claude Code

**As a** developer, **I want to** register the Legion MCP server with a single CLI command, **so that** I don't need to manually edit configuration files.

**Acceptance criteria:**
- AC-2.5.1 After running `claude mcp add-json legion '{"type":"stdio","command":"node","args":["/abs/path/to/dist/mcp-server.js"]}'`, the tools are available in my Claude Code session.
- AC-2.5.2 The `README.md` contains exact registration commands for Claude Code, Cursor (`settings.json` snippet), and generic MCP hosts.

---

## Data Model Changes

None.

---

## API / Endpoint Specs

### MCP Protocol — Tool List (announced on `initialize`)

The server announces the following tools in its `initialize` response:

```json
{
  "tools": [
    {
      "name": "legion_document",
      "description": "Run a full Legion Document pass — extract all code entities and file them as wiki pages.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repoRoot": { "type": "string", "description": "Absolute path to repo root. Defaults to process.cwd()." }
        }
      }
    },
    {
      "name": "legion_update",
      "description": "Run an incremental Legion Update pass — re-index only changed files.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repoRoot": { "type": "string" }
        }
      }
    },
    {
      "name": "legion_find_entity",
      "description": "Search Legion wiki pages by semantic query. Returns top N pages ranked by relevance.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query":    { "type": "string", "description": "Natural language search query." },
          "topN":     { "type": "number", "description": "Max results to return. Default 10." },
          "repoRoot": { "type": "string" }
        },
        "required": ["query"]
      }
    },
    {
      "name": "legion_get_entity",
      "description": "Read the full content of a Legion wiki page by entity name.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name":     { "type": "string", "description": "Entity name, e.g. 'JwtService'." },
          "repoRoot": { "type": "string" }
        },
        "required": ["name"]
      }
    },
    {
      "name": "legion_get_context",
      "description": "Read wiki/hot.md for a snapshot of the most recently active wiki entities.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repoRoot": { "type": "string" }
        }
      }
    },
    {
      "name": "legion_autoresearch",
      "description": "Research a specific topic and write wiki pages for discovered knowledge.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "topic":    { "type": "string", "description": "Topic to research." },
          "rounds":   { "type": "number", "description": "Research depth (1-5). Default 2." },
          "repoRoot": { "type": "string" }
        },
        "required": ["topic"]
      }
    },
    {
      "name": "legion_drain_agenda",
      "description": "Process all items in wiki/research-agenda.md.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repoRoot": { "type": "string" }
        }
      }
    }
  ]
}
```

### JSON-RPC 2.0 Tool Call / Response

**Tool call (host → server):**

```json
{
  "jsonrpc": "2.0",
  "id": "call-42",
  "method": "tools/call",
  "params": {
    "name": "legion_find_entity",
    "arguments": { "query": "JWT token validation", "topN": 5 }
  }
}
```

**Tool response (server → host):**

```json
{
  "jsonrpc": "2.0",
  "id": "call-42",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[{\"name\":\"JwtService\",\"type\":\"Class\",\"path\":\"library/knowledge-base/wiki/classes/JwtService.md\",\"score\":0.91,\"firstBody\":\"Validates bearer tokens against the HMAC-SHA256 secret stored in…\"}]"
      }
    ]
  }
}
```

**Error response:**

```json
{
  "jsonrpc": "2.0",
  "id": "call-42",
  "error": {
    "code": -32000,
    "message": "Legion Document pass failed: ANTHROPIC_API_KEY is not set"
  }
}
```

---

## UI/UX Description

The MCP server has no VS Code UI — it is a headless process. The user experience is:

1. Developer installs Legion extension and builds the MCP server (`npm run compile:mcp`).
2. Developer runs the registration command once in their terminal (Claude Code) or adds the `settings.json` snippet (Cursor).
3. In subsequent AI agent sessions, the agent sees Legion tools in its tool palette and calls them naturally.

**Registration snippets documented in `README.md`:**

```bash
# Claude Code
claude mcp add-json legion '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/dist/mcp-server.js"]
}'

# Verify
claude mcp list
```

```jsonc
// Cursor — add to User Settings (settings.json)
{
  "mcpServers": {
    "legion": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp-server.js"]
    }
  }
}
```

---

## Technical Considerations

### MCP SDK

Use the official `@modelcontextprotocol/sdk` package rather than hand-rolling the JSON-RPC loop. The SDK provides `StdioServerTransport`, `McpServer`, and the `tool()` registration helper.

```typescript
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'legion',
  version: '1.0.0',
});

server.tool(
  'legion_find_entity',
  { query: z.string(), topN: z.number().optional(), repoRoot: z.string().optional() },
  async ({ query, topN = 10, repoRoot = process.cwd() }) => {
    const results = await legionFindEntity(repoRoot, query, topN);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Process lifecycle

The MCP server process lives as long as the MCP host keeps it open. It should:
- Not write anything to stdout except JSON-RPC messages (use `process.stderr` for logs)
- Handle `SIGTERM` / `SIGINT` gracefully (close the transport, exit 0)
- Not start any VS Code extension host APIs (it runs as a plain Node.js process)

### esbuild target

```json
// package.json scripts
{
  "compile:mcp": "esbuild src/mcp/legionMcpServer.ts --bundle --outfile=dist/mcp-server.js --format=cjs --platform=node --external:vscode"
}
```

The `--external:vscode` flag is critical: Legion's business logic currently imports some VS Code APIs (e.g., workspace configuration). For the MCP server build, any VS Code-specific calls must be guarded with conditional imports or abstracted behind injectable interfaces. A light adapter pattern (pass config as a plain object from `process.env` / a config file rather than `vscode.workspace.getConfiguration`) is sufficient.

### Config resolution in the MCP process

Since `vscode.workspace.getConfiguration` is not available in the MCP server process, the server reads configuration from:

1. Environment variables (`LEGION_ANTHROPIC_API_KEY`, `LEGION_COHERE_API_KEY`, etc.)
2. `.legion/config.json` in the resolved `repoRoot`
3. Hardcoded defaults

A `resolveConfig(repoRoot: string): LegionConfig` utility function (new or extracted from existing code) handles this for both the VS Code extension path and the MCP server path.

### Concurrency

Each tool call is handled sequentially in the current implementation. A full `legion_document` call can take 30–120 seconds for a large repo. The MCP host must not time out during this window — document this in the README and suggest the host use a long tool timeout. If the host does time out, Legion logs the partial progress and the user can re-call `legion_update` to pick up where it left off.

---

## Files Touched

### New files

- `src/mcp/legionMcpServer.ts` — MCP server entry point; tool registrations; stdio transport setup
- `src/mcp/mcpConfig.ts` — `resolveConfig()` for env-var + config-file based configuration (VS Code-free)
- `src/mcp/toolHandlers.ts` — one async function per tool, thin wrappers over `legionCli.ts` operations
- `src/mcp/legionMcpServer.test.ts` — integration tests using in-process MCP client

### Modified files

- `package.json` — add `@modelcontextprotocol/sdk` dependency; add `"compile:mcp"` npm script; add `"prepublish"` hook to run `compile:mcp`
- `src/cli/legionCli.ts` — extract command implementations into importable async functions (if not already done) so `toolHandlers.ts` can import them without CLI-specific argument parsing
- `.vscodeignore` — add `dist/mcp-server.js` to ensure it is included in the VSIX (or excluded if distributed separately)
- `README.md` — add "MCP Server" section with registration commands, tool reference table, and troubleshooting guide

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — Config resolution and tool handler stubs

Extract VS Code-specific config reads from `legionCli.ts` into injectable interfaces. Create `mcpConfig.ts` that resolves config from env vars and `.legion/config.json`. Create `toolHandlers.ts` with all 7 handler stubs that return `{status: "stub"}`.

### Phase 2 — MCP server with stdio transport

Wire `legionMcpServer.ts` using `@modelcontextprotocol/sdk`. Register all 7 tools with Zod input schemas. Connect `StdioServerTransport`. Test with `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | node dist/mcp-server.js`.

### Phase 3 — Implement tool handlers

Connect each tool stub to the real `legionCli.ts` functions:
- `legion_document` → `runDocumentPass(repoRoot, config)`
- `legion_update` → `runUpdatePass(repoRoot, config)`
- `legion_find_entity` → `semanticSearch.query()` (from feature-001) or fuzzy fallback
- `legion_get_entity` → `wikiIndex.findByName(name, repoRoot)`
- `legion_get_context` → `fs.readFile(path.join(repoRoot, 'library/knowledge-base/wiki/hot.md'))`
- `legion_autoresearch` → `runAutoResearch(topic, rounds, repoRoot, config)`
- `legion_drain_agenda` → `runDrainAgenda(repoRoot, config)`

### Phase 4 — esbuild pipeline, README, and smoke tests

Add `compile:mcp` script. Verify the bundle starts correctly in a fresh shell with no VS Code process. Add smoke-test shell script `scripts/smoke-test-mcp.sh` that exercises each tool over stdio.

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| `legion_find_entity` round-trip latency (hot cache) | ≤ 100ms | Instrument tool handler |
| `legion_document` on 500-entity repo | ≤ 120s | Log `durationMs` in tool response |
| Tool registration smoke test pass rate | 100% | `scripts/smoke-test-mcp.sh` in CI |
| Zero stdout pollution (non-JSON-RPC output) | 0 violations | grep stdout for non-JSON lines in smoke test |

---

## Open Questions

- **Q1:** Should the MCP server be distributed as part of the VSIX or as a separate npm package (`@legion/mcp`)? **Blocks:** distribution decision. **Current plan:** bundle in VSIX (`dist/mcp-server.js`), users reference the VSIX-extracted path or the globally installed extension path.
- **Q2:** Should `legion_document` stream progress events as MCP "notifications" rather than blocking until complete? MCP supports server-sent notifications. **Blocks:** UX decision. **Current plan:** blocking response in Phase 1, streaming notifications as follow-up.
- **Q3:** How should the MCP server handle concurrent tool calls from the same host session? The current Legion implementation is not thread-safe for simultaneous Document + Update calls. **Plan:** serialize tool calls with a simple in-process mutex.

---

## Risks and Open Questions

- **Risk:** VS Code API imports (`vscode.workspace`, `vscode.window`) are scattered throughout `legionCli.ts`. Extracting them will require a refactor. **Mitigation:** introduce a thin `ILegionContext` interface; the VS Code extension provides a real implementation, the MCP server provides a plain-object implementation. This refactor is bounded to the config-reading and output-writing paths.
- **Risk:** MCP SDK API surface changes between versions. **Mitigation:** pin `@modelcontextprotocol/sdk` to a specific major version in `package.json`.
- **Risk:** Agent hosts have varying tool timeout configurations. A 120-second Document pass may be cut off. **Mitigation:** document the long-running nature in tool descriptions; suggest the agent call `legion_update` for incremental passes rather than `legion_document` in time-sensitive contexts.

---

## Related

- [`feature-001-semantic-search/prd-feature-001-semantic-search.md`](../feature-001-semantic-search/prd-feature-001-semantic-search.md) — `legion_find_entity` uses the semantic search module
- [`feature-004-scheduled-research/prd-feature-004-scheduled-research.md`](../feature-004-scheduled-research/prd-feature-004-scheduled-research.md) — `legion_drain_agenda` tool surfaces the agenda drain capability to agents
- [`feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md`](../feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md) — `repoRoot` resolution strategy must align between MCP and VS Code paths
