<div align="center">

<img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/legion-icon.png" alt="Legion" width="128" />

# Legion

### The God Protocol's Cursor extension. A full AI agent army for any codebase.

Compounding entity-graph wiki. Module narrative docs. Cognitive-layer reviews.<br/>
Auth, DB, DevOps, payments, security, UX, design-system, SEO/AEO audits.<br/>
**Fourteen guardians. One sidebar.**

<br/>

[![VS Code Marketplace](https://img.shields.io/github/v/release/thenotoriousllama/legion?style=for-the-badge&label=VS%20Code&color=0B0F19&sort=semver)](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion)
[![Release pipeline](https://img.shields.io/github/actions/workflow/status/thenotoriousllama/legion/release.yml?style=for-the-badge&label=release&color=0B0F19)](https://github.com/thenotoriousllama/legion/actions/workflows/release.yml)
[![Last commit](https://img.shields.io/github/last-commit/thenotoriousllama/legion?style=for-the-badge&color=0B0F19)](https://github.com/thenotoriousllama/legion/commits/main)
[![GitHub stars](https://img.shields.io/github/stars/thenotoriousllama/legion?style=for-the-badge&color=0B0F19)](https://github.com/thenotoriousllama/legion)
[![License](https://img.shields.io/badge/license-Source%20Available-0B0F19?style=for-the-badge)](LICENSE)

<br/>

[**Install on VS Code**](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion) &nbsp;·&nbsp; [**Source**](https://github.com/thenotoriousllama/legion) &nbsp;·&nbsp; [**Sponsor**](https://www.paypal.com/ncp/payment/7F5JZAHDHGCXC) &nbsp;·&nbsp; [**Linktree**](https://linktr.ee/marioaldayuz)

</div>

<br/>

---

## Why Legion

<table>
<tr>
<td width="33%" valign="top">

### Wiki Guardian

The cartographer. Builds and maintains a compounding entity-graph wiki with `[[backlinks]]`, ADR detection, and a contradiction protocol that surfaces drift before it ships.

</td>
<td width="33%" valign="top">

### Library Guardian

The narrator. Writes per-module narrative documentation and PRDs the way a senior engineer would explain it on a whiteboard — what, why, how, and what could break.

</td>
<td width="33%" valign="top">

### Mind Guardian

The cognitive layer. RAG retrieval, coach routing, persistent memory, and evaluation across every other guardian. The brain behind the army.

</td>
</tr>
<tr>
<td valign="top">

### Auth · DB · DevOps · Payments

Domain-specialist guardians that audit your authentication flows, database schemas, infrastructure, and billing pipelines for the patterns that actually break in production.

</td>
<td valign="top">

### Quality · Security · React

Continuous review for code quality, security posture, and React patterns. Not a one-shot lint — a recurring agent that learns your codebase.

</td>
<td valign="top">

### UX/UI · Design System · SEO/AEO · Asset

The frontline guardians for everything users actually see. Plus an asset guardian to keep media, fonts, and bundles in line.

</td>
</tr>
</table>

---

## What it does

| Command | What happens |
|---|---|
| **Initialize Repository** | Scaffolds `library/`, `.legion/`, and `.cursor/` (with selected guardians) in your repo. Writes a default `.legionignore`. Idempotent — safe to re-run. |
| **Document Repository** | Walks the repo, chunks by module boundary, pre-computes git context per chunk, invokes guardians in parallel, reconciles wiki global state. |
| **Update Documentation** | Same as Document, but only re-scans files whose hashes changed since the last scan. Cheap. |
| **Scan Directory…** | Document/Update applied to a single directory you pick. Useful for focused work. |
| **Lint Wiki** | Per-chunk validation — frontmatter, in-chunk wikilink resolution, pairing integrity, atomic-page-rule violations, ADR chain integrity. |
| **Find Entity…** | Semantic search across the wiki (Cohere embeddings, TF-IDF fallback). Score badges, instant jump. |
| **Autoresearch…** | Multi-round synthesis pass over the wiki + optional web grounding (Exa, Firecrawl, Context7). |
| **Open Analytics Dashboard** | Coverage trends, contradiction rate, entity growth — rendered as live SVG charts. |
| **Export Wiki…** | One-click export to Docusaurus, static HTML, or a flat Markdown bundle. |
| **Install PR Review Bot** | 4-step wizard installs a GitHub Action that posts wiki-aware PR comments. |
| **View Entity Graph** | Mermaid graph of your entity relationships, generated from the wiki. |
| **Explain Why This Was Built** | Code-archaeology pass on the active file — surfaces the ADRs, commits, and decisions that produced it. |

---

## Quickstart

```bash
# 1. Install Legion from the VS Code Marketplace
# 2. Open your repo in VS Code or Cursor
# 3. Command Palette → "Legion: Initialize Repository"
# 4. Command Palette → "Legion: Document Repository"
```

That's it. The wiki lives at `library/knowledge-base/wiki/`. Commit it. Your future self thanks you.

---

## Output structure

The shape Legion writes into your repo on first Initialize:

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

---

## Companion plugins

<table>
<tr>
<td width="120" valign="middle" align="center">
<img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/legion-icon.png" width="80" alt="Legion for Obsidian" />
</td>
<td valign="top">

### Legion for Obsidian

Brings Legion's wiki operational state into Obsidian — status panel, contradiction inbox, human annotations, entity color coding, and a one-click trigger for incremental scans. Built for the non-developers on your team.

[Read the Obsidian docs →](companion-plugins/legion-obsidian/README.md)

</td>
</tr>
</table>

---

## Settings

<details>
<summary><b>Most-used configuration</b> (full list in <code>package.json</code>)</summary>

| Setting | Default | Purpose |
|---|---|---|
| `legion.agentInvocationMode` | `cursor-cli` | How agents are invoked: `cursor-cli`, `queue-file`, or `direct-anthropic-api` |
| `legion.apiProvider` | `anthropic` | LLM provider for direct mode and Autoresearch — `anthropic` or `openrouter` |
| `legion.model` | `claude-sonnet-4-5` | Claude model when using direct Anthropic API |
| `legion.maxParallelAgents` | `3` | Concurrency limit for parallel agent invocations |
| `legion.installPostCommitHook` | `false` | Install a post-commit git hook that queues Update on every commit |
| `legion.semanticSearchEnabled` | `true` | Enable semantic Find Entity (Cohere or TF-IDF) |
| `legion.researchProvider` | `model-only` | Web grounding for Autoresearch — `model-only`, `exa`, `firecrawl`, `context7` |
| `legion.injectClaudeContext` | `true` | Auto-update `CLAUDE.md` so Claude Code loads wiki context every session |
| `legion.injectCursorContext` | `true` | Auto-write `.cursor/rules/wiki-hot-context.md` for Cursor |
| `legion.exportTarget` | `html` | Default format for `legion.exportWiki` — `docusaurus`, `html`, or `markdown` |

</details>

---

## About the author

<table>
<tr>
<td width="200" valign="top" align="center">
<img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/mario-portrait.png" width="180" alt="Mario Aldayuz" />
</td>
<td valign="top">

### Mario Aldayuz

**Marine Corps veteran. Creative-Director-turned-AI-founder. Automation architect.**

After ~10 years as Creative Director at Blue Ridge Media Company, I traded calibration tools and brand systems for code — building intelligent systems that help businesses operate at peak performance.

Today I'm the founder of [**OllieBot.ai**](https://olliebot.ai) (omnichannel AI customer-service agent) and [**ManageN8N**](https://managen8n.com) (the ultimate N8N instance manager), and I run elite automation consulting through Wise Guys Consulting. Legion is the tool I wish I'd had every time I dropped into a new codebase cold.

Off the clock — fine bourbon, a good cigar, and Harley the dog.

[**marioaldayuz.com**](https://www.marioaldayuz.com) &nbsp;·&nbsp; [**Linktree**](https://linktr.ee/marioaldayuz) &nbsp;·&nbsp; [**GitHub**](https://github.com/thenotoriousllama)

</td>
</tr>
</table>

---

## Support

If Legion saved you a weekend, buy me a coffee — or a finger of bourbon.

<div align="center">

<a href="https://www.paypal.com/ncp/payment/7F5JZAHDHGCXC">
  <img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/bmc.png" alt="Buy Me a Coffee" width="220" />
</a>

</div>

---

## Connect

- Linktree — [linktr.ee/marioaldayuz](https://linktr.ee/marioaldayuz)
- Website — [marioaldayuz.com](https://www.marioaldayuz.com)
- GitHub — [@thenotoriousllama](https://github.com/thenotoriousllama)
- Issues — [github.com/thenotoriousllama/legion/issues](https://github.com/thenotoriousllama/legion/issues)

---

## License

Legion is distributed under the **Legion Source-Available License v1.0** (LSAL). Copyright (c) 2026 Mario Aldayuz. All rights reserved.

**TL;DR — what you can do**

- Install, run, and use Legion for personal use or for your own organization's internal operations, on any number of devices you own or control.
- Read and modify the source for your own internal use.
- Publish, share, and distribute the **Output** Legion generates (wiki pages, exports, PR comments, dashboards, etc.) — anywhere, in any medium.

**Attribution is required.** Every published Output must keep a visible attribution and link, and any blog post, talk, demo, video, or screenshot featuring Legion must credit it. Use this string (or its functional equivalent in your medium):

> Built with [Legion](https://github.com/thenotoriousllama/legion) by [Mario Aldayuz](https://www.marioaldayuz.com)

**What you can't do** — redistribute the Software (modified or unmodified), host it as a service for third parties, build a competing product on top of it, remove attribution, or use the Legion name and logo beyond reasonable nominative use.

Read the full terms in [LICENSE](LICENSE). For commercial licensing, OEM redistribution, hosted offerings, or any permissions beyond the LSAL, [reach out](https://linktr.ee/marioaldayuz).
