# Feature #005: Multi-workspace and Monorepo Support

> **Legion VS Code Extension** — Feature PRD #005 of 6
>
> **Status:** Ready for implementation
> **Priority:** P1
> **Effort:** L (8-24h)
> **Schema changes:** None

---

## Phase Overview

### Goals

Legion currently operates under a single-root assumption: every command resolves its operating directory as `vscode.workspace.workspaceFolders[0].uri.fsPath`. This works for single-package repositories but fails in two increasingly common setups:

1. **Multi-root workspaces** — VS Code workspaces where the developer has opened multiple separate repositories at once (e.g., `api/` and `web/` as sibling roots). Legion currently ignores all roots except the first.

2. **Monorepos** — A single repo root (`vibecode-legion/`) containing multiple packages (`packages/api`, `packages/web`, `packages/shared`). Each package has its own TypeScript source tree, but Legion currently scans only the root and produces a single undifferentiated wiki. Entity names from `packages/api` collide with identically named entities in `packages/web`.

This PRD eliminates the `workspaceFolders[0]` single-root assumption across the entire codebase, introducing a shared `resolveRepoRoot()` helper called by all commands, a user-facing root picker for multi-root workspaces, and a `legion.scanRoots` setting for monorepo sub-path scanning. The wiki output stays in a single shared `library/` at the repo root, with each entity page stamped with the `scan_root` tag for provenance.

### Scope

- Extract a shared `resolveRepoRoot(context): Promise<string>` helper (new file: `src/util/repoRoot.ts`) that encapsulates all root-resolution logic
- When `workspaceFolders.length > 1`: show a QuickPick "Which workspace root?" before each command; persist the selection for the VS Code session via `context.workspaceState`
- New setting: `legion.activeRoot` (string, default `""`) — a pinned workspace folder path; skips the QuickPick when set
- New setting: `legion.scanRoots` (string[], default `[]`) — monorepo sub-paths within the primary repo root, each scanned as a separate module group
- New setting: `legion.wikiRoot` (string, default `""`) — overrides the default wiki output path (`<repoRoot>/library/knowledge-base/wiki/`)
- Update all 12 commands that use `folders[0]` to use `resolveRepoRoot()` instead
- Monorepo mode: `planChunks()` partitions source files by `scan_root`; entity pages gain a `scan_root` frontmatter tag
- `publishFederationManifest` stamps entity pages with the `scan_root` when monorepo mode is active
- MCP server `repoRoot` parameter takes precedence over all VS Code workspace logic

### Out of scope

- Cross-root wiki federation (merging wikis from multiple separate repos into one index) — separate PRD
- Automatic monorepo detection (e.g., detecting `pnpm-workspace.yaml` or `nx.json`) — Phase 2 enhancement
- Per-root separate `library/` directories — the design decision is one shared `library/` at the primary root; per-root libraries are out of scope
- Git worktree support — treated as a regular multi-root workspace for now

### Dependencies

- **Blocks:** none
- **Blocked by:** none
- **Unblocks:** [`feature-001-semantic-search/prd-feature-001-semantic-search.md`](../feature-001-semantic-search/prd-feature-001-semantic-search.md) — `buildIndex` uses `repoRoot`; will work correctly once `resolveRepoRoot` is used consistently
- **External:** none

---

## User Stories

### US-5.1 — Multi-root workspace picker

**As a** developer with a multi-root VS Code workspace (api + web), **I want** Legion to ask me which root to operate on before running a command, **so that** I can Document or Update just the `api` package without affecting the `web` package's wiki.

**Acceptance criteria:**
- AC-5.1.1 Given `workspaceFolders.length > 1` and `legion.activeRoot` is not set, when I run any Legion command (Document, Update, Find Entity, etc.), then a QuickPick appears: "Which workspace root? [api/] [web/] [both]".
- AC-5.1.2 Selecting a root persists for the VS Code session (subsequent commands skip the QuickPick until VS Code is restarted or the active root is cleared).
- AC-5.1.3 Given "both" is selected, Legion runs the command sequentially on all roots.
- AC-5.1.4 Given `legion.activeRoot` is set to `/path/to/api`, all commands use that path without showing the QuickPick.

### US-5.2 — Pin active root via setting

**As a** developer who always works in the `api` root, **I want to** pin `legion.activeRoot` to the `api` folder path, **so that** Legion never shows the root picker and always operates on my preferred root.

**Acceptance criteria:**
- AC-5.2.1 Given `legion.activeRoot = "/abs/path/to/api"` is set in workspace settings, when any Legion command runs, then it uses that path without showing a QuickPick.
- AC-5.2.2 Given `legion.activeRoot` contains a relative path (e.g., `"./packages/api"`), it is resolved relative to `workspaceFolders[0]`.
- AC-5.2.3 A "Clear active root" command (`legion.clearActiveRoot`) resets `legion.activeRoot` to `""` and returns to the QuickPick behaviour.

### US-5.3 — Monorepo sub-path scanning

**As a** developer in a monorepo with `packages/api`, `packages/web`, and `packages/shared`, **I want to** configure Legion to scan each sub-package separately, **so that** entity pages are tagged with their source package and name collisions between packages are surfaced rather than silently overwritten.

**Acceptance criteria:**
- AC-5.3.1 Given `legion.scanRoots = ["packages/api", "packages/web", "packages/shared"]`, when a Document pass runs, then `planChunks()` generates separate chunk groups for each sub-path.
- AC-5.3.2 Each entity page created in monorepo mode has a `scan_root: packages/api` frontmatter field.
- AC-5.3.3 If two packages define a function with the same name (e.g., `createUser`), their wiki pages are written to distinct paths: `wiki/functions/createUser--packages-api.md` and `wiki/functions/createUser--packages-web.md`, and a contradiction note is appended to the `wiki/log.md`.
- AC-5.3.4 Given `legion.scanRoots = []`, Legion behaves identically to the current single-root mode.

### US-5.4 — Custom wiki output directory

**As a** developer in a monorepo where the repo root is the package manager workspace root (not my code's root), **I want to** redirect Legion's wiki output to a custom path, **so that** the `library/` folder is co-located with the code it documents rather than at the workspace root.

**Acceptance criteria:**
- AC-5.4.1 Given `legion.wikiRoot = "./packages/docs/wiki"`, all Document/Update passes write entity pages to that path.
- AC-5.4.2 The custom `wikiRoot` is used consistently across all commands (Find Entity reads from it, Export reads from it, etc.).
- AC-5.4.3 Given `legion.wikiRoot = ""`, Legion uses the default `<repoRoot>/library/knowledge-base/wiki/` path.

### US-5.5 — MCP server root override

**As a** AI agent calling Legion MCP tools, **I want to** pass `repoRoot` explicitly on every tool call, **so that** I can target any workspace root in a multi-root setup without VS Code context.

**Acceptance criteria:**
- AC-5.5.1 Given the MCP server receives `legion_document` with `{repoRoot: "/abs/path/to/api"}`, then the Document pass runs on that path regardless of `workspaceFolders`.
- AC-5.5.2 Given `repoRoot` is omitted from an MCP tool call, the server uses `process.cwd()` as the fallback (unchanged from Feature 002 design).

---

## Data Model Changes

No database changes. Two new fields added to `.legion/config.json`:

```jsonc
{
  // existing fields...
  "scan_roots": ["packages/api", "packages/web", "packages/shared"],  // mirrors legion.scanRoots
  "wiki_root": "packages/docs/wiki"  // mirrors legion.wikiRoot; absent or "" = default
}
```

These are written by the `createSharedConfig` wizard when the user configures multi-root or monorepo mode. They serve as the persistent source of truth for the MCP server path (which cannot read VS Code workspace settings).

---

## API / Endpoint Specs

No HTTP API.

### Internal API — `src/util/repoRoot.ts`

```typescript
export interface RootResolutionOptions {
  /** VS Code ExtensionContext for workspaceState persistence. */
  context: vscode.ExtensionContext;
  /** If true, allows selecting "all roots" — returns all workspace folders. */
  allowAll?: boolean;
}

/**
 * Resolves the active repo root for a command invocation.
 *
 * Resolution order:
 * 1. `legion.activeRoot` setting (if non-empty, resolved to absolute path)
 * 2. Persisted session selection in `context.workspaceState`
 * 3. If `workspaceFolders.length === 1`, return it directly (no picker)
 * 4. If `workspaceFolders.length > 1`, show QuickPick; persist selection
 */
export async function resolveRepoRoot(options: RootResolutionOptions): Promise<string | string[]>;

/**
 * Clears the persisted session root selection.
 * Called by `legion.clearActiveRoot` command.
 */
export function clearSessionRoot(context: vscode.ExtensionContext): void;

/**
 * Resolves the wiki output directory for a given repo root.
 * Respects `legion.wikiRoot` setting or `.legion/config.json` `wiki_root` field.
 */
export function resolveWikiRoot(repoRoot: string): string;

/**
 * Returns the list of scan roots for monorepo mode.
 * Returns [repoRoot] if `legion.scanRoots` is empty.
 */
export function resolveScanRoots(repoRoot: string): string[];
```

---

## UI/UX Description

### QuickPick — Root selector

Appears before any Legion command when `workspaceFolders.length > 1` and no root is pinned:

```
Which workspace root?
────────────────────────────────────────────────
$(folder) api         /Users/dev/my-project/api
$(folder) web         /Users/dev/my-project/web
$(folder) shared      /Users/dev/my-project/shared
$(check)  All roots   Run on all workspace folders
```

- The QuickPick shows the folder name (short) and absolute path (description).
- "All roots" runs the command on each folder sequentially.
- The selection is persisted in `context.workspaceState` under key `legion.sessionActiveRoot`.
- A status bar item shows `$(folder) Legion: api` when a root is pinned, clicking it opens the QuickPick to switch.

### Status bar — Active root indicator

When `workspaceFolders.length > 1`:
- Status bar item (left side): `$(folder) Legion: api`
- Tooltip: "Click to switch Legion active root"
- Clicking opens the root QuickPick (same as choosing without a command)

### Settings UI

Three new settings in the "Legion > Workspace" group:

| Setting | Type | Default | Description |
|---|---|---|---|
| `legion.activeRoot` | string | `""` | Pin a specific workspace folder path for all Legion commands. Relative paths resolved from first workspace folder. |
| `legion.scanRoots` | array of strings | `[]` | Monorepo sub-paths to scan as separate module groups. Example: `["packages/api", "packages/web"]`. Empty = single-root mode. |
| `legion.wikiRoot` | string | `""` | Override default wiki output path. Default: `<repoRoot>/library/knowledge-base/wiki/`. |

---

## Technical Considerations

### Places that currently hardcode `workspaceFolders[0]`

A code audit identified 12 call sites across 8 files:

| File | Pattern |
|---|---|
| `src/extension.ts` | `folders[0].uri.fsPath` (3 occurrences) |
| `src/commands/document.ts` | `folders[0].uri.fsPath` |
| `src/commands/update.ts` | `folders[0].uri.fsPath` |
| `src/commands/findEntity.ts` | `folders[0].uri.fsPath` |
| `src/commands/getEntity.ts` | `folders[0].uri.fsPath` |
| `src/commands/drainAgenda.ts` | `folders[0].uri.fsPath` |
| `src/commands/createSharedConfig.ts` | `folders[0].uri.fsPath` |
| `src/cli/legionCli.ts` | `process.cwd()` — already correct for MCP; no change needed |

The refactor is mechanical: replace each occurrence with `await resolveRepoRoot({ context })`.

### Monorepo chunk partitioning

`planChunks()` currently collects all TypeScript source files under `repoRoot/src/`. In monorepo mode it runs the same collection pass for each entry in `resolveScanRoots(repoRoot)` and assigns each chunk a `scanRoot` tag:

```typescript
interface ChunkGroup {
  scanRoot: string;     // absolute path to the sub-package
  chunks:   Chunk[];
}

async function planMonorepoChunks(repoRoot: string): Promise<ChunkGroup[]> {
  const scanRoots = resolveScanRoots(repoRoot);
  return Promise.all(
    scanRoots.map(async (scanRoot) => ({
      scanRoot,
      chunks: await planChunks(scanRoot),
    }))
  );
}
```

The existing `documentPass.ts` orchestrator iterates over `ChunkGroup[]` rather than a flat `Chunk[]`, running the LLM extraction pass for each group and tagging resulting entities with `scan_root`.

### Name collision handling

When two scan roots produce an entity with the same type + name (e.g., `Class/UserService`), the wiki writer:

1. Writes the first entity to `wiki/classes/UserService.md` (standard path)
2. Detects the collision when attempting to write the second entity (file already exists with different `scan_root`)
3. Writes the second entity to `wiki/classes/UserService--packages-web.md` (disambiguated path using `--<scan-root-slug>` suffix)
4. Appends a contradiction notice to `wiki/log.md`: "Name collision: Class/UserService found in packages/api and packages/web. Pages: UserService.md, UserService--packages-web.md"

This is a conservative strategy — no entity is silently overwritten.

### Session root persistence

VS Code's `workspaceState` API persists key-value pairs for the lifetime of a workspace (survives VS Code restart but is workspace-scoped, not global):

```typescript
// Save
context.workspaceState.update('legion.sessionActiveRoot', selectedPath);

// Read
const sessionRoot = context.workspaceState.get<string>('legion.sessionActiveRoot');
```

The `legion.clearActiveRoot` command calls `context.workspaceState.update('legion.sessionActiveRoot', undefined)`.

### MCP server compatibility

The MCP server (`dist/mcp-server.js`) cannot read VS Code workspace settings or `workspaceState`. It resolves roots entirely from:
1. The `repoRoot` parameter in the tool call
2. Environment variable `LEGION_REPO_ROOT`
3. `.legion/config.json` `wiki_root` and `scan_roots` fields
4. `process.cwd()` as final fallback

This is consistent with the MCP-specific config resolution design in Feature 002.

---

## Files Touched

### New files

- `src/util/repoRoot.ts` — `resolveRepoRoot`, `clearSessionRoot`, `resolveWikiRoot`, `resolveScanRoots`
- `src/util/repoRoot.test.ts` — unit tests for resolution order, QuickPick mock, relative path resolution

### Modified files

- `src/extension.ts` — replace 3× `folders[0]`; register `legion.clearActiveRoot` command; add status bar item showing active root when multi-root
- `src/commands/document.ts` — replace `folders[0]` with `await resolveRepoRoot()`; pass `scanRoots` to document pass
- `src/commands/update.ts` — replace `folders[0]`
- `src/commands/findEntity.ts` — replace `folders[0]`; use `resolveWikiRoot()` for index path
- `src/commands/getEntity.ts` — replace `folders[0]`
- `src/commands/drainAgenda.ts` — replace `folders[0]`
- `src/commands/createSharedConfig.ts` — replace `folders[0]`; add monorepo setup step in wizard
- `src/commands/exportWiki.ts` *(from feature-003)* — use `resolveWikiRoot()` for export source
- `src/driver/documentPass.ts` — extend `planChunks()` to `planMonorepoChunks()`; handle `ChunkGroup[]`; add `scan_root` tag to entity frontmatter
- `src/driver/wikiWriter.ts` — implement name-collision detection and disambiguated path writing
- `src/mcp/mcpConfig.ts` *(from feature-002)* — add `LEGION_REPO_ROOT` env var + `.legion/config.json` `scan_roots`/`wiki_root` resolution
- `package.json` — add `legion.activeRoot`, `legion.scanRoots`, `legion.wikiRoot`, `legion.clearActiveRoot` command to contributions

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — `resolveRepoRoot` helper and single-root refactor

Create `src/util/repoRoot.ts` with the resolution logic. Replace all 12 `folders[0]` occurrences with `await resolveRepoRoot({ context })`. At this stage, the QuickPick is shown when `workspaceFolders.length > 1`, but "All roots" is not yet implemented.

**Goal:** zero regressions on single-root repos; multi-root repos get a picker instead of silently using root 0.

### Phase 2 — Session persistence, status bar, and `activeRoot` setting

- `context.workspaceState` persistence of selected root
- `legion.activeRoot` setting resolution (skip picker when set)
- `legion.clearActiveRoot` command
- Status bar item showing active root
- "All roots" option in QuickPick (sequential execution)

**Goal:** multi-root experience is smooth and stateful across a VS Code session.

### Phase 3 — Monorepo `scanRoots` and name-collision handling

- `resolveScanRoots()` returning sub-paths
- `planMonorepoChunks()` in `documentPass.ts`
- `scan_root` frontmatter tag in entity pages
- Name-collision detection and disambiguated path writing in `wikiWriter.ts`
- `createSharedConfig` wizard step for monorepo setup
- `.legion/config.json` `scan_roots` + `wiki_root` fields for MCP server

**Goal:** monorepo repos with multiple packages get correctly partitioned wikis.

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Zero regressions on single-root repos | All existing tests pass | CI test suite |
| Multi-root QuickPick appears exactly once per session (not per command) | 0 spurious pickers | Manual test on 2-root workspace |
| Monorepo scan correctly partitions 3-package repo | 3 separate `scan_root` values in wiki pages | Automated integration test |
| Name collision pages correctly disambiguated | 0 silent overwrites | `wikiWriter.test.ts` unit test |
| MCP server correctly uses `repoRoot` override | Tool calls with explicit root target correct directory | Smoke test in CI |

---

## Open Questions

- **Q1:** Should "All roots" run commands in parallel (faster) or sequentially (simpler, less likely to hit API rate limits)? **Current plan:** sequential for safety; parallel option as a `legion.parallelRoots` setting in a follow-up.
- **Q2:** For monorepo name collisions, should the disambiguated suffix be the scan root slug (`--packages-api`) or a numeric suffix (`UserService-2.md`)? **Current plan:** scan root slug — more informative, easier to trace back to the source package. Document the naming convention in `wiki/log.md`.
- **Q3:** Should `resolveRepoRoot` also consider `git rev-parse --show-toplevel` as an alternative to `workspaceFolders`? This could auto-detect the git root even in deeply nested open folders. **Current plan:** no for Phase 1; VS Code workspace folders are the canonical source of truth for the extension. The CLI/MCP path already uses `process.cwd()` which is typically the git root.

---

## Risks and Open Questions

- **Risk:** The refactor touches 8 files and 12 call sites — significant blast radius. **Mitigation:** implement Phase 1 as a purely mechanical substitution with 0 behaviour changes on single-root repos; validate with the full existing test suite before proceeding to Phase 2.
- **Risk:** Monorepo name collisions produce disambiguated page names that break existing backlinks (other pages that `[[link]]` to the original name). **Mitigation:** log the collision in `wiki/log.md` with both page paths; the wiki contradiction protocol (a four-artifact update) handles this in the reconcile pass.
- **Risk:** `legion.wikiRoot` set to a path outside the repo (e.g., a shared network drive) could cause surprising behaviour. **Mitigation:** validate that `wikiRoot` is either empty or within the resolved `repoRoot`; show a warning if it points outside.

---

## Related

- [`feature-001-semantic-search/prd-feature-001-semantic-search.md`](../feature-001-semantic-search/prd-feature-001-semantic-search.md) — `buildIndex` uses `repoRoot` / `wikiRoot`; benefits from `resolveWikiRoot()`
- [`feature-002-mcp-server/prd-feature-002-mcp-server.md`](../feature-002-mcp-server/prd-feature-002-mcp-server.md) — MCP `repoRoot` parameter must align with `resolveRepoRoot` output
- [`feature-003-wiki-export/prd-feature-003-wiki-export.md`](../feature-003-wiki-export/prd-feature-003-wiki-export.md) — export reads from `resolveWikiRoot(repoRoot)`
