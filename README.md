# Legion

**The God Protocol's Cursor extension.** Deploys a full AI agent army against any codebase — compounding entity-graph wiki, module narrative docs, cognitive-layer reviews, auth/DB/DevOps/payments audits, and more. All 14 guardians. All weapons. One sidebar.

Proprietary software — all rights reserved. See [LICENSE](LICENSE).

## What it does

| Button | What happens |
|---|---|
| **Initialize Repository** | Scaffolds `library/`, `.legion/`, and `.cursor/` (with selected guardians) in your repo. Writes a default `.legionignore`. Idempotent — safe to re-run. |
| **Document Repository** | Walks the repo (respecting `.legionignore`), chunks by module boundary, pre-computes git context per chunk, invokes `wiki-guardian` (and `library-guardian`) in parallel, reconciles wiki global state. |
| **Update Documentation** | Same as Document, but only re-scans files whose hashes changed since the last scan. Cheap. |
| **Scan Directory…** | Document/Update applied to a single directory you pick. Useful for focused work. |
| **Lint Wiki** | Per-chunk validation across the wiki — frontmatter, in-chunk wikilink resolution, pairing integrity, atomic-page-rule violations, ADR chain integrity. Reports only; never auto-fixes. |

## Output structure

Inside your repo, on first Initialize:

```
your-repo/
├── .legionignore                      # gitignore-style patterns to skip
├── .legion/                            # extension state (do not commit)
│   ├── config.json
│   ├── file-hashes.json               # hash manifest for delta tracking
│   ├── queue/                          # invocation queue (queue-file mode)
│   ├── git-cache/                      # cached git log/blame outputs
│   └── chunks/                         # in-progress scan state
├── .cursor/
│   ├── agents/
│   │   ├── wiki-guardian.md            # the entity cartographer
│   │   └── library-guardian.md         # the module-narrative author
│   └── skills/
│       ├── wiki-weapon/
│       └── library-weapon/
└── library/                            # the wiki itself (commit this)
    ├── knowledge-base/
    │   ├── <module>/                   # library-guardian writes module narratives here
    │   └── wiki/                       # wiki-guardian writes entity stubs here
    │       ├── index.md
    │       ├── hot.md
    │       ├── log.md
    │       ├── overview.md
    │       ├── entities/
    │       ├── concepts/
    │       ├── decisions/
    │       ├── comparisons/
    │       ├── questions/
    │       └── meta/
    ├── notes/
    ├── qa/
    └── requirements/
        ├── issues/
        └── features/
```

## Settings

- `legion.agentInvocationMode` — `cursor-cli` (default) | `queue-file` | `direct-anthropic-api`
- `legion.anthropicApiKey` — required for `direct-anthropic-api` mode
- `legion.cursorCliPath` — path to the Cursor CLI binary (default `cursor`)
- `legion.maxParallelAgents` — concurrency limit for parallel agent invocations (default 3)
- `legion.installPostCommitHook` — install a post-commit git hook for auto-Update (v0.2.0+)

## v0.1.0 status

- ✅ Initialize Repository — fully implemented
- ⚠️ Document / Update / Scan Directory / Lint — sidebar wired, command registered, driver scaffold in place; per-mode chunk-planning and reconciliation logic stubbed for v0.2.0
- ✅ TypeScript driver: `.legionignore` parser, hash-diff manifest, git-context shell-out
- ✅ Three-mode agent invocation switcher (`cursor-cli`, `queue-file`, `direct-anthropic-api`) — `cursor-cli` and `queue-file` are functional; `direct-anthropic-api` is a v0.2.0 stub

This is a v0.1.0 scaffold designed for iteration in Cursor with hot-reload via the Extension Development Host (F5).

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE).
