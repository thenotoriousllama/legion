import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { callLlm, type LlmConfig } from "../driver/llmClient";

const exec = promisify(execFile);
const WIKI_REL = path.join("library", "knowledge-base", "wiki");

// Decision-encoding patterns (same heuristics as wiki-guardian Phase 5)
const DECISION_PATTERNS = [
  /^switch\s+(from\s+)?.+\s+to\s+/i,
  /^migrate\s+(from\s+)?.+\s+to\s+/i,
  /^replace\s+.+\s+with\s+/i,
  /^deprecate\s+/i,
  /^adopt\s+/i,
  /^refactor\s+/i,
  /^restructure\s+/i,
  /Decision:/m,
  /Rationale:/m,
  /RFC:/m,
  /ADR:/m,
];

const ARCHAEOLOGY_SYSTEM =
  "You are a software archaeology assistant. Given a list of git commits for a source file, synthesize a concise architectural narrative explaining why this file exists, how it evolved, and what key decisions shaped it. Focus on intent and architecture — not code details.";

/**
 * Trace all git commits for a file, identify architectural decisions, and
 * synthesize a narrative filed as a wiki decisions page.
 */
export async function archaeologyFile(
  repoRoot: string,
  context: vscode.ExtensionContext
): Promise<void> {
  void context;
  if (!repoRoot) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }

  // Resolve file path — from active editor or right-click URI
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Legion: Open a file in the editor first.");
    return;
  }
  const absPath = editor.document.uri.fsPath;
  const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");

  const cfg = vscode.workspace.getConfiguration("legion");
  const llmConfig = buildLlmConfig(cfg);

  if (cfg.get<string>("apiProvider", "anthropic") === "anthropic" && !llmConfig.anthropicApiKey) {
    vscode.window.showWarningMessage(
      "Legion: Set legion.anthropicApiKey to use Commit Archaeology."
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Digging into history of ${path.basename(absPath)}…`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Loading git history…", increment: 20 });

      // Get full commit history for the file (following renames)
      let allCommits: CommitRecord[] = [];
      try {
        allCommits = await getFullHistory(repoRoot, relPath);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: Git history unavailable — ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }

      if (allCommits.length === 0) {
        vscode.window.showInformationMessage(
          "Legion: No commit history found for this file."
        );
        return;
      }

      // Filter for decision-encoding commits
      const decisionCommits = allCommits.filter((c) =>
        DECISION_PATTERNS.some((re) => re.test(c.subject) || re.test(c.body))
      );

      progress.report({
        message: `Found ${allCommits.length} commits (${decisionCommits.length} decision-encoding) — synthesizing narrative…`,
        increment: 30,
      });

      // Build synthesis prompt
      const prompt = buildArchaeologyPrompt(relPath, allCommits, decisionCommits);
      let narrative: string;
      try {
        narrative = await callLlm(llmConfig, ARCHAEOLOGY_SYSTEM, prompt);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Legion: LLM call failed — ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }

      progress.report({ message: "Writing wiki page…", increment: 30 });

      // File the narrative
      const wikiRoot = path.join(repoRoot, WIKI_REL);
      const slug = slugify(relPath);
      const dateStr = new Date().toISOString().slice(0, 10);
      const pagePath = `decisions/${slug}-history.md`;
      const absPagePath = path.join(wikiRoot, "decisions", `${slug}-history.md`);

      const pageContent = [
        `---`,
        `type: decision`,
        `title: "Archaeology: ${relPath}"`,
        `source_file: ${relPath}`,
        `commit_count: ${allCommits.length}`,
        `decision_commits: ${decisionCommits.length}`,
        `created: "${dateStr}"`,
        `tags: [archaeology, history, decision]`,
        `---`,
        ``,
        `# Archaeology — ${path.basename(relPath)}`,
        ``,
        `> Auto-generated narrative from ${allCommits.length} commits (${decisionCommits.length} with decision-encoding patterns).`,
        `> Source: \`${relPath}\``,
        ``,
        narrative,
        ``,
        `## Commit Timeline`,
        ``,
        `| Date | Commit | Message |`,
        `|------|--------|---------|`,
        ...allCommits.slice(0, 20).map(
          (c) => `| ${c.date.slice(0, 10)} | \`${c.sha.slice(0, 7)}\` | ${c.subject.slice(0, 60)} |`
        ),
        allCommits.length > 20 ? `| … | … | +${allCommits.length - 20} more commits |` : "",
      ]
        .filter((l) => l !== "")
        .join("\n");

      await fs.mkdir(path.dirname(absPagePath), { recursive: true });
      await fs.writeFile(absPagePath, pageContent);

      // Append to log.md
      try {
        await fs.appendFile(
          path.join(wikiRoot, "log.md"),
          `\n## [${dateStr}] archaeology | ${relPath} | created: 1\n`
        );
      } catch {}

      progress.report({ message: "Done!", increment: 20 });

      // Open in side column
      const doc = await vscode.workspace.openTextDocument(absPagePath);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      vscode.window.showInformationMessage(
        `Legion: Archaeology filed — ${pagePath}`
      );
    }
  );
}

// ── Git helpers ───────────────────────────────────────────────────────────────

interface CommitRecord {
  sha: string;
  date: string;
  subject: string;
  body: string;
}

async function getFullHistory(repoRoot: string, relPath: string): Promise<CommitRecord[]> {
  const opts = { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 };
  const sep = "|||COMMIT|||";
  const { stdout } = await exec(
    "git",
    ["log", "--follow", `--format=%H|%aI|%s|%b${sep}`, "--", relPath],
    opts
  );

  return stdout
    .split(sep)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const firstPipe = block.indexOf("|");
      const secondPipe = block.indexOf("|", firstPipe + 1);
      const thirdPipe = block.indexOf("|", secondPipe + 1);
      return {
        sha: block.slice(0, firstPipe),
        date: block.slice(firstPipe + 1, secondPipe),
        subject: block.slice(secondPipe + 1, thirdPipe),
        body: block.slice(thirdPipe + 1).trim(),
      };
    })
    .filter((c) => c.sha);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildArchaeologyPrompt(
  relPath: string,
  allCommits: CommitRecord[],
  decisionCommits: CommitRecord[]
): string {
  const commitLines = allCommits
    .slice(0, 30)
    .map((c) => `- ${c.date.slice(0, 10)} [${c.sha.slice(0, 7)}]: ${c.subject}${c.body ? `\n  ${c.body.slice(0, 200)}` : ""}`)
    .join("\n");

  const decisionLines =
    decisionCommits.length > 0
      ? decisionCommits
          .map((c) => `- ${c.date.slice(0, 10)}: ${c.subject}`)
          .join("\n")
      : "None identified.";

  return `File: ${relPath}
Total commits: ${allCommits.length}

## All commits (most recent first)
${commitLines}${allCommits.length > 30 ? `\n... (${allCommits.length - 30} older commits omitted)` : ""}

## Decision-encoding commits
${decisionLines}

---

Write a 3-5 paragraph architectural narrative explaining:
1. Why this file was originally created (infer from earliest commits)
2. How it evolved and what key changes were made
3. What architectural decisions shaped its current form
4. Any patterns of deprecation, migration, or refactoring

Be concise and factual. Reference specific commit messages when relevant.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildLlmConfig(cfg: vscode.WorkspaceConfiguration): LlmConfig {
  const provider = cfg.get<"anthropic" | "openrouter">("apiProvider", "anthropic");
  return {
    provider,
    anthropicApiKey: cfg.get<string>("anthropicApiKey") || process.env.LEGION_ANTHROPIC_API_KEY || "",
    openRouterApiKey: cfg.get<string>("openRouterApiKey") || process.env.LEGION_OPENROUTER_API_KEY || "",
    model: provider === "openrouter"
      ? (cfg.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
      : (cfg.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 4096,
  };
}
