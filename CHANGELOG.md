# Changelog

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
