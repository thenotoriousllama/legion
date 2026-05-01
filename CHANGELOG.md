# Changelog

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
