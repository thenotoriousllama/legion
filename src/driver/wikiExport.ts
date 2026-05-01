import * as fs from "fs/promises";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ExportTarget = "docusaurus" | "html" | "markdown";

export interface ExportOptions {
  repoRoot: string;
  outputDir: string;
  target: ExportTarget;
  projectName?: string;
}

export interface ExportResult {
  pagesExported: number;
  wikilinksResolved: number;
  outputDir: string;
  durationMs: number;
}

interface WikiPage {
  relPath: string;    // relative to wikiDir, e.g. "classes/JwtService.md"
  absPath: string;
  content: string;
  title: string;
  type: string;       // entity type (first subdirectory)
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Export the Legion wiki to one of three formats.
 * Writes to a temp directory, renames on success, cleans up on failure.
 */
export async function exportWiki(options: ExportOptions): Promise<ExportResult> {
  const startMs = Date.now();
  const { repoRoot, outputDir, target } = options;

  const wikiDir = path.join(repoRoot, "library", "knowledge-base", "wiki");
  const pages = await collectWikiPages(wikiDir);
  const wikiIndex = buildWikiIndex(pages);

  const tmpDir = outputDir + "-tmp-" + Date.now();
  let wikilinksResolved = 0;

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    if (target === "markdown") {
      await exportMarkdownBundle(pages, wikiDir, tmpDir);
    } else if (target === "html") {
      wikilinksResolved = await exportStaticHtml(pages, wikiDir, wikiIndex, tmpDir);
    } else if (target === "docusaurus") {
      const projectName = options.projectName ?? await detectProjectName(repoRoot);
      wikilinksResolved = await exportDocusaurus(pages, wikiDir, wikiIndex, tmpDir, projectName);
    }

    // Atomic rename
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rename(tmpDir, outputDir);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    pagesExported: pages.length,
    wikilinksResolved,
    outputDir,
    durationMs: Date.now() - startMs,
  };
}

// ── Markdown bundle ────────────────────────────────────────────────────────────

async function exportMarkdownBundle(
  pages: WikiPage[],
  _wikiDir: string,
  outDir: string
): Promise<void> {
  for (const page of pages) {
    const destPath = path.join(outDir, page.relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, page.content, "utf8");
  }

  // Index README
  const byType = groupByType(pages);
  const indexLines = ["# Wiki Export\n"];
  for (const [type, typePages] of byType) {
    indexLines.push(`## ${capitalize(type)}\n`);
    for (const p of typePages) {
      indexLines.push(`- [${p.title || path.basename(p.relPath, ".md")}](./${p.relPath})`);
    }
    indexLines.push("");
  }
  await fs.writeFile(path.join(outDir, "README.md"), indexLines.join("\n"), "utf8");
}

// ── Static HTML ────────────────────────────────────────────────────────────────

async function exportStaticHtml(
  pages: WikiPage[],
  _wikiDir: string,
  wikiIndex: Map<string, string>,
  outDir: string
): Promise<number> {
  let totalResolved = 0;

  // Write CSS
  await fs.writeFile(path.join(outDir, "style.css"), HTML_STYLE_CSS, "utf8");

  // Build nav HTML (shared across all pages)
  const byType = groupByType(pages);
  const navHtml = buildHtmlNav(byType);

  // Write per-page HTML files
  for (const page of pages) {
    const destRel = page.relPath.replace(/\.md$/, ".html");
    const destPath = path.join(outDir, destRel);
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const depth = destRel.split(path.sep).length - 1;
    const cssHref = "../".repeat(depth) + "style.css";
    const resolved = resolveWikilinks(page.content, page.relPath, wikiIndex, "html");
    totalResolved += resolved.count;

    const htmlBody = markdownToHtml(resolved.content);
    const pageTitle = page.title || path.basename(page.relPath, ".md");

    await fs.writeFile(
      destPath,
      htmlShell(pageTitle, cssHref, navHtml, htmlBody, depth),
      "utf8"
    );
  }

  // Index page
  const indexLines = [`<h1>Wiki</h1>`, navHtml];
  await fs.writeFile(
    path.join(outDir, "index.html"),
    htmlShell("Wiki Index", "style.css", "", indexLines.join("\n"), 0),
    "utf8"
  );

  return totalResolved;
}

// ── Docusaurus ────────────────────────────────────────────────────────────────

async function exportDocusaurus(
  pages: WikiPage[],
  _wikiDir: string,
  wikiIndex: Map<string, string>,
  outDir: string,
  projectName: string
): Promise<number> {
  let totalResolved = 0;
  const docsDir = path.join(outDir, "docs");
  await fs.mkdir(docsDir, { recursive: true });

  const byType = groupByType(pages);

  for (const page of pages) {
    const destRel = page.relPath.replace(/\.md$/, ".mdx");
    const destPath = path.join(docsDir, destRel);
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const resolved = resolveWikilinks(page.content, page.relPath, wikiIndex, "docusaurus");
    totalResolved += resolved.count;

    await fs.writeFile(destPath, resolved.content, "utf8");
  }

  // sidebars.js
  const sidebarJs = generateSidebarJs(byType);
  await fs.writeFile(path.join(outDir, "sidebars.js"), sidebarJs, "utf8");

  // docusaurus.config.js
  const configJs = generateDocusaurusConfig(projectName);
  await fs.writeFile(path.join(outDir, "docusaurus.config.js"), configJs, "utf8");

  // package.json stub for Docusaurus
  const pkgJson = JSON.stringify(
    {
      name: projectName.toLowerCase().replace(/\s+/g, "-") + "-docs",
      version: "1.0.0",
      scripts: {
        start: "docusaurus start",
        build: "docusaurus build",
        serve: "docusaurus serve",
      },
      dependencies: {
        "@docusaurus/core": "^3.0.0",
        "@docusaurus/preset-classic": "^3.0.0",
        react: "^18.0.0",
        "react-dom": "^18.0.0",
      },
    },
    null,
    2
  );
  await fs.writeFile(path.join(outDir, "package.json"), pkgJson, "utf8");

  return totalResolved;
}

// ── Wikilink resolver ──────────────────────────────────────────────────────────

function resolveWikilinks(
  content: string,
  sourcePath: string,
  wikiIndex: Map<string, string>,
  format: ExportTarget
): { content: string; count: number } {
  if (format === "markdown") return { content, count: 0 };

  let count = 0;
  const resolved = content.replace(/\[\[([^\]]+)\]\]/g, (_match, ref: string) => {
    const parts = ref.split("|");
    const target = parts[0].trim();
    const label = (parts[1] ?? target).trim();

    const targetRel = wikiIndex.get(target.toLowerCase());
    if (!targetRel) return label; // broken link — degrade gracefully

    const relUrl = computeRelUrl(sourcePath, targetRel, format);
    count++;
    return `[${label}](${relUrl})`;
  });

  return { content: resolved, count };
}

function computeRelUrl(from: string, to: string, format: ExportTarget): string {
  const ext = format === "docusaurus" ? ".mdx" : ".html";
  const fromDir = path.dirname(from);
  const toWithExt = to.replace(/\.md$/, ext);
  let rel = path.relative(fromDir, toWithExt).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function collectWikiPages(wikiDir: string): Promise<WikiPage[]> {
  const pages: WikiPage[] = [];
  await walkDir(wikiDir, wikiDir, pages);
  return pages;
}

async function walkDir(rootDir: string, dir: string, pages: WikiPage[]): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(rootDir, abs, pages);
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
      try {
        const content = await fs.readFile(abs, "utf8");
        const relPath = path.relative(rootDir, abs).replace(/\\/g, "/");
        const type = relPath.split("/")[0] ?? "other";
        const title = extractTitle(content) || path.basename(relPath, ".md");
        pages.push({ relPath, absPath: abs, content, title, type });
      } catch {
        // skip unreadable files
      }
    }
  }
}

function buildWikiIndex(pages: WikiPage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const page of pages) {
    const name = path.basename(page.relPath, ".md");
    index.set(name.toLowerCase(), page.relPath);
    index.set(page.title.toLowerCase(), page.relPath);
  }
  return index;
}

function groupByType(pages: WikiPage[]): Map<string, WikiPage[]> {
  const map = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const list = map.get(page.type) ?? [];
    list.push(page);
    map.set(page.type, list);
  }
  return map;
}

function extractTitle(content: string): string {
  const m = content.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : "";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function detectProjectName(repoRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as { name?: string };
    return pkg.name ?? path.basename(repoRoot);
  } catch {
    return path.basename(repoRoot);
  }
}

// ── Generators ────────────────────────────────────────────────────────────────

function generateSidebarJs(byType: Map<string, WikiPage[]>): string {
  const categories = [...byType.entries()].map(([type, typePages]) => {
    const items = typePages
      .map((p) => `'${type}/${path.basename(p.relPath, ".md")}'`)
      .join(",\n        ");
    return `    {
      type: 'category',
      label: '${capitalize(type)}',
      items: [${items}],
    }`;
  });
  return `// Auto-generated by Legion exportWiki\nmodule.exports = { tutorialSidebar: [\n${categories.join(",\n")}\n] };\n`;
}

function generateDocusaurusConfig(projectName: string): string {
  return `// Auto-generated by Legion exportWiki
// @ts-check
const { themes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: '${projectName}',
  tagline: 'Auto-generated by Legion',
  favicon: 'img/favicon.ico',
  url: 'https://your-docusaurus-site.example.com',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: { sidebarPath: require.resolve('./sidebars.js'), routeBasePath: '/' },
        blog: false,
      },
    ],
  ],
};

module.exports = config;
`;
}

function buildHtmlNav(byType: Map<string, WikiPage[]>): string {
  const sections = [...byType.entries()].map(([type, typePages]) => {
    const links = typePages
      .map((p) => {
        const href = p.relPath.replace(/\.md$/, ".html");
        return `      <li><a href="${href}">${p.title || path.basename(p.relPath, ".md")}</a></li>`;
      })
      .join("\n");
    return `  <details open><summary>${capitalize(type)}</summary><ul>\n${links}\n  </ul></details>`;
  });
  return `<nav class="sidebar">\n${sections.join("\n")}\n</nav>`;
}

function htmlShell(
  title: string,
  cssHref: string,
  nav: string,
  body: string,
  _depth: number
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${cssHref}">
</head>
<body>
  <div class="layout">
    ${nav}
    <main class="content">
      ${body}
    </main>
  </div>
</body>
</html>`;
}

/** Minimal Markdown → HTML (headings, code fences, bold, italics, links, paragraphs). */
function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
        out.push(`<pre><code class="language-${escapeHtml(codeLang)}">`);
      } else {
        inCode = false;
        out.push("</code></pre>");
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inlineMarkdown(h[2])}</h${level}>`);
      continue;
    }

    if (line.trim() === "") {
      out.push("<br>");
      continue;
    }

    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  return out.join("\n");
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Embedded CSS ───────────────────────────────────────────────────────────────

const HTML_STYLE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.6;
  color: #1a1a2e;
  background: #f8f9fa;
}

.layout {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 260px;
  min-width: 220px;
  background: #fff;
  border-right: 1px solid #e2e8f0;
  padding: 24px 16px;
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100vh;
}

.sidebar details { margin-bottom: 8px; }
.sidebar summary {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  cursor: pointer;
  padding: 4px 0;
}
.sidebar ul { list-style: none; padding-left: 8px; margin-top: 4px; }
.sidebar li { margin: 2px 0; }
.sidebar a {
  color: #334155;
  text-decoration: none;
  font-size: 13px;
  display: block;
  padding: 2px 6px;
  border-radius: 4px;
}
.sidebar a:hover { background: #f1f5f9; color: #0f172a; }

.content {
  flex: 1;
  max-width: 860px;
  padding: 40px 48px;
  overflow-x: auto;
}

h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  line-height: 1.3;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  color: #0f172a;
}
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin-bottom: 1em; }
a { color: #2563eb; }
a:hover { text-decoration: underline; }
code { background: #f1f5f9; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; font-family: 'Fira Code', 'Cascadia Code', monospace; }
pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; margin-bottom: 1em; }
pre code { background: none; padding: 0; color: inherit; font-size: 0.85em; }
strong { font-weight: 700; }
em { font-style: italic; }

@media (max-width: 720px) {
  .layout { flex-direction: column; }
  .sidebar { width: 100%; height: auto; position: static; border-right: none; border-bottom: 1px solid #e2e8f0; }
  .content { padding: 24px 16px; }
}
`;
