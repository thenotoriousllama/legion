# Changelog

## [1.2.4] — 2026-05-02

Two defensive fixes plus a diagnostic breadcrumb to debug stuck installs.

### Fixed
- **Sidebar Setup section showing "Setup complete" with 0/0 keys configured.** The completion-state condition (`allRequiredDone && totalConfigured > 0`) had an edge case where it could evaluate true on weird intermediate states. Replaced with an explicit `trulyComplete` check that requires `keys.length > 0`, `totalConfigured > 0`, AND mode-specific required keys all configured. The "Setup complete" line will now never show with zero configured keys, regardless of the renderer's input.

### Added
- **Status-bar breadcrumb when Setup Wizard fires.** A 3-second `$(rocket) Legion Setup Wizard…` message now appears in the bottom-right status bar at the start of the wizard, BEFORE the QuickPick renders. If you click "Run Setup Wizard" or "Reconfigure" and don't see this breadcrumb, the click never reached the extension host — meaning the sidebar webview is running stale JS from a previous version. Fix: `Ctrl+Shift+P` → `Developer: Reload Window`. Webviews don't reload when an extension auto-updates; a window reload is required to pick up the new sidebar JS.

## [1.2.3] — 2026-05-02

### Fixed
- **Setup Wizard welcome step removed** — the wizard's first step was a `{ modal: false }` notification toast that appeared in the bottom-right corner of the IDE. If the user clicked elsewhere (or didn't notice it), the toast dismissed silently, the wizard set the completed flag, and returned — making "Run Setup Wizard" and "Reconfigure" appear to do nothing. The welcome step is removed; the wizard now opens directly with the invocation mode QuickPick, which appears prominently at the top of the screen in the command palette area and cannot be accidentally dismissed.

## [1.2.2] — 2026-05-02

Fixes extension discoverability in the Cursor and VS Code Extensions panel search. Since v1.1.0 the release pipeline only produced platform-specific VSIXes (`--target win32-x64`, etc.). The Extensions panel search hides platform-specific-only extensions from general search results — the extension was present on the Marketplace and installable via direct URL or ID, but not surfacing in the Extensions panel's search box.

### Fixed
- **`.github/workflows/release.yml`** — added a `build-universal` job that produces a standard VSIX (no `--target`, `--no-dependencies`) alongside the four platform-specific builds. The universal VSIX is what the Extensions panel search indexes for discovery; the platform-specific VSIXes are what gets served on install when the IDE requests one for a matched platform. The universal build is small (~1.6 MB, same as pre-v1.1.0 releases) because it bundles neither `@cursor/sdk` nor the native `sqlite3` binary. On the universal VSIX, `cursor-sdk` invocation mode will fail to load the SDK at runtime and surface a clear message directing the user to `direct-anthropic-api` mode — this is the existing documented fallback for unsupported platforms.

## [1.2.1] — 2026-05-02

Patch addressing all issues found by the post-ship QA pass on v1.2.0.

### Fixed

- **`drainAgenda.ts` bypassed SecretStorage for 3 optional search keys** (`exaApiKey`, `firecrawlApiKey`, `context7ApiKey`). After the v1.2.0 migration clears settings.json, those keys would have silently returned empty in the Drain Agenda command even though they were safely stored. Now correctly calls `getSecret(context, ...)` for all three.

- **`keyPrompt.ts` helpers were dead code in v1.2.0** — the `showKeyMissingError` and `promptAndSaveKey` helpers were defined but never imported at any callsite, so the plan's required 3-button modal (Enter API Key | Setup Wizard | Open Settings) and "Switch Mode" button never appeared. All five callsites now import and call `showKeyMissingError`: `autoresearch.ts`, `drainAgenda.ts`, `ingestUrl.ts`, `chatParticipant.ts`, `agentInvoker.ts`.

- **`agentInvoker.ts` cursor-sdk key-missing path threw a raw error** with no UI prompt. Now calls `showKeyMissingError(context, "cursorApiKey", ..., "direct-anthropic-api")` before throwing, giving the user an inline "Enter API Key" option with a "Switch Mode" fallback to `direct-anthropic-api`.

- **`semanticSearch.ts` `buildIndex()` still used legacy `resolveApiKey()`** which reads from settings.json. After the v1.2.0 migration clears `settings.json`'s `cohereApiKey`, users who had Cohere configured would have lost semantic search functionality (falling back to TF-IDF) even though their key was safely in SecretStorage. `buildIndex()` now accepts an optional `context?: ExtensionContext` and calls `resolveApiKeyWithContext(context)` when provided. Both callers (`document.ts`, `update.ts`) now pass `context`.

- **Auto-fire wizard fired even when keys were already configured** via env vars or SecretStorage. Now checks actual key presence with `getSecret(context, requiredKey)` before queueing the wizard; if the key exists, marks `WIZARD_COMPLETED_FLAG` to suppress future checks.

- **`markdownDescription` missing SecretStorage note for 5 of 7 key settings** (`openRouterApiKey`, `exaApiKey`, `firecrawlApiKey`, `context7ApiKey`, `cohereApiKey`). All 7 settings now document that entering a value copies it to encrypted OS storage and clears the field.

## [1.2.0] — 2026-05-02

Onboarding and security release. API keys move out of `settings.json` into OS-encrypted secret storage. A guided Setup Wizard replaces the "go set this in Settings" pattern. The sidebar gains a live setup-status panel with a progress ring, per-key rows, and inline paste support.

### Added

- **`Legion: Setup Wizard…` command** (`legion.setupWizard`). A 5-step guided flow: (1) welcome, (2) invocation mode picker (with rich descriptions), (3) required API key for the chosen mode (password input, saved to SecretStorage), (4) optional provider keys (Cohere, Exa, Firecrawl, Context7 — multi-select, each with a sub-prompt), (5) done screen with a "Document Repository" shortcut. Auto-fires on first `Initialize Repository` when no key is configured for the current mode. A `globalState` flag prevents repeat firings. Also available any time via Command Palette.

- **Sidebar Setup section**. A glassy card between the header and the status bar that shows the current API-key inventory. Features: animated SVG progress ring ("1/3 keys configured"), per-key rows with provider icon + label + masked value preview + status badge (Configured / Required / Optional) + paste-from-clipboard button. Auto-collapses with a green glow animation when all required keys for the current mode are configured. Tapping a row opens an inline InputBox for that key. Driven by a new `setupState` host→webview message updated whenever keys change.

- **Inline "Enter API Key" buttons** on all key-missing error paths (autoresearch, drainAgenda, ingestUrl, chatParticipant). Previously these surfaced `"Open Settings"` — now they offer `"Enter API Key"` (opens the InputBox inline, saves to SecretStorage immediately) alongside `"Setup Wizard"` and `"Open Settings"`.

- **`src/util/secretStore.ts`** — the SecretStorage abstraction. `getSecret(context, key)` resolution chain: env vars (highest priority, for CI/headless) → `context.secrets` SecretStorage → `config.get()` settings.json fallback. `setSecret`, `deleteSecret`, `hasSecret`, `maskSecret` (returns `cursor_••••8a3f` style preview). `migrateSettingsKeysToSecretStorage` (one-time migration guarded by `globalState` flag). `getSetupState` (returns full key inventory for the sidebar). `SECRET_KEYS` catalog (7 keys: cursorApiKey, anthropicApiKey, openRouterApiKey, cohereApiKey, exaApiKey, firecrawlApiKey, context7ApiKey) with metadata: label, env vars, required mode, helpUrl, placeholder.

- **`src/util/keyPrompt.ts`** — reusable `showKeyMissingError` (3-button modal) and `promptAndSaveKey` (direct InputBox) helpers for inline key prompts. Both store to SecretStorage and support an `onSaved` callback for sidebar refresh.

- **`onDidChangeConfiguration` handler** in `extension.ts`. When a user enters a key in the Settings UI (old behavior), the handler immediately copies it to SecretStorage and clears the `settings.json` entry — so the plaintext window is as short as possible regardless of how the user configures their keys.

### Changed

- **All API key reads use `getSecret()`** instead of `config.get<string>("xxxApiKey")`. Affected files: `agentInvoker.ts`, `autoresearch.ts`, `drainAgenda.ts`, `ingestUrl.ts`, `chatParticipant.ts`. `semanticSearch.ts` adds a `resolveApiKeyWithContext()` export for the extension-context path; the standalone `resolveApiKey()` (used by the MCP server, which has no ExtensionContext) is unchanged.

- **`legion.agentInvocationMode` default is now `cursor-sdk`** (unchanged from v1.1.0 but confirmed as the shipped default here too, carried forward).

- **Settings `markdownDescription`** for `legion.cursorApiKey` and `legion.anthropicApiKey` updated to note the SecretStorage migration behavior: entering a value copies it to the encrypted store and clears the setting.

### Security

- **API keys no longer stored in `settings.json` after v1.2.0**. On first activation after upgrading, `migrateSettingsKeysToSecretStorage` runs: any non-empty `settings.json` values are copied to `context.secrets` (OS-encrypted: DPAPI on Windows, Keychain on macOS, libsecret on Linux), then the settings are cleared. A one-time notification confirms the migration. The migration is idempotent (guarded by `globalState.legion.secretsMigrated.v1.2.0`) and does not overwrite existing SecretStorage values — if the wizard was already used before migration runs, the SecretStorage copy wins.

- **Keys are never echoed in notifications or log output**. Error messages use `meta.label` ("Cursor API key") not the key value. `maskSecret()` is the only function that derives a display string from the value, and it always hides all but the last 4 characters.

## [1.1.0] — 2026-05-02

The `cursor-cli` invocation mode has been replaced with a real implementation backed by the official `@cursor/sdk` (Cursor TypeScript SDK). v1.0.x's `cursor-cli` mode shelled out to `cursor agent <name> --input <path>` — that headless CLI surface was never publicly supported by Cursor and silently produced unparseable output (Cursor's launcher just forwarded the args to Chromium as switches). v1.0.6 fixed the spawn-level error but couldn't fix the underlying "this CLI doesn't exist" problem. v1.1.0 fixes it properly by using the documented programmatic interface — the SDK's `Agent.prompt()` against a local-runtime agent.

### Added
- **New `cursor-sdk` invocation mode (default)**, implemented via `@cursor/sdk` 1.0.12. Loads each guardian's system prompt + referenced skills from `.cursor/agents/<name>.md` and `.cursor/skills/<weapon>/`, packages them with the JSON payload into a single prompt, and calls `Agent.prompt()` with `local: { cwd: repoRoot }`. Distinguishes `CursorAgentError` (startup failure: auth, config, network) from `result.status === "error"` (run failure: agent did work and the work failed) so each surfaces a different actionable message.
- **`legion.cursorApiKey` setting** — Cursor API key for the SDK (also accepts `LEGION_CURSOR_API_KEY` and `CURSOR_API_KEY` environment variables). Get one at [cursor.com/dashboard/cloud-agents](https://cursor.com/dashboard/cloud-agents) (paid Cursor plan required).
- **`legion.cursorSdkModel` setting** — defaults to `composer-2`, Cursor's current general-purpose recommendation. Use `auto` to let the server pick.
- **Per-platform VSIX builds.** The release pipeline (`.github/workflows/release.yml`) now runs a 5-job matrix (`win32-x64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`) and produces one platform-tagged VSIX per supported architecture. The Marketplace and Open VSX serve each user the right VSIX automatically based on their OS + architecture.

### Changed
- **Default `legion.agentInvocationMode` is now `cursor-sdk`** (was `cursor-cli`). Anyone with `cursor-cli` set explicitly is transparently routed to the new SDK-backed implementation — no migration required for existing user configs.
- **`@cursor/sdk` is now a runtime dependency** (in `dependencies`, not `devDependencies`). The SDK is shipped inside each VSIX as a `node_modules/` payload (`vsce package` no longer uses `--no-dependencies`). esbuild bundles `dist/extension.js` with `--external:@cursor/sdk` and `--external:sqlite3` so the SDK's pre-bundled webpack output and its native sqlite3 binary aren't re-bundled — they're loaded at runtime from the bundled `node_modules/`.
- **`.vscodeignore` updated** to ship production `node_modules/` (excluding tests, examples, docs, source maps, and `CHANGELOG.md` files inside dependencies). VSIX size grows from ~1.6 MB (v1.0.x) to an estimated 25-40 MB compressed, comparable to other heavy extensions like Pylance.

### Deprecated
- **`cursor-cli` invocation mode value.** Still accepted as a deprecated alias for `cursor-sdk` (transparently routed through the SDK). Will be removed in v2.0.
- **`legion.cursorCliPath` setting.** No longer used — was the path to Cursor's CLI binary for the old shell-out path. Existing values are ignored. Will be removed in v2.0.

### Known limitations
- **Windows-on-ARM (`win32-arm64`) is not supported** in `cursor-sdk` mode because Cursor hasn't published a `@cursor/sdk-win32-arm64` package on npm yet. Affected users get a clear runtime error pointing them to switch `legion.agentInvocationMode` to `direct-anthropic-api` (which works on every platform — no Cursor subscription needed, just an Anthropic or OpenRouter API key).
- **Intel Mac (`darwin-x64`) is not shipped in v1.1.0.** GitHub Actions only offers `macos-13` as an x64 macOS runner, and queue times routinely exceed 30 minutes — long enough to block the whole release pipeline. Same workaround as above: Intel Mac users should set `legion.agentInvocationMode` to `direct-anthropic-api` until a future release adds darwin-x64 via cross-compilation on the `macos-latest` (arm64) runner (`npm install --cpu=x64 --os=darwin`).
- **Agents have tool access by default.** The SDK runs an *agent* (with file-read, shell, and MCP-tool access), not a pure LLM call. The prompt instructs the agent to "Output JSON only — no surrounding markdown fence, no commentary. Do not invoke tools or read additional files unless the system prompt explicitly instructs you to." If you observe guardians wandering off and using tools instead of returning the expected JSON, file an issue — we may need to add explicit MCP server gating in a follow-up.
- **No runtime end-to-end test in this release.** The integration was developed without access to a test `CURSOR_API_KEY`. Local bundle + type-check + per-platform packaging all verified, but the first real `Agent.prompt()` call happens when a user installs v1.1.0 and runs Document Repository. Bug reports welcome.

## [1.0.6] — 2026-05-02

Fixes a hard `spawn cursor ENOENT` failure on Windows that broke every parallel guardian invocation in `cursor-cli` mode (the default). Symptom in the wild looked like a stream of `Chunk "<module> [N/M]" invocation failed: spawn cursor ENOENT` lines after running `Legion: Document Repository`. Two independent root causes were collapsing into the same error.

### Fixed
- **`src/driver/agentInvoker.ts` — Windows `cursor.cmd` invocation.** The CLI on Windows ships as a `.cmd` batch shim (`cursor.cmd`), and Node's `child_process.execFile` refuses to launch `.bat` / `.cmd` files since the [CVE-2024-27980 ("BatBadBut") fix in Node 20.12.2 / 21.7.3 / 22.0.0](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2) without an explicit `shell: true`. Compounding this, Cursor's extension host inherits `PATH` from the moment Cursor was launched — if the cursor bin directory was added to `PATH` after Cursor started, the host doesn't see it until a full restart. The cursor-cli code path now invokes `cmd.exe` explicitly with hand-quoted args (using `windowsVerbatimArguments` to bypass Node's CRT re-escaping), so `.cmd` extension lookup works regardless of Node version. macOS / Linux behavior is unchanged — the existing direct `execFile` path is preserved when `process.platform !== "win32"`.

### Changed
- **Actionable error message when the Cursor CLI can't be reached.** Instead of leaking the raw `spawn cursor ENOENT` (which is meaningless to most users), Legion now throws a single error that names the platform-specific fix paths: on Windows, run `"Shell Command: Install 'cursor' command in PATH"` from Cursor's Command Palette and **restart Cursor** (the extension host caches PATH on launch — a settings reload is not enough); on POSIX, ensure `cursor` is on PATH or set `legion.cursorCliPath` to the absolute binary path. Both messages include the canonical fallback: switch `legion.agentInvocationMode` to `direct-anthropic-api` (which bypasses the CLI entirely and is what the README already recommends for Windows + VS Code users). The original underlying error is appended at the end so the symptom is still searchable.

## [1.0.5] — 2026-05-02

Release-pipeline self-heal. v1.0.4 published cleanly to the VS Code Marketplace but the parallel `open-vsx` job failed at the publish step with `❌ Unknown publisher: thenotoriousllama` — Open VSX (unlike Microsoft's Marketplace) requires the publisher namespace to be explicitly registered before any extension can be uploaded under it. v1.0.5 ships the workflow patch that auto-creates the namespace on demand, so this never blocks a release again.

### Fixed
- **`.github/workflows/release.yml`** — the `open-vsx` job now does a state check against `https://open-vsx.org/api/<publisher>` (the public namespace endpoint, no auth required) before publishing. If the response is HTTP 200 the namespace is already registered and the job proceeds straight to upload; if 404 it calls `npx ovsx create-namespace` with the existing `OVSX_PAT` and then proceeds; any other status code fails loudly with the response body. The job also now does a tag-pinned `actions/checkout@v4` (using the new `needs.release.outputs.tag` output) so it can read the `publisher` field from `package.json` instead of hardcoding the publisher name — future-proofs the workflow against publisher renames.

### Distribution
- v1.0.5 is the first version of Legion available on the [Open VSX Registry](https://open-vsx.org/extension/thenotoriousllama/legion). Users on [VSCodium](https://vscodium.com/), [Eclipse Theia](https://theia-ide.org/), [Gitpod](https://www.gitpod.io/), and other VS Code-compatible editors that don't ship Microsoft's proprietary marketplace endpoint can now install Legion via the same `Extensions` panel flow as Marketplace users. v1.0.4 remains Marketplace-only as a historical artifact — no functional difference between v1.0.4 and v1.0.5 in the extension code itself.

## [1.0.4] — 2026-05-02

Distribution-only release. Republished to push the v1.0.3 sidebar fix to the [Open VSX Registry](https://open-vsx.org/extension/thenotoriousllama/legion) now that the `OVSX_PAT` repository secret is configured. No functional code changes since v1.0.3 — the version bump is required because both the VS Code Marketplace and Open VSX reject duplicate version uploads.

### Distribution
- **Open VSX coverage restored.** The `open-vsx` job in `.github/workflows/release.yml` was already wired up but gated on `secrets.OVSX_PAT` being present, so it skipped silently on every release between v1.0.1 and v1.0.3. With the token now configured, v1.0.4 ships to both the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion) and the [Open VSX Registry](https://open-vsx.org/extension/thenotoriousllama/legion) in parallel. Open VSX is the package source used by [VSCodium](https://vscodium.com/), [Eclipse Theia](https://theia-ide.org/), [Gitpod](https://www.gitpod.io/), and other VS Code-compatible editors that don't ship Microsoft's proprietary marketplace endpoint — so Legion is now installable in those editors via the same `Extensions` panel flow.

## [1.0.3] — 2026-05-01

### Fixed
- **Sidebar status now refreshes after every wiki mutation.** The "Initialized / Not initialized" badge, page count, and last-scan timestamp in the Legion sidebar were computed once on extension activation and cached in `LegionSidebarProvider._pendingState`. After running `Legion: Initialize Repository` (or `Document` / `Update` / `Scan Dir…`), nothing re-probed disk, so the badge stayed stuck on the activation snapshot until the user manually reloaded the window. Now the four wiki-mutating commands (`legion.initialize`, `legion.document`, `legion.update`, `legion.scanDirectory`) explicitly refresh the sidebar after they resolve, and the `requestState` message re-detects from disk on every call so the panel self-heals when commands are invoked from the Command Palette while the sidebar is collapsed.

### Added
- **`.gitattributes`** at repo root. Enforces `text eol=lf` for `*.sh`, `*.bash`, `*.yml`, `*.yaml`, and the canonical dotfiles; declares common image/font formats as `binary`. Prevents Git for Windows' default `core.autocrlf=true` from silently rewriting `scripts/snapshot-bundled.sh` to CRLF on `git clone`, which broke `npm run package` with `$'\r': command not found` and `: invalid option nameled.sh: line 12: set: pipefail` errors when invoked from WSL bash on Windows.

## [1.0.2] — 2026-05-01

Documentation-only release. Republished to push the updated README to the VS Code Marketplace listing (the Marketplace freezes the README at publish time).

### Changed
- **README — Cursor-first framing.** Hero, CTA row, and Quickstart now lead with Cursor as the primary editor. The architecture is engineered around Cursor's subagent runtime; VS Code is a supported install path and the second Quickstart variant. New sub-line clarifies that the extension is packaged for the VS Code Marketplace specifically so it installs in either editor.
- **README — Quickstart split into "In Cursor (recommended)" and "In VS Code"** with explicit step-by-step instructions for each. The VS Code section documents the `direct-anthropic-api` invocation mode + `LEGION_ANTHROPIC_API_KEY` setup for users who don't have the Cursor CLI on PATH.
- **README — badge row replaced.** The previous badges used Shields.io's `/visual-studio-marketplace/*` endpoints, which Microsoft locked down and Shields.io retired in April 2026 ([badges/shields PR #11792](https://github.com/badges/shields/pull/11792)). The badges were rendering as literal "RETIRED BADGE" placeholder text. Replaced with five dynamic GitHub-API-backed badges (release version, release pipeline status, last commit, GitHub stars) plus a labeled License badge (LSAL is not an SPDX identifier so the GitHub-detected license badge wouldn't render correctly).

## [1.0.1] — 2026-05-01

First public 1.x release. Establishes the production publishing pipeline.

### Changed
- **CI / Release pipeline** — `.github/workflows/release.yml` now publishes the VSIX to the **VS Code Marketplace** automatically when a `v*` tag is pushed. The new `vscode-marketplace` job runs in parallel with the existing `open-vsx` job after the GitHub Release is created. Both jobs are gated on their respective publisher tokens (`VSCE_PAT`, `OVSX_PAT`) and skip cleanly if the secret is unset.
- **Snapshot source-of-truth** — the release workflow now clones [`thenotoriousllama/legion-project`](https://github.com/thenotoriousllama/legion-project) (public, MIT) into `legion-project-src/` before building, and `scripts/snapshot-bundled.sh` resolves the source via `LEGION_SOURCE` env override → `../legion-project/legion/.cursor/` → `../God/legion/.cursor/` (legacy local fallback). This decouples CI from any specific local folder layout.
- **Branding & licensing** (carried forward from the unreleased v1.0.0 prep in commit `f1533c0`) — relicensed to the Legion Source-Available License v1.0; refreshed README, LICENSE, and package metadata (description, author, repository URLs); refreshed Obsidian companion plugin manifest and README; added attribution media (`media/bmc.png`, `media/mario-portrait.png`).

### Notes
- v1.0.0 was prepared in-tree but never tagged or published; this 1.0.1 release supersedes it and is the first version available on the VS Code Marketplace and Open VSX.

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
