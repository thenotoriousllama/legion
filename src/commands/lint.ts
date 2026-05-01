import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { InvocationPayload, ChunkFile } from "../types/payload";
import type { LintFinding } from "../types/response";
import { invokeAgent } from "../driver/agentInvoker";

const LINT_CHUNK_SIZE = 10;
const WIKI_DIRS = ["entities", "concepts", "decisions", "comparisons", "questions", "meta"];

/**
 * Lint Wiki — validates all wiki pages by invoking wiki-guardian in lint mode
 * in parallel chunks, then runs driver-side orphan detection and writes a
 * dated lint report to `library/knowledge-base/wiki/meta/<date>-lint-report.md`.
 * Reports only — never auto-fixes.
 */
export async function lintWiki(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }
  const repoRoot = folders[0].uri.fsPath;
  const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Legion: Lint Wiki",
      cancellable: false,
    },
    async (progress) => {
      // 1. Walk wiki pages
      progress.report({ message: "Collecting wiki pages…", increment: 10 });
      const allPages: ChunkFile[] = [];
      for (const dir of WIKI_DIRS) {
        const dirPath = path.join(wikiRoot, dir);
        let entries: string[];
        try {
          entries = await fs.readdir(dirPath);
        } catch {
          continue;
        }
        for (const file of entries) {
          if (!file.endsWith(".md")) continue;
          const absPath = path.join(dirPath, file);
          try {
            const content = await fs.readFile(absPath, "utf8");
            allPages.push({ path: `${dir}/${file}`, content });
          } catch {
            // skip unreadable
          }
        }
      }

      if (allPages.length === 0) {
        vscode.window.showInformationMessage(
          "Legion: No wiki pages found. Run Document Repository first."
        );
        return;
      }

      // 2. Chunk into groups of LINT_CHUNK_SIZE
      const chunks: ChunkFile[][] = [];
      for (let i = 0; i < allPages.length; i += LINT_CHUNK_SIZE) {
        chunks.push(allPages.slice(i, i + LINT_CHUNK_SIZE));
      }

      progress.report({ message: `Linting ${allPages.length} pages in ${chunks.length} chunk(s)…`, increment: 10 });

      const vsconfig = vscode.workspace.getConfiguration("legion");
      const maxParallel = vsconfig.get<number>("maxParallelAgents", 3);

      // 3. Invoke wiki-guardian per chunk with mode: "lint"
      const allFindings: LintFinding[] = [];
      const lintErrors: string[] = [];
      let cursor = 0;

      async function worker(): Promise<void> {
        for (;;) {
          const idx = cursor++;
          if (idx >= chunks.length) return;
          const chunk = chunks[idx];
          progress.report({
            message: `Linting chunk ${idx + 1}/${chunks.length}…`,
            increment: Math.floor(60 / chunks.length),
          });

          const payload: InvocationPayload = {
            mode: "lint",
            chunk,
            git_context: Object.fromEntries(
              chunk.map((f) => [
                f.path,
                {
                  created_commit: "",
                  created_at: "",
                  last_commit: { sha: "", author: "", timestamp: "", message: "" },
                  recent_commits: [],
                  blame_summary: { top_authors: [], churn_rate: "unknown" },
                },
              ])
            ),
            prior_state: chunk.map((f) => ({ path: f.path, frontmatter: {} })),
            wiki_root: wikiRoot,
            page_caps: { max_lines_per_page: 300, target_pages_per_chunk: [8, 15] },
            callout_vocabulary: ["[!contradiction]", "[!stale]", "[!gap]", "[!key-insight]"],
          };

          try {
            const response = await invokeAgent("wiki-guardian", payload, repoRoot, context);
            allFindings.push(...response.lint_findings);
          } catch (e) {
            lintErrors.push(
              `Chunk ${idx + 1} lint failed: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(maxParallel, chunks.length) }, worker)
      );

      // 4. Driver-side orphan detection — pages referenced via [[wikilink]] that
      //    don't exist on disk
      progress.report({ message: "Checking for orphan wikilinks…", increment: 5 });
      const orphanFindings = await detectOrphans(allPages, wikiRoot);
      allFindings.push(...orphanFindings);

      // 5. Write lint report
      progress.report({ message: "Writing lint report…", increment: 5 });
      const reportPath = await writeLintReport(wikiRoot, allFindings, lintErrors);

      // 6. Surface summary
      const errors = allFindings.filter((f) => f.severity === "error").length;
      const warnings = allFindings.filter((f) => f.severity === "warning").length;
      const infos = allFindings.filter((f) => f.severity === "info").length;

      const summaryMsg = `Legion: Lint complete — ${errors} error(s), ${warnings} warning(s), ${infos} info(s).${lintErrors.length > 0 ? ` ${lintErrors.length} invocation error(s).` : ""}`;

      const openReport = await vscode.window.showInformationMessage(
        summaryMsg,
        "Open Report"
      );
      if (openReport === "Open Report") {
        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc);
      }
    }
  );
}

async function detectOrphans(
  pages: ChunkFile[],
  wikiRoot: string
): Promise<LintFinding[]> {
  const pageSet = new Set(pages.map((p) => p.path.replace(/\.md$/, "")));
  const findings: LintFinding[] = [];
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;

  for (const page of pages) {
    let m: RegExpExecArray | null;
    wikilinkRe.lastIndex = 0;
    while ((m = wikilinkRe.exec(page.content)) !== null) {
      const target = m[1].trim();
      if (!pageSet.has(target)) {
        // Also check if the target file actually exists on disk
        const absTarget = path.join(wikiRoot, target + ".md");
        try {
          await fs.access(absTarget);
        } catch {
          findings.push({
            severity: "warning",
            category: "unresolved-in-chunk",
            page: page.path,
            details: { unresolved_link: target },
          });
        }
      }
    }
  }
  return findings;
}

async function writeLintReport(
  wikiRoot: string,
  findings: LintFinding[],
  errors: string[]
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(wikiRoot, "meta", `${date}-lint-report.md`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  const errorFindings = findings.filter((f) => f.severity === "error");
  const warnFindings = findings.filter((f) => f.severity === "warning");
  const infoFindings = findings.filter((f) => f.severity === "info");

  const lines = [
    `---`,
    `type: meta`,
    `title: "Lint Report ${date}"`,
    `created: "${date}"`,
    `tags: [meta, lint]`,
    `---`,
    ``,
    `# Lint Report — ${date}`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
    `| error | ${errorFindings.length} |`,
    `| warning | ${warnFindings.length} |`,
    `| info | ${infoFindings.length} |`,
    ``,
  ];

  for (const [label, group] of [
    ["Errors", errorFindings],
    ["Warnings", warnFindings],
    ["Info", infoFindings],
  ] as Array<[string, LintFinding[]]>) {
    if (group.length === 0) continue;
    lines.push(`## ${label}`, ``);
    for (const f of group) {
      lines.push(
        `- **${f.category}** in \`${f.page}\`: ${JSON.stringify(f.details)}`
      );
    }
    lines.push(``);
  }

  if (errors.length > 0) {
    lines.push(`## Invocation errors`, ``);
    for (const e of errors) lines.push(`- ${e}`);
    lines.push(``);
  }

  await fs.writeFile(reportPath, lines.join("\n"));
  return reportPath;
}
