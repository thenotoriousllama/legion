import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { Mode, InvocationPayload, PriorPage } from "../types/payload";
import type { LegionIgnore } from "./legionignore";
import type { HashManifest } from "./hashDiff";
import { loadLegionIgnore } from "./legionignore";
import { mergeSharedIgnore } from "./sharedConfig";
import { diffFiles, loadManifest } from "./hashDiff";
import { planChunks, loadChunkContent, topLevelModule } from "./chunkPlanner";
import { getGitContextManyCached } from "./gitContextCache";
import { invokeAgent } from "./agentInvoker";
import { reconcile, type ChunkResult } from "./reconciler";
import { autoCommitWiki } from "./gitCommit";
import { resolveWikiRoot, resolveScanRoots } from "../util/repoRoot";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_CAPS: InvocationPayload["page_caps"] = {
  max_lines_per_page: 300,
  target_pages_per_chunk: [8, 15],
};

const CALLOUT_VOCABULARY: string[] = [
  "[!contradiction]",
  "[!stale]",
  "[!gap]",
  "[!key-insight]",
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full Document / Update / Scan-Directory pass.
 *
 * Orchestrates: repo walk → hash diff → chunk planning → git context
 * pre-computation → parallel agent invocation → post-pass reconciliation.
 *
 * @param repoRoot  Absolute path to the repo root.
 * @param mode      "document" | "update" | "scan-directory"
 * @param scopeDir  Optional absolute path; when set, only files within this
 *                  subtree are walked (used by scan-directory mode).
 * @param context   VS Code extension context (passed through to agentInvoker).
 */
export async function runDocumentPass(
  repoRoot: string,
  mode: Mode,
  scopeDir: string | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const vsConfig = vscode.workspace.getConfiguration("legion");
  const maxParallel = vsConfig.get<number>("maxParallelAgents", 6);
  const maxFilesPerChunk = vsConfig.get<number>("maxFilesPerChunk", 8);
  const includeBlame = vsConfig.get<boolean>("includeGitBlame", false);
  const documentMode = vsConfig.get<"all" | "diff">("documentMode", "all");
  const invocationMode = vsConfig.get<string>("agentInvocationMode", "direct-anthropic-api");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: ${modeLabel(mode)}`,
      // v1.2.15: Adds the X button on the toast. Token is checked at every
      // await boundary in the chunk pipeline so the user can stop runaway
      // jobs without waiting for them to finish or restarting the IDE.
      cancellable: true,
    },
    async (progress, token) => {
      // ── 1. Walk the repo (monorepo-aware) ────────────────────────────────
      progress.report({ message: "Walking repository…", increment: 5 });
      const baseIgnore = await loadLegionIgnore(repoRoot);
      const ignore = await mergeSharedIgnore(repoRoot, baseIgnore);
      const allAbsFiles: string[] = [];

      if (scopeDir) {
        await walkDir(scopeDir, ignore, allAbsFiles);
      } else {
        // Feature 005: walk each scan root; fall back to repoRoot in single-root mode
        const scanRoots = resolveScanRoots(repoRoot);
        for (const sr of scanRoots) {
          await walkDir(sr, ignore, allAbsFiles);
        }
      }

      // ── 2. Filter by mode ────────────────────────────────────────────────
      progress.report({ message: "Computing file diff…", increment: 5 });
      let filesToScan: string[];
      // v1.2.17: legion.documentMode = "diff" makes document mode skip
      // unchanged files (same behavior as update mode). Useful when you want
      // a "doc pass" that skips clean files but doesn't strictly need
      // prior-state injection. When "all" (default), document still walks
      // and processes every file in scope.
      const treatAsDiff =
        mode === "update" || (mode === "document" && documentMode === "diff");
      if (treatAsDiff) {
        const diff = await diffFiles(repoRoot, allAbsFiles);
        filesToScan = [
          ...diff.added.map((r) => path.join(repoRoot, r.replace(/\//g, path.sep))),
          ...diff.modified.map((r) => path.join(repoRoot, r.replace(/\//g, path.sep))),
        ];
      } else {
        filesToScan = allAbsFiles;
      }

      if (filesToScan.length === 0) {
        vscode.window.showInformationMessage(
          mode === "update"
            ? "Legion: Nothing to update — no files changed since last scan."
            : "Legion: No files found to document."
        );
        return;
      }

      // ── 3. Plan chunks ───────────────────────────────────────────────────
      progress.report({
        message: `Planning chunks for ${filesToScan.length} file(s)…`,
        increment: 5,
      });
      const chunks = planChunks(repoRoot, filesToScan, mode, maxFilesPerChunk);
      const wikiRoot = resolveWikiRoot(repoRoot);

      // ── 4. Load manifest (prior_state in update mode) ────────────────────
      const manifest = await loadManifest(repoRoot);

      // ── 4b. Precompute git context ONCE for every file in this pass ──────
      // v1.2.16: hoisted out of per-chunk so wiki-guardian and library-guardian
      // share one lookup map.
      // v1.2.17: now goes through `getGitContextManyCached`, which persists
      // the result to `.legion/git-context-cache.json` keyed on HEAD SHA. On
      // subsequent passes with no new commits, the cache returns instantly
      // (zero git subprocesses). With new commits, only the diff'd files
      // are recomputed (one `git diff --name-only <oldHead> HEAD` to
      // invalidate, then cold-compute just those).
      progress.report({ message: "Computing git context…", increment: 5 });
      if (token.isCancellationRequested) return;
      const gitContextByRel = await getGitContextManyCached(
        context,
        repoRoot,
        filesToScan,
        Math.min(16, Math.max(maxParallel * 2, 8)),
        includeBlame
      );

      // Queue-file mode hint — tell the user what to expect.
      if (invocationMode === "queue-file" && chunks.length > 0) {
        vscode.window.showInformationMessage(
          `Legion [queue-file]: ${chunks.length} request file(s) will be written to ` +
            `.legion/queue/. Drop a matching *-response.json for each request to unblock.`
        );
      }

      // ── 5. Process chunks (wiki-guardian + library-guardian in parallel) ─
      // v1.2.16: was sequential (wiki finished, then library started). Now
      // both phases run concurrently and share the maxParallelAgents budget
      // 70/30 — wiki gets the lion's share since it produces the per-chunk
      // pages the reconcile step depends on, library gets the rest. Chunks
      // are dispatched onto two independent worker pools. Net effect on
      // pass time: roughly 1.4–1.7x speedup depending on module count.
      const chunkResults: ChunkResult[] = [];
      const chunkErrors: string[] = [];

      const wikiBudget = Math.max(1, Math.ceil(maxParallel * 0.7));
      const libBudget = Math.max(1, maxParallel - wikiBudget);

      const totalUnits =
        chunks.length + (mode !== "lint" ? groupByModule(repoRoot, filesToScan).size : 0);
      const incrementPerUnit = Math.max(1, Math.floor(70 / Math.max(totalUnits, 1)));

      // Phase A — wiki-guardian per chunk
      const wikiPhase = runWithConcurrency(
        chunks,
        wikiBudget,
        async (chunk, idx) => {
          if (token.isCancellationRequested) return;
          progress.report({
            message: `${invocationMode === "queue-file" ? "Waiting for" : "Processing"} chunk ${
              idx + 1
            }/${chunks.length}: ${chunk.label}…`,
            increment: incrementPerUnit,
          });

          const chunkFiles = await loadChunkContent(repoRoot, chunk);
          if (chunkFiles.length === 0) return;

          // v1.2.16: lookup from precomputed map instead of re-shelling git
          // for every chunk. Falls back to empty context if a file slipped
          // in after the git pass (rare — workspace edit during the run).
          const gitCtx: Record<string, import("../types/payload").FileGitContext> = {};
          for (const rel of chunk.files) {
            const norm = rel.replace(/\\/g, "/");
            gitCtx[norm] = gitContextByRel[norm] ?? {
              created_commit: "",
              created_at: "",
              last_commit: { sha: "", author: "", timestamp: "", message: "" },
              recent_commits: [],
              blame_summary: { top_authors: [], churn_rate: "unknown" },
            };
          }

          const priorState: PriorPage[] =
            treatAsDiff
              ? await loadPriorState(repoRoot, chunk.files, manifest, wikiRoot)
              : [];

          const payload: InvocationPayload = {
            mode,
            chunk: chunkFiles,
            git_context: gitCtx,
            prior_state: priorState,
            wiki_root: wikiRoot,
            page_caps: PAGE_CAPS,
            callout_vocabulary: CALLOUT_VOCABULARY,
          };

          if (token.isCancellationRequested) return;
          try {
            const response = await invokeAgent("wiki-guardian", payload, repoRoot, context);
            if (token.isCancellationRequested) return;
            chunkResults.push({ label: chunk.label, payload, response });
          } catch (e) {
            chunkErrors.push(
              `Chunk "${chunk.label}" invocation failed: ${
                e instanceof Error ? e.message : String(e)
              }`
            );
          }
        },
        token
      );

      // Phase B — library-guardian per top-level module (concurrent with Phase A)
      const libraryPhase = (async () => {
        if (mode === "lint") return;
        const libGuardianAvailable = await agentExists(repoRoot, "library-guardian");
        if (!libGuardianAvailable) return;

        const moduleGroups = groupByModule(repoRoot, filesToScan);
        await runWithConcurrency(
          [...moduleGroups.entries()],
          libBudget,
          async ([moduleName, absModFiles]) => {
            if (token.isCancellationRequested) return;
            const moduleChunkFiles = await Promise.all(
              absModFiles.map(async (abs) => {
                const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
                try {
                  const content = await fs.readFile(abs, "utf8");
                  return { path: rel, content };
                } catch {
                  return null;
                }
              })
            ).then((r) => r.filter((f): f is { path: string; content: string } => f !== null));

            if (moduleChunkFiles.length === 0) return;

            // Reuse precomputed git context.
            const gitCtx: Record<string, import("../types/payload").FileGitContext> = {};
            for (const f of moduleChunkFiles) {
              gitCtx[f.path] = gitContextByRel[f.path] ?? {
                created_commit: "",
                created_at: "",
                last_commit: { sha: "", author: "", timestamp: "", message: "" },
                recent_commits: [],
                blame_summary: { top_authors: [], churn_rate: "unknown" },
              };
            }

            const libPayload: InvocationPayload = {
              mode,
              chunk: moduleChunkFiles,
              git_context: gitCtx,
              prior_state: [],
              wiki_root: wikiRoot,
              page_caps: PAGE_CAPS,
              callout_vocabulary: CALLOUT_VOCABULARY,
            };
            if (token.isCancellationRequested) return;
            try {
              progress.report({
                message: `library-guardian: ${moduleName}…`,
                increment: incrementPerUnit,
              });
              await invokeAgent("library-guardian", libPayload, repoRoot, context);
            } catch (e) {
              chunkErrors.push(
                `library-guardian for "${moduleName}" failed: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          },
          token
        );
      })();

      await Promise.all([wikiPhase, libraryPhase]);

      // Cancel-fast: skip reconcile + auto-commit if the user clicked X.
      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage(
          `Legion: ${modeLabel(mode)} cancelled — ${chunkResults.length} of ${chunks.length} chunk(s) completed before cancel. ` +
            `Pages already written remain on disk; reconcile + auto-commit skipped.`
        );
        return;
      }

      // ── 6b. Reconcile global wiki state ──────────────────────────────────
      progress.report({ message: "Reconciling wiki state…", increment: 5 });
      const summary = await reconcile(repoRoot, chunkResults);
      summary.errors.push(...chunkErrors);

      // ── 6c. Auto git-commit if enabled ───────────────────────────────────
      if (summary.pagesAffected > 0 && vsConfig.get<boolean>("autoGitCommit", false)) {
        try {
          await autoCommitWiki(repoRoot);
        } catch (e) {
          summary.errors.push(`auto git-commit failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── 7. Surface results ───────────────────────────────────────────────
      const parts: string[] = [
        `${summary.pagesAffected} page(s) affected`,
        ...(summary.contradictions > 0
          ? [`${summary.contradictions} contradiction(s)`]
          : []),
        ...(summary.decisionsAllocated > 0
          ? [`${summary.decisionsAllocated} ADR(s) filed`]
          : []),
        ...(summary.errors.length > 0 ? [`${summary.errors.length} error(s)`] : []),
      ];

      const message = `Legion: ${modeLabel(mode)} complete — ${parts.join(", ")}.`;

      if (summary.errors.length > 0) {
        vscode.window
          .showWarningMessage(message, "Show errors")
          .then((choice) => {
            if (choice === "Show errors") {
              const ch = vscode.window.createOutputChannel("Legion");
              summary.errors.forEach((e) => ch.appendLine(e));
              ch.show();
            }
          });
      } else {
        vscode.window.showInformationMessage(message);
      }
    }
  );
}

// ── Repo walker ───────────────────────────────────────────────────────────────

async function walkDir(
  dir: string,
  ignore: LegionIgnore,
  result: string[]
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (ignore.shouldIgnore(abs)) continue;
    if (entry.isDirectory()) {
      await walkDir(abs, ignore, result);
    } else if (entry.isFile()) {
      result.push(abs);
    }
  }
}

// ── Prior-state loader (update mode only) ─────────────────────────────────────

/**
 * Collect existing wiki pages relevant to the files in this chunk.
 * Reads pages listed in the hash manifest for each source file, then
 * parses their YAML frontmatter so wiki-guardian can detect contradictions
 * against prior knowledge.
 */
async function loadPriorState(
  repoRoot: string,
  chunkRelFiles: string[],
  manifest: HashManifest,
  wikiRoot: string
): Promise<PriorPage[]> {
  const pageSet = new Set<string>();
  for (const rel of chunkRelFiles) {
    const entry = manifest.files[rel];
    if (!entry) continue;
    for (const p of [...entry.pages_created, ...entry.pages_updated]) {
      pageSet.add(p);
    }
  }

  const priorPages: PriorPage[] = [];
  for (const pagePath of pageSet) {
    const absPage = path.join(wikiRoot, pagePath.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(absPage, "utf8");
      priorPages.push({
        path: pagePath.replace(/\\/g, "/"),
        frontmatter: parseFrontmatter(content),
      });
    } catch {
      // Page was deleted or never written — skip.
    }
  }
  return priorPages;
}

// ── Hand-rolled YAML frontmatter parser ───────────────────────────────────────

/**
 * Extracts key: value pairs from the YAML frontmatter block delimited by
 * `---` fences. Only handles flat scalar values — sufficient for the
 * frontmatter shapes wiki-guardian writes (type, status, entity_type, etc.).
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return {};

  const result: Record<string, unknown> = {};
  for (const line of lines.slice(1, closeIdx)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Strip optional surrounding quotes.
    result[key] = raw.replace(/^["']|["']$/g, "");
  }
  return result;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

/**
 * Process `items` with at most `limit` concurrent async workers.
 * Worker slots are refilled as they complete — no fixed batch-slicing.
 *
 * If `token` is provided and becomes cancelled, workers stop dispatching
 * new items immediately. Already-running `fn(item)` calls finish naturally
 * (we can't safely interrupt mid-call without a cooperative AbortSignal).
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<void>,
  token?: vscode.CancellationToken
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (token?.isCancellationRequested) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function modeLabel(mode: Mode): string {
  switch (mode) {
    case "document":
      return "Document Repository";
    case "update":
      return "Update Documentation";
    case "scan-directory":
      return "Scan Directory";
    case "lint":
      return "Lint Wiki";
  }
}

/** Check whether a bundled agent is installed in the repo's .cursor/agents/. */
async function agentExists(repoRoot: string, agentName: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, ".cursor", "agents", `${agentName}.md`));
    return true;
  } catch {
    return false;
  }
}

/** Group absolute file paths by top-level module key. */
function groupByModule(repoRoot: string, absFiles: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const abs of absFiles) {
    const mod = topLevelModule(repoRoot, abs);
    const list = groups.get(mod) ?? [];
    list.push(abs);
    groups.set(mod, list);
  }
  return groups;
}
