# Feature #003: Wiki Export — Docusaurus, Static HTML, and Markdown Bundle

> **Legion VS Code Extension** — Feature PRD #003 of 6
>
> **Status:** Ready for implementation
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Phase Overview

### Goals

Legion's wiki lives exclusively in `library/knowledge-base/wiki/` — a directory of Markdown files with `[[wikilinks]]`, frontmatter, and entity-type taxonomy folders. This is great for developers inside the VS Code + Cursor ecosystem but inaccessible to stakeholders who don't have the repo checked out: product managers, technical writers, external clients, open-source consumers, and QA teams who want browsable documentation.

This PRD defines a `legion.exportWiki` command that translates the internal wiki into three industry-standard documentation formats: Docusaurus v3 (for hosted developer docs sites), plain static HTML (zero-dependency, shareable as a zip or hosted on S3/GitHub Pages), and a raw Markdown bundle (for import into Confluence, Notion, GitBook, or Obsidian). The export is idempotent and cleans its output directory on each run. `[[wikilinks]]` are resolved into relative URLs appropriate for each target format. A sidebar button in the Legion webview provides one-click access.

### Scope

- New command: `legion.exportWiki` registered in `extension.ts` and `package.json`
- Three export targets selectable via `legion.exportTarget` setting: `docusaurus`, `html`, `markdown`
- `[[wikilinks]]` → relative URL conversion for Docusaurus and HTML targets
- Frontmatter preservation: each page's frontmatter is forwarded as Docusaurus metadata or as HTML `<meta>` tags
- Setting `legion.exportOutputDir` (string, default `"./docs-export"`) for output location
- Idempotent: delete + recreate output directory on each export run
- Sidebar footer button: "Export Wiki…" opens a QuickPick to choose the target format
- Docusaurus `sidebars.js` auto-generated with categories per Legion entity type (Class, Function, Component, Service, etc.)

### Out of scope

- Incremental export (diff-based updates to an existing Docusaurus site) — too complex for Phase 1; full rebuild is fast enough for up to 2,000 pages
- PDF generation — requires a headless browser dependency; separate PRD
- Uploading to hosting platforms (Netlify, Vercel, GitHub Pages) — deployment is out of scope; users run `npm run build` on the Docusaurus output themselves
- Real-time export on file change (watch mode) — out of scope
- Exporting non-wiki `library/` folders (requirements, qa) — only `knowledge-base/wiki/` is exported

### Dependencies

- **Blocks:** none
- **Blocked by:** none
- **External:** For Docusaurus output, users need Node.js + Docusaurus v3 installed in the output directory. Legion generates the source files; users run `npx docusaurus build` themselves.

---

## User Stories

### US-3.1 — Docusaurus export

**As a** developer who maintains a public-facing docs site, **I want to** export the Legion wiki as a Docusaurus v3 project, **so that** I can host searchable, navigable documentation for my open-source project without manually maintaining a separate docs directory.

**Acceptance criteria:**
- AC-3.1.1 Given `legion.exportTarget` is `docusaurus`, when I run `legion.exportWiki`, then `docs-export/docs/` is populated with one MDX file per wiki page, maintaining the entity-type subdirectory structure.
- AC-3.1.2 `docs-export/sidebars.js` contains one category per entity type, with all pages of that type listed as items.
- AC-3.1.3 `[[wikilink]]` references in page content are converted to Docusaurus relative `[label](./path.mdx)` links.
- AC-3.1.4 Each page's YAML frontmatter (`title`, `type`, `status`, `tags`) is converted to Docusaurus frontmatter fields.
- AC-3.1.5 `docs-export/docusaurus.config.js` is generated with the project name populated from `legion.projectName` setting (or `package.json` `name` field as fallback).
- AC-3.1.6 Running `npx docusaurus build` inside `docs-export/` succeeds without errors (verified manually in acceptance testing).

### US-3.2 — Static HTML export

**As a** developer who wants to share documentation without requiring a build step, **I want to** export the wiki as a self-contained static HTML site, **so that** I can zip the output folder and email it or host it on S3 without any framework setup.

**Acceptance criteria:**
- AC-3.2.1 Given `legion.exportTarget` is `html`, when I run `legion.exportWiki`, then `docs-export/` contains one `.html` file per wiki page, an `index.html` with a full sidebar nav, and a `style.css` with minimal styling.
- AC-3.2.2 `[[wikilinks]]` are converted to `<a href="../{type}/{name}.html">` relative links.
- AC-3.2.3 Opening `docs-export/index.html` directly in a browser (file:// protocol, no server) renders a readable, navigable site.
- AC-3.2.4 The site has a sidebar listing all entity types and their pages; clicking a page navigates to it.
- AC-3.2.5 No JavaScript framework is used — only vanilla HTML, CSS, and optionally minimal vanilla JS for sidebar toggle.

### US-3.3 — Markdown bundle export

**As a** technical writer who maintains Confluence or Notion documentation, **I want to** export the Legion wiki as a flat Markdown bundle, **so that** I can import it into my company's documentation platform without any conversion.

**Acceptance criteria:**
- AC-3.3.1 Given `legion.exportTarget` is `markdown`, when I run `legion.exportWiki`, then `docs-export/` contains a copy of the entire `library/knowledge-base/wiki/` tree with `[[wikilinks]]` preserved (not converted).
- AC-3.3.2 A `docs-export/README.md` index file lists all pages grouped by entity type with file paths.
- AC-3.3.3 The output is a valid zip-able directory (no absolute paths, no symlinks).

### US-3.4 — Idempotent re-export

**As a** developer running export in CI, **I want** each export run to produce a clean, deterministic output, **so that** I can commit the `docs-export/` directory to a separate `gh-pages` branch and have diffs reflect only real wiki changes.

**Acceptance criteria:**
- AC-3.4.1 Each export deletes the `docs-export/` directory before writing, ensuring no stale files from previous runs.
- AC-3.4.2 Two consecutive export runs on the same wiki content produce byte-identical output (deterministic file ordering, no timestamps in content).
- AC-3.4.3 The export operation is atomic from the user's perspective: if it fails mid-way, the partial output directory is cleaned up.

### US-3.5 — Format selection via sidebar button

**As a** developer browsing the Legion sidebar, **I want** a one-click "Export Wiki…" button in the sidebar footer, **so that** I don't need to open the command palette to export.

**Acceptance criteria:**
- AC-3.5.1 The sidebar footer contains an "Export Wiki…" button (icon + label).
- AC-3.5.2 Clicking it opens a QuickPick with three options: "Docusaurus v3", "Static HTML", "Markdown Bundle".
- AC-3.5.3 Selecting an option runs `legion.exportWiki` with the corresponding target, then shows a notification: "Wiki exported to docs-export/ (Docusaurus) — Open folder?"

---

## Data Model Changes

None. The export is a read-only pass over the existing wiki files.

---

## API / Endpoint Specs

No HTTP API. This is a pure file-system transformation.

### Internal API — `wikiExport.ts`

```typescript
export type ExportTarget = 'docusaurus' | 'html' | 'markdown';

export interface ExportOptions {
  repoRoot: string;
  outputDir: string;   // absolute path
  target: ExportTarget;
  projectName?: string;
}

export interface ExportResult {
  pagesExported: number;
  wikilinksResolved: number;
  outputDir: string;
  durationMs: number;
}

export async function exportWiki(options: ExportOptions): Promise<ExportResult>;
```

---

## UI/UX Description

### Sidebar button

In the Legion sidebar webview footer row (alongside existing buttons like "Document", "Update", "Find Entity"), add a new button:

- **Icon:** `$(desktop-download)` (VS Code codicon)
- **Label:** "Export Wiki…"
- **Tooltip:** "Export wiki as Docusaurus, HTML, or Markdown"
- **On click:** sends `legion.exportWiki` command to the extension host; extension shows a QuickPick before running

### QuickPick — format selector

```
Export Wiki As…
────────────────────────────────────────
$(globe) Docusaurus v3        Hosted docs site with sidebar and search
$(file-code) Static HTML      Self-contained, zero-dependency site
$(markdown) Markdown Bundle   Raw Markdown for Confluence, Notion, GitBook
```

### Progress notification

During export (which may take 5-30 seconds for a large wiki), a VS Code progress notification appears in the bottom-right:
- "Legion: Exporting wiki (Docusaurus)… 45/312 pages"

After completion:
- "Wiki exported to `docs-export/` — [Open folder]"

---

## Technical Considerations

### Wikilink resolution

`[[wikilinks]]` in Legion pages follow the pattern `[[EntityType/EntityName]]` or `[[EntityName]]`. The resolver must:

1. Parse all `[[...]]` references from page content using a regex: `/\[\[([^\]]+)\]\]/g`
2. For each reference, find the matching page in the wiki by path or name
3. Compute the relative URL from the source page to the target page
4. Replace with the format-appropriate link:
   - Docusaurus: `[EntityName](../classes/EntityName.mdx)`
   - HTML: `[EntityName](../classes/EntityName.html)`
   - Markdown: preserve `[[EntityName]]` as-is

```typescript
function resolveWikilinks(
  content: string,
  sourcePath: string,
  wikiIndex: Map<string, string>, // name → absolute path
  format: ExportTarget
): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (match, ref) => {
    const parts = ref.split('|'); // [[Target|label]] syntax
    const target = parts[0].trim();
    const label  = parts[1]?.trim() ?? target;

    if (format === 'markdown') return match; // preserve as-is

    const targetPath = resolveWikiRef(target, wikiIndex);
    if (!targetPath) return label; // broken link — degrade gracefully

    const relUrl = computeRelativeUrl(sourcePath, targetPath, format);
    return `[${label}](${relUrl})`;
  });
}
```

### Docusaurus sidebar generation

Legion's wiki uses entity-type subdirectories: `wiki/classes/`, `wiki/functions/`, `wiki/components/`, etc. Each directory becomes a Docusaurus sidebar category. The `sidebars.js` generator:

```typescript
function generateSidebarJs(pagesByType: Map<string, string[]>): string {
  const categories = [...pagesByType.entries()].map(([type, pages]) => {
    const items = pages.map(p => `'${type}/${path.basename(p, '.md')}'`).join(',\n      ');
    return `    {
      type: 'category',
      label: '${capitalize(type)}',
      items: [${items}],
    }`;
  });
  return `module.exports = { tutorialSidebar: [\n${categories.join(',\n')}\n] };\n`;
}
```

### Static HTML generation

Each page is wrapped in a minimal HTML shell with:
- Inline `<style>` linking to `../style.css`
- `<nav>` sidebar generated once (the same HTML fragment in every page — use a `sidebar.html` include or duplicate it)
- `<main>` containing the Markdown rendered to HTML via a tiny Markdown→HTML converter (use `marked` library if already a transitive dep, otherwise a regex-based minimal converter for headings/code/links only)
- `<title>` from the page's `title` frontmatter field

The shared `style.css` uses system fonts, max-width 860px, syntax highlighting via `<pre><code>` without a JS highlighter.

### Atomicity

The export writes to a temp directory (`docs-export-tmp-<timestamp>`), and on success renames it to `docs-export`. If the export fails, the temp directory is cleaned up and the previous `docs-export/` is left intact.

```typescript
const tmpDir = outputDir + '-tmp-' + Date.now();
try {
  await exportToDir(tmpDir, options);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rename(tmpDir, outputDir);
} catch (err) {
  await fs.rm(tmpDir, { recursive: true, force: true });
  throw err;
}
```

### Performance

For a 500-page wiki, the export is dominated by file I/O. Expected runtime:
- Docusaurus: ~3s (500 reads + 500 writes + sidebar generation)
- HTML: ~5s (500 reads + Markdown→HTML conversion + 500 writes + index.html)
- Markdown: ~1s (500 file copies)

No parallelism is needed for Phase 1 — sequential `for...of` with `await fs.readFile / writeFile` is sufficient. If latency becomes an issue, `Promise.allSettled` batching (50 pages at a time) can be added.

---

## Files Touched

### New files

- `src/commands/exportWiki.ts` — command handler; shows QuickPick; calls `wikiExport.ts`; shows progress notification
- `src/driver/wikiExport.ts` — `exportWiki()` function; format-specific renderers; wikilink resolver
- `src/driver/wikiExport.test.ts` — unit tests for wikilink resolver, sidebar generator, HTML template
- `bundled/export-templates/docusaurus.config.js.hbs` — Handlebars (or simple string template) for `docusaurus.config.js`
- `bundled/export-templates/html-shell.html.hbs` — HTML shell template for static HTML export
- `bundled/export-templates/html-style.css` — minimal CSS stylesheet for static HTML export

### Modified files

- `extension.ts` — register `legion.exportWiki` command
- `package.json` — add `legion.exportWiki` to `contributes.commands`; add `legion.exportTarget` and `legion.exportOutputDir` to `contributes.configuration`
- `src/sidebar/sidebarProvider.ts` (or equivalent webview provider) — add "Export Wiki…" button to footer row
- `README.md` — document export feature with format descriptions and output examples

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — Core export engine (Markdown bundle)

Implement `wikiExport.ts` with:
- `collectWikiPages()` — reads all `.md` files under `library/knowledge-base/wiki/`
- `exportMarkdownBundle()` — file copy + README index generation
- Atomicity wrapper (tmp dir + rename)

Acceptance: `legion.exportWiki` with `markdown` target produces a clean copy of the wiki directory.

### Phase 2 — Wikilink resolver + static HTML

Implement:
- `resolveWikilinks()` — regex-based `[[...]]` → relative URL conversion
- `exportStaticHtml()` — Markdown → minimal HTML conversion; sidebar nav; index.html

Acceptance: `html` target produces a browsable site at `file:///docs-export/index.html`.

### Phase 3 — Docusaurus target + sidebar

Implement:
- `exportDocusaurus()` — frontmatter preservation; MDX output; `sidebars.js` generation; `docusaurus.config.js` from template
- QuickPick sidebar button in `sidebarProvider.ts`
- Progress notification with page counter

Acceptance: `docusaurus` target output passes `npx docusaurus build`.

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Export runtime (500-page wiki, HTML target) | ≤ 10s | Instrument `durationMs` in `ExportResult` |
| Wikilink resolution accuracy (no broken links in output) | ≥ 98% | Count unresolved refs in smoke test |
| Docusaurus build success on exported output | 100% | Manual smoke test before ship |
| Idempotency (two runs produce identical output) | 100% byte-identical | `diff -r run1/ run2/` in CI |
| Zero VS Code API calls during export (pure Node.js path) | 0 | Verify MCP server can call export tool without VS Code APIs |

---

## Open Questions

- **Q1:** Should the `marked` library be added as a dependency for Markdown → HTML conversion, or implement a minimal regex-based converter? `marked` is 47 kB minified and well-tested; a minimal converter risks edge-case failures on complex Markdown. **Current plan:** use `marked` if it is already a transitive dependency; otherwise minimal inline converter for Phase 1.
- **Q2:** Should `docs-export/` be `.gitignore`d by default, or should Legion recommend committing it to a `gh-pages` branch? **Plan:** do not auto-ignore it; add a note in the completion notification: "Tip: add `docs-export/` to `.gitignore` or use a separate branch for hosting."
- **Q3:** What should happen to Markdown code fences with language identifiers in the HTML export? **Plan:** wrap in `<pre><code class="language-{lang}">` — compatible with Prism.js highlight.js if the user adds it later; no highlighting in Phase 1.

---

## Risks and Open Questions

- **Risk:** Large wikis (2,000+ pages) produce a static HTML site where the full sidebar nav is duplicated in every page (increasing total output size). **Mitigation:** for Phase 1 this is acceptable (each page is ~10 KB, nav duplicate is ~5 KB — negligible). Phase 2 can introduce a shared `nav.js` that dynamically renders the sidebar from a JSON manifest.
- **Risk:** `[[wikilinks]]` that reference non-existent pages will produce broken links in HTML/Docusaurus output. **Mitigation:** the wikilink resolver logs all unresolved references to the Legion output channel and degrades gracefully (replaces `[[Missing]]` with plain text `Missing` rather than a broken `<a>` tag).
- **Risk:** Docusaurus v3 MDX parser may reject certain Markdown syntax that Legion wiki pages use (e.g., raw HTML in Markdown, unusual Markdown extensions). **Mitigation:** test against a representative 50-page sample before ship; add MDX-safe escaping for angle brackets outside code fences.

---

## Related

- [`feature-001-semantic-search/prd-feature-001-semantic-search.md`](../feature-001-semantic-search/prd-feature-001-semantic-search.md) — exported pages are the same wiki pages searched by this module
- [`feature-002-mcp-server/prd-feature-002-mcp-server.md`](../feature-002-mcp-server/prd-feature-002-mcp-server.md) — a future `legion_export_wiki` MCP tool can expose this capability to agents
- [`feature-006-pr-review-bot/prd-feature-006-pr-review-bot.md`](../feature-006-pr-review-bot/prd-feature-006-pr-review-bot.md) — PR bot could trigger an export pass as part of its CI workflow
