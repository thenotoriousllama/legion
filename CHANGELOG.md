# Changelog

## [0.7.0] — 2026-04-30

### Added (Features 001–010 + Obsidian Companion Plugin)

#### Feature 001 — Semantic Search with Cohere + TF-IDF Fallback
- `src/driver/semanticSearch.ts` — `embedText` (Cohere `embed-english-v3.0`, batched 96/call), `buildIndex` (incremental SHA-256 cache at `.legion/embeddings.json`), `query` (Cohere dense vectors when key available; pure-TypeScript TF-IDF fallback otherwise)
- `legion.findEntity` upgraded to semantic search with score badges; `legion.semanticSearchEnabled` and `legion.cohereApiKey` settings added
- `buildIndex` runs in background after every Document/Update pass; `createSharedConfig` wizard includes optional Cohere key step
- `.gitignore`: `.legion/embeddings.json` added

#### Feature 002 — MCP Server (7 tools over stdio)
- `src/mcp/legionMcpServer.ts` — `McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk`; 7 tools: `legion_document`, `legion_update`, `legion_find_entity`, `legion_get_entity`, `legion_get_context`, `legion_autoresearch`, `legion_drain_agenda`
- `src/mcp/mcpConfig.ts` — VS Code-free config resolution (env vars → `.legion/config.json` → defaults)
- `src/mcp/toolHandlers.ts` — one async handler per tool
- `"compile:mcp"` esbuild script added; outputs `dist/mcp-server.js`
- Registration docs for Claude Code and Cursor in README

#### Feature 003 — Wiki Export (Docusaurus / Static HTML / Markdown Bundle)
- `src/driver/wikiExport.ts` — three export renderers with atomic tmp→rename; `[[wikilink]]` resolver; embedded CSS
- `src/commands/exportWiki.ts` — QuickPick format selector with progress notification
- `legion.exportWiki` command; `legion.exportTarget` and `legion.exportOutputDir` settings
- "Export Wiki…" footer button in Legion sidebar

#### Feature 004 — Scheduled Research (Cron on Activate)
- `src/driver/cronParser.ts` — zero-dependency 5-field cron parser (`parseCron`, `prevFireTime`, `nextFireTime`, `isOverdue`)
- Schedule check on `activate()`: "Run Now / Snooze 1 day / Disable Schedule" notification when overdue
- `drainAgenda` writes `last_agenda_drain` timestamp; optional `git commit [skip ci]` when `legion.autoGitCommit`
- `legion.researchSchedule` and `legion.researchScheduleEnabled` settings

#### Feature 005 — Multi-workspace / Monorepo Support
- `src/util/repoRoot.ts` — `resolveRepoRoot()` (4-step: `activeRoot` setting → session state → single-root passthrough → QuickPick), `resolveWikiRoot()`, `resolveScanRoots()`
- All commands now resolve root at invocation time (no stale closure capture)
- `documentPass.ts` walks each `scanRoot`; `resolveWikiRoot()` replaces hardcoded path
- `legion.activeRoot`, `legion.scanRoots`, `legion.wikiRoot`, `legion.clearActiveRoot` added
- Status bar active-root indicator for multi-root workspaces

#### Feature 006 — PR Review Bot (GitHub Actions Wizard)
- `src/util/gitRemote.ts` — `getOriginUrl()`, `parseGitHubRemote()` (HTTPS + SSH)
- `src/commands/installPrReviewBot.ts` — 4-step wizard: remote detection → workflow idempotency check (diff editor on conflict) → browser open to GitHub Secrets → final instructions
- `templates/legion-wiki-diff.yml` — upgraded with idempotent `<!-- legion-wiki-diff -->` marker, structured PR comment tables, Shields.io docs-health badge
- "PR Bot" footer button in Legion sidebar

#### Feature 007 — Claude Code Integration (3 layers)
- `src/context/claudeMdWriter.ts` — writes/updates `CLAUDE.md` with fenced `## Legion Wiki` routing block (surgical replace on subsequent runs)
- Reconciler Step 15: calls `injectClaudeContext()` after each pass; `legion.injectClaudeContext` setting (default `true`)
- `templates/claude-plugin/` — `/legion-document`, `/legion-research`, `/legion-find` slash-command definitions copied to `.claude-plugin/` on Initialize
- Initialize summary includes `claude mcp add-json` setup note when MCP server is compiled

#### Feature 008 — Obsidian Companion Plugin
- `companion-plugins/legion-obsidian/` — standalone Obsidian plugin (separate build, not in VSIX)
- Status panel, contradiction inbox (mark-resolved with `.bak` backup), Trigger Update, Human Annotations, entity color-coding CSS snippet, dependency graph command
- wiki-weapon Phase 3 updated with Human Notes Sanctity Rule (wiki-guardian must never overwrite `## Human Notes` sections)

#### Feature 009 — Community Guardian Ecosystem
- `src/guardians/types.ts` — `GuardianManifest`, `GuardianRegistry`, `RegistryEntry` interfaces
- `src/guardians/communityGuardianManager.ts` — `fetchRegistry()` (ETag cache, 1-hour TTL), `install()`, `listInstalled()`
- `legion.installGuardian` — registry browse → agent.md preview → install with progress
- `legion.updateGuardians` — version diff → selective update; pin support
- `discoverAllGuardians()` merges bundled + community guardians
- `templates/guardian-template/` starter package; `schemas/guardian-schema.json`
- `legion.guardianRegistryUrl` setting

#### Feature 010 — Analytics Dashboard
- `src/driver/snapshotManager.ts` — `writeSnapshot()`, `loadSnapshots()`, `pruneOld()` (max 90 snapshots at `.legion/snapshots/`)
- Reconciler Step 16: persists snapshot after every pass; fires `legion.internal.dashboardRefresh`
- `src/dashboard/charts/` — 5 pure-TypeScript SVG chart functions (line, stacked area, bar, horizontal bar, contradiction rate)
- `src/dashboard/dashboardPanel.ts` — singleton `WebviewPanel`; "Copy as Markdown table" per chart
- `legion.openDashboard` command; "Dashboard" sidebar footer button

## [0.6.0] — 2026-04-30

### Added (Long-term In-extension Features)

- `providers/wikiTreeProvider.ts` — Wiki Tree View registered as `legion.wikiTree` in the Legion activity bar panel. Shows all wiki pages organized by type (Entities, Concepts, Decisions, Sources, Questions, etc.) with status icons. Clicking opens the page in VS Code's native Markdown editor. Auto-refreshes after every reconcile pass.
- `providers/wikilinkCompletionProvider.ts` — `[[wikilink]]` autocompletion for any Markdown file inside the wiki. Typing double-open-bracket triggers a completion list of all wiki pages with their type and status. Inserts the page name and closing brackets.
- `providers/backlinksProvider.ts` — Backlinks panel registered as `legion.backlinks`. Shows all wiki pages that link to the currently active wiki file. Updates when the active editor changes or a wiki file is saved. Clicking navigates to the exact line containing the backlink.
- `commands/resolveContradiction.ts` — Full diff-based contradiction resolution workflow replacing the old Quick Pick. Opens VS Code's native diff editor (before vs. after) for each contradiction, then presents "Keep new version / Revert to old / Mark resolved" actions with automatic callout stripping.
- `driver/sharedConfig.ts` — `.legion-shared/` directory layer for committed team configuration. `loadSharedConfig` / `saveSharedConfig` / `mergeSharedIgnore` API. Shared ignore patterns extend `.legionignore`. Shared guardian defaults are applied in Initialize. Shared research agenda topics recur on every Drain Agenda.
- `commands/createSharedConfig.ts` — `legion.createSharedConfig` interactive wizard: guardian defaults, model, parallel agents, fold schedule, ignore extensions. Writes `.legion-shared/config.json` + starter `legionignore`. Instructs user to commit the directory.

## [0.5.0] — 2026-04-30

### Added (Knockout Features — v0.5.0)

- `@legion` VS Code Chat Participant — type `@legion how does auth work?` in Cursor chat; Legion reads the wiki hot cache + relevant entity/concept pages and synthesizes a grounded answer with wiki citations. Engine bumped to `^1.90.0`.
- `providers/contractValidator.ts` — on every TS/JS file save, compares exported function signatures against wiki entity pages and shows a Warning diagnostic when the contract diverges. Code actions: "Open wiki page" and "Run Update Documentation". Controlled by `legion.contractValidation` setting.
- `driver/coverageTracker.ts` — after each reconcile pass, counts entity pages by `status:` (`seed/developing/mature/evergreen/stub`) per module. Stores in `.legion/config.json`. Sidebar shows a Unicode progress bar (`████░░ 47% mature`) — click for per-module Quick Pick breakdown.
- `commands/archaeology.ts` — right-click any TS/JS/Python/Go/Rust file → "Legion: Explain Why This Was Built"; traces full git history, filters for decision-encoding commits, synthesizes an architectural narrative via LLM, files as `wiki/decisions/<slug>-history.md`. Adds editor/context menu entry.
- `commands/onboardingBrief.ts` — `legion.generateOnboardingBrief`: given a topic/module keyword, loads matching entity pages, sorts foundational-first (highest in-degree), generates LLM intro paragraph, files as `wiki/meta/onboarding-<slug>.md` and copies path to clipboard.
- `commands/ingestUrl.ts` — `legion.ingestUrl` (`Ctrl+Shift+Alt+U`): paste a URL → Firecrawl scrapes it → single research round extracts concepts/entities → files `wiki/sources/<slug>.md` with citation. Requires `legion.firecrawlApiKey`.
- `driver/researchAgenda.ts` + `commands/drainAgenda.ts` — maintain a `wiki/research-agenda.md` checklist; `legion.drainAgenda` runs Autoresearch on every unchecked item (respects `maxParallelAgents`), marks each done as it completes.

## [0.4.0] — 2026-04-30

### Added (Competitive Parity — closes gaps vs claude-obsidian DragonScale)

- `driver/addressAllocator.ts` — stable page addresses (`address: c-NNNNNN`) injected into every new wiki page via reconciler Step 0.5; counter at `.legion/address-counter.txt`; Initialize creates the counter; `rebuildCounter()` for migration
- `driver/logFold.ts` + `commands/foldLog.ts` — log fold operator; rolls up last `2^k` log entries into a deterministic checkpoint page at `wiki/folds/<foldId>.md`; idempotent; dry-run mode; sidebar "Fold Log…" button; `legion.logFoldK` setting
- `driver/researchPass.ts` + `commands/autoresearch.ts` — 3-round autonomous research loop; synthesizes knowledge on a topic using Anthropic API and files `sources/`, `concepts/`, `questions/` pages; `Ctrl+Shift+Alt+R`; `legion.researchRounds` + optional `legion.searchApiUrl`/`searchApiKey`
- `commands/saveConversation.ts` — `/save` equivalent; opens scratch document pre-filled with frontmatter template, files to `wiki/sources/` or `wiki/decisions/`; `Ctrl+Shift+Alt+S`
- `driver/boundaryScorer.ts` — boundary-first topic scoring `(out_degree - in_degree) × recency_weight`; surfaces top-N frontier entities as suggested Autoresearch topics (DragonScale M4 equivalent)
- `driver/gitCommit.ts` — `autoCommitWiki()` stages `library/` and `.legion/` and commits; called after Document/Update when `legion.autoGitCommit: true` (PostToolUse hook equivalent)
- Session startup context refresh — `activate()` calls `injectHotContext()` immediately and watches `wiki/hot.md` for changes to auto-refresh `.cursor/rules/wiki-hot-context.md` (SessionStart + PostCompact hook equivalent)
- Multi-model setting — `legion.model` (`claude-sonnet-4-5` | `claude-opus-4-5` | `claude-haiku-4-5`); used by both `invokeAnthropicApi` and Autoresearch

## [0.2.0] — 2026-04-30

### Added
- `driver/chunkPlanner.ts` — `planChunks` groups repo files by top-level module boundary and splits groups exceeding `MAX_FILES_PER_CHUNK` (6) into ordered sub-chunks; `loadChunkContent` hydrates chunks into `ChunkFile[]` with graceful skip on unreadable files
- `driver/documentPass.ts` — `runDocumentPass` orchestrates the full Document/Update/Scan-Directory pipeline: repo walk (respecting `.legionignore`), hash diff, chunk planning, git context pre-computation, parallel agent invocation (`legion.maxParallelAgents`), and post-pass reconciliation; includes hand-rolled frontmatter parser for `prior_state` loading in update mode and a dependency-free concurrency pool
- `driver/reconciler.ts` — `reconcile` runs all 8 post-pass steps: invariant validation with descriptive error payloads, log.md prepend, index.md update, per-type `_index.md` maintenance, hot.md refresh from git context, ADR number allocation (`pending-*` → `ADR-NNN-*`), file-hashes.json update, VS Code notification flag surfacing, and `partial_scan_pending` flag persistence
- `commands/document.ts` — wires "Document Repository" to `runDocumentPass(mode: "document")`
- `commands/update.ts` — wires "Update Documentation" to `runDocumentPass(mode: "update")`
- `commands/scanDirectory.ts` — wires "Scan Directory…" to `runDocumentPass(mode: "scan-directory", scopeDir)`

### Architecture
- `ChunkResult = {label, payload, response}` bundles each agent result with its payload so the reconciler has access to `git_context` for hot.md without a separate data-passing mechanism
- Response invariants are enforced in the reconciler (not silently ignored): contradictions without meta reports, decisions absent from `pages_created`, and absolute/traversal paths all throw descriptive errors with the offending payload fragment
- No new npm dependencies — all stdlib (`fs/promises`, `path`, `crypto`)

## [0.1.0] — 2026-04-29

Initial scaffold.

### Added
- VS Code extension manifest with sidebar (activitybar entry), 5 commands, and configuration schema
- Sidebar webview with Initialize / Document / Update / Scan Directory / Lint buttons
- `Legion: Initialize Repository` — fully working: scaffolds `library/`, `.legion/`, `.cursor/`, writes default `.legionignore`, copies bundled guardians via QuickPick
- TypeScript driver scaffold:
  - `.legionignore` parser (gitignore-syntax compatible)
  - SHA256 file-hash manifest (`.legion/file-hashes.json`) for delta tracking
  - Git context shell-out (`git log`, `git blame`) per file
  - Three-mode agent invocation switcher (cursor-cli / queue-file / direct-anthropic-api)
  - `direct-anthropic-api` mode is a stub for v0.2.0
- Templates for default `.legionignore`, `library/knowledge-base/wiki/{index,hot,log,overview}.md`, and `.legion/config.json`
- Build pipeline: esbuild bundling to `dist/extension.js`, vsce packaging, snapshot script that pulls bundled agents+weapons from `../legion/.cursor/`

### Pending for v0.2.0
- Document / Update / Scan Directory / Lint command implementations (chunk planning, parallel agent invocation, reconciliation)
- Post-commit git hook installer
- `direct-anthropic-api` mode full implementation
