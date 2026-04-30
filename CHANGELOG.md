# Changelog

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
