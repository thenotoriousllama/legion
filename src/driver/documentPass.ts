import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { Mode, InvocationPayload, PriorPage } from "../types/payload";
import type { LegionIgnore } from "./legionignore";
import type { HashManifest } from "./hashDiff";
import { loadLegionIgnore } from "./legionignore";
import { mergeSharedIgnore } from "./sharedConfig";
import { diffFiles, loadManifest } from "./hashDiff";
import { planChunks, loadChunkContent, loadChunkContentDetailed, topLevelModule, type PlannedChunk } from "./chunkPlanner";
import { getGitContextManyCached } from "./gitContextCache";
import { invokeAgent } from "./agentInvoker";
import { reconcile, type ChunkResult } from "./reconciler";
import { autoCommitWiki } from "./gitCommit";
import { resolveWikiRoot, resolveScanRoots } from "../util/repoRoot";
import { ActivityStream } from "../util/activityStream";

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
  const maxFileSizeBytes = vsConfig.get<number>("maxFileSizeBytes", 200_000);
  const maxChunkTokensEstimate = vsConfig.get<number>("maxChunkTokensEstimate", 200_000);
  const includeBlame = vsConfig.get<boolean>("includeGitBlame", false);
  const documentMode = vsConfig.get<"all" | "diff">("documentMode", "all");
  const invocationMode = vsConfig.get<string>("agentInvocationMode", "direct-anthropic-api");

  // v1.2.18: unify cancellation. The toast X (from withProgress) and the
  // Dashboard Activity-tab Cancel button both feed into one
  // CancellationTokenSource that documentPass actually checks. Either firing
  // stops the worker pool cleanly.
  const activity = ActivityStream.instance;
  const opSource = new vscode.CancellationTokenSource();
  const opId = `${mode}-${Date.now()}`;
  activity.setActive({
    id: opId,
    label: modeLabel(mode),
    startedAt: Date.now(),
    tokenSource: opSource,
  });
  activity.emit({
    level: "info",
    source: opId,
    message: `${modeLabel(mode)} started`,
  });

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Legion: ${modeLabel(mode)}`,
        cancellable: true,
      },
      async (progress, toastToken) => {
        // Forward toast cancel into our unified source so the chunk pipeline
        // and the Dashboard Cancel button see the same token.
        toastToken.onCancellationRequested(() => opSource.cancel());
        const token = opSource.token;

        const report = (message: string, increment?: number, prog?: { current: number; total: number }) => {
          progress.report(increment !== undefined ? { message, increment } : { message });
          activity.emit({
            level: prog ? "progress" : "info",
            source: opId,
            message,
            progress: prog,
          });
        };

        // ── 1. Walk the repo (monorepo-aware) ────────────────────────────────
        report("Walking repository…", 5);
        const baseIgnore = await loadLegionIgnore(repoRoot);
        const ignore = await mergeSharedIgnore(repoRoot, baseIgnore);
        const allAbsFiles: string[] = [];

        if (scopeDir) {
          await walkDir(scopeDir, ignore, allAbsFiles);
        } else {
          const scanRoots = resolveScanRoots(repoRoot);
          for (const sr of scanRoots) {
            await walkDir(sr, ignore, allAbsFiles);
          }
        }

        // ── 2. Filter by mode ────────────────────────────────────────────────
        report("Computing file diff…", 5);
        let filesToScan: string[];
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
          const msg =
            mode === "update"
              ? "Nothing to update — no files changed since last scan."
              : "No files found to document.";
          vscode.window.showInformationMessage(`Legion: ${msg}`);
          activity.emit({ level: "done", source: opId, message: msg });
          return;
        }

        // ── 3. Plan chunks ───────────────────────────────────────────────────
        report(`Planning chunks for ${filesToScan.length} file(s)…`, 5);
        const chunks = planChunks(repoRoot, filesToScan, mode, maxFilesPerChunk);
        const wikiRoot = resolveWikiRoot(repoRoot);

        // ── 4. Load manifest (prior_state in update mode) ────────────────────
        const manifest = await loadManifest(repoRoot);

        // ── 4b. Precompute git context ONCE for every file in this pass ──────
        report("Computing git context…", 5);
        if (token.isCancellationRequested) return;
        const gitContextByRel = await getGitContextManyCached(
          context,
          repoRoot,
          filesToScan,
          Math.min(16, Math.max(maxParallel * 2, 8)),
          includeBlame
        );

        if (invocationMode === "queue-file" && chunks.length > 0) {
          vscode.window.showInformationMessage(
            `Legion [queue-file]: ${chunks.length} request file(s) will be written to ` +
              `.legion/queue/. Drop a matching *-response.json for each request to unblock.`
          );
        }

        // ── 5. Process chunks (wiki-guardian + library-guardian in parallel) ─
        const chunkResults: ChunkResult[] = [];
        const chunkErrors: string[] = [];

        const wikiBudget = Math.max(1, Math.ceil(maxParallel * 0.7));
        const libBudget = Math.max(1, maxParallel - wikiBudget);

        const totalUnits =
          chunks.length + (mode !== "lint" ? groupByModule(repoRoot, filesToScan).size : 0);
        const incrementPerUnit = Math.max(1, Math.floor(70 / Math.max(totalUnits, 1)));

        // v1.2.21: helper that handles one chunk, with auto-split when the
        // estimated payload exceeds the model's effective context. Recursive:
        // a chunk that's still too big after halving keeps splitting until
        // each sub-chunk fits or we're down to a single-file chunk that's
        // unsplittable (in which case we surface a clear error).
        const processWikiChunk = async (chunk: PlannedChunk, parentLabel?: string): Promise<void> => {
          if (token.isCancellationRequested) return;
          const labelPath = parentLabel ? `${parentLabel} ▶ ${chunk.label}` : chunk.label;

          const loaded = await loadChunkContentDetailed(repoRoot, chunk, maxFileSizeBytes);
          // Surface dropped files so the user understands why they're not in the wiki.
          for (const big of loaded.oversize) {
            activity.emit({
              level: "warn",
              source: opId,
              message: `wiki-guardian: skipped oversize file ${big.path} (${(big.sizeBytes / 1024).toFixed(0)} KB > ${(maxFileSizeBytes / 1024).toFixed(0)} KB cap)`,
            });
          }
          if (loaded.files.length === 0) return;

          const gitCtx: Record<string, import("../types/payload").FileGitContext> = {};
          for (const f of loaded.files) {
            gitCtx[f.path] = gitContextByRel[f.path] ?? {
              created_commit: "",
              created_at: "",
              last_commit: { sha: "", author: "", timestamp: "", message: "" },
              recent_commits: [],
              blame_summary: { top_authors: [], churn_rate: "unknown" },
            };
          }

          const priorState: PriorPage[] = treatAsDiff
            ? await loadPriorState(repoRoot, loaded.files.map((f) => f.path), manifest, wikiRoot)
            : [];

          const payload: InvocationPayload = {
            mode,
            chunk: loaded.files,
            git_context: gitCtx,
            prior_state: priorState,
            wiki_root: wikiRoot,
            page_caps: PAGE_CAPS,
            callout_vocabulary: CALLOUT_VOCABULARY,
          };

          // Estimate total payload tokens. ~4 chars per token is the
          // conservative default for English/code; system prompt is added
          // by agentInvoker and we reserve a fixed overhead to account for it.
          const SYSTEM_PROMPT_TOKEN_RESERVE = 80_000; // wiki-guardian.md + skill refs
          const payloadChars = JSON.stringify(payload).length;
          const estimatedTokens = Math.ceil(payloadChars / 4) + SYSTEM_PROMPT_TOKEN_RESERVE;

          if (estimatedTokens > maxChunkTokensEstimate && loaded.files.length > 1) {
            // Split files in half and process each sub-chunk independently.
            // Reconcile happily merges multiple results sharing a label root.
            const mid = Math.ceil(loaded.files.length / 2);
            const filesA = loaded.files.slice(0, mid).map((f) => f.path);
            const filesB = loaded.files.slice(mid).map((f) => f.path);
            activity.emit({
              level: "warn",
              source: opId,
              message: `wiki-guardian: chunk "${labelPath}" estimated at ~${estimatedTokens.toLocaleString()} tokens (> ${maxChunkTokensEstimate.toLocaleString()}), splitting ${loaded.files.length} files into ${filesA.length}+${filesB.length}`,
            });
            await processWikiChunk(
              { label: `${chunk.label} [a:${filesA.length}]`, files: filesA },
              parentLabel
            );
            if (token.isCancellationRequested) return;
            await processWikiChunk(
              { label: `${chunk.label} [b:${filesB.length}]`, files: filesB },
              parentLabel
            );
            return;
          }

          if (estimatedTokens > maxChunkTokensEstimate) {
            // Unsplittable: single file already too big. Drop it with a clear
            // error rather than blowing up the LLM call.
            const onlyFile = loaded.files[0]?.path ?? "(unknown)";
            const msg = `single file "${onlyFile}" estimated at ~${estimatedTokens.toLocaleString()} tokens — exceeds maxChunkTokensEstimate (${maxChunkTokensEstimate.toLocaleString()}). Skipped. Lower legion.maxFileSizeBytes or raise legion.maxChunkTokensEstimate.`;
            chunkErrors.push(`Chunk "${labelPath}" oversize: ${msg}`);
            activity.emit({
              level: "error",
              source: opId,
              message: `wiki-guardian ✗ ${labelPath}`,
              error: msg,
            });
            return;
          }

          if (token.isCancellationRequested) return;
          try {
            const response = await invokeAgent("wiki-guardian", payload, repoRoot, context);
            if (token.isCancellationRequested) return;
            chunkResults.push({ label: labelPath, payload, response });
            activity.emit({ level: "info", source: opId, message: `wiki-guardian ✓ ${labelPath}` });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            chunkErrors.push(`Chunk "${labelPath}" invocation failed: ${msg}`);
            activity.emit({
              level: "error",
              source: opId,
              message: `wiki-guardian ✗ ${labelPath}`,
              error: msg,
            });
          }
        };

        // Phase A — wiki-guardian per chunk
        const wikiPhase = runWithConcurrency(
          chunks,
          wikiBudget,
          async (chunk, idx) => {
            if (token.isCancellationRequested) return;
            report(
              `${invocationMode === "queue-file" ? "Waiting for" : "Processing"} chunk ${
                idx + 1
              }/${chunks.length}: ${chunk.label}…`,
              incrementPerUnit,
              { current: idx + 1, total: chunks.length }
            );
            await processWikiChunk(chunk);
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
              // v1.2.21: same file-size cap as wiki-guardian. A massive
              // generated file in a "module" would push library-guardian's
              // single invocation over the model's context the same way it
              // did for wiki-guardian.
              const moduleChunkFiles = await Promise.all(
                absModFiles.map(async (abs) => {
                  const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
                  try {
                    const st = await fs.stat(abs);
                    if (st.size > maxFileSizeBytes) {
                      activity.emit({
                        level: "warn",
                        source: opId,
                        message: `library-guardian: skipped oversize file ${rel} (${(st.size / 1024).toFixed(0)} KB > ${(maxFileSizeBytes / 1024).toFixed(0)} KB cap)`,
                      });
                      return null;
                    }
                    const content = await fs.readFile(abs, "utf8");
                    return { path: rel, content };
                  } catch {
                    return null;
                  }
                })
              ).then((r) => r.filter((f): f is { path: string; content: string } => f !== null));

              if (moduleChunkFiles.length === 0) return;

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
                report(`library-guardian: ${moduleName}…`, incrementPerUnit);
                await invokeAgent("library-guardian", libPayload, repoRoot, context);
                activity.emit({
                  level: "info",
                  source: opId,
                  message: `library-guardian ✓ ${moduleName}`,
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                chunkErrors.push(`library-guardian for "${moduleName}" failed: ${msg}`);
                activity.emit({
                  level: "error",
                  source: opId,
                  message: `library-guardian ✗ ${moduleName}`,
                  error: msg,
                });
              }
            },
            token
          );
        })();

        await Promise.all([wikiPhase, libraryPhase]);

        if (token.isCancellationRequested) {
          const cancelMsg = `${modeLabel(mode)} cancelled — ${chunkResults.length} of ${chunks.length} chunk(s) completed before cancel. Pages already written remain on disk; reconcile + auto-commit skipped.`;
          vscode.window.showWarningMessage(`Legion: ${cancelMsg}`);
          activity.emit({ level: "cancelled", source: opId, message: cancelMsg });
          return;
        }

        // ── 6b. Reconcile global wiki state ──────────────────────────────────
        report("Reconciling wiki state…", 5);
        const summary = await reconcile(repoRoot, chunkResults);
        summary.errors.push(...chunkErrors);

        // ── 6c. Auto git-commit if enabled ───────────────────────────────────
        if (summary.pagesAffected > 0 && vsConfig.get<boolean>("autoGitCommit", false)) {
          try {
            await autoCommitWiki(repoRoot);
            activity.emit({ level: "info", source: opId, message: "Auto-committed wiki changes" });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.errors.push(`auto git-commit failed: ${msg}`);
            activity.emit({ level: "warn", source: opId, message: `auto git-commit failed: ${msg}` });
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
        activity.emit({ level: "done", source: opId, message });

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    activity.emit({ level: "error", source: opId, message: `${modeLabel(mode)} failed`, error: msg });
    throw err;
  } finally {
    activity.clearActive();
    opSource.dispose();
  }
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
  // v1.2.20: drop "modules" that aren't really modules. Pre-v1.2.20,
  // top-level files like `.gitignore`, `README.md`, `package.json`, and
  // `tsconfig.json` each became their own one-file "module" because
  // `topLevelModule` returns `segments[0]` for any path with ≤ 2 segments.
  // library-guardian then got invoked with a single config file and asked to
  // write a module narrative; it correctly responded with prose, parseResponse
  // rejected it ("Agent response did not contain a JSON object"), and the
  // error showed up in the Activity tab on every pass.
  //
  // A real module:
  //   - has a `/` in the module name (e.g. `src/auth`, `apps/web`), OR
  //   - contains at least 2 files. A single loose file at the top of a
  //     monorepo segment isn't worth a module narrative.
  for (const [mod, files] of [...groups.entries()]) {
    const isRealPath = mod.includes("/");
    const hasSubstance = files.length >= 2;
    if (!isRealPath && !hasSubstance) {
      groups.delete(mod);
    }
  }
  return groups;
}
