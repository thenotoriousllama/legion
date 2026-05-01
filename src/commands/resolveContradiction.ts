import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  readContradictionInbox,
  removeContradictionFromInbox,
  type ContradictionEntry,
} from "../driver/reconciler";

const exec = promisify(execFile);
const WIKI_REL = path.join("library", "knowledge-base", "wiki");

/**
 * Full diff-based contradiction resolution workflow.
 *
 * 1. Show Quick Pick of all inbox entries
 * 2. Open VS Code's native diff editor showing before ↔ after
 * 3. Present resolution actions: Keep new / Revert to old / Mark resolved
 * 4. Apply the chosen resolution and remove from inbox
 */
export async function resolveContradiction(repoRoot: string): Promise<void> {
  if (!repoRoot) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }

  const inbox = await readContradictionInbox(repoRoot);
  if (inbox.length === 0) {
    vscode.window.showInformationMessage("Legion: No unresolved contradictions.");
    return;
  }

  // ── Step 1: Quick Pick ──────────────────────────────────────────────────────
  const items = inbox.map((entry, i) => ({
    label: `$(warning) ${entry.old} → ${entry.new}`,
    description: entry.reason,
    detail: `commit ${entry.commit} · ${entry.date}`,
    entry,
    index: i,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a contradiction to resolve",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  await resolveOne(repoRoot, picked.entry, picked.index);
}

// ── Core resolver ─────────────────────────────────────────────────────────────

async function resolveOne(
  repoRoot: string,
  entry: ContradictionEntry,
  index: number
): Promise<void> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);
  const isSamePage = entry.old === entry.new;

  // ── Step 2: Open diff view ──────────────────────────────────────────────────
  if (isSamePage) {
    // Same page: show git HEAD version vs current
    const absPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    const relWikiPath = entry.old;

    let beforeContent: string;
    try {
      const { stdout } = await exec(
        "git",
        ["show", `HEAD:${path.join(WIKI_REL, relWikiPath).replace(/\\/g, "/")}`],
        { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 }
      );
      beforeContent = stdout;
    } catch {
      beforeContent = `_(Could not retrieve previous version via git — commit: ${entry.commit})_\n\nReason: ${entry.reason}`;
    }

    // Create virtual "before" document
    const beforeUri = vscode.Uri.parse(
      `untitled:${path.join(wikiRoot, "meta", `before-${path.basename(entry.old)}`).replace(/\\/g, "/")}`
    );
    // Open before doc
    const beforeDoc = await vscode.workspace.openTextDocument({
      content: beforeContent,
      language: "markdown",
    });
    const currentUri = vscode.Uri.file(absPath);

    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeDoc.uri,
      currentUri,
      `Contradiction: Before ↔ After — ${entry.old}`
    );
  } else {
    // Different pages: diff old vs new
    const oldAbsPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    const newAbsPath = path.join(wikiRoot, entry.new.replace(/\//g, path.sep));
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(oldAbsPath),
      vscode.Uri.file(newAbsPath),
      `Contradiction: ${entry.old} ↔ ${entry.new} — ${entry.reason}`
    );
  }

  // ── Step 3: Resolution actions ───────────────────────────────────────────────
  const choice = await vscode.window.showInformationMessage(
    `Contradiction: "${entry.reason}" — how do you want to resolve it?`,
    { modal: false },
    "Keep new version",
    "Revert to old",
    "Mark resolved"
  );

  if (!choice) return; // dismissed

  switch (choice) {
    case "Keep new version":
      await keepNewVersion(repoRoot, entry, index, isSamePage);
      break;
    case "Revert to old":
      await revertToOld(repoRoot, entry, index, isSamePage);
      break;
    case "Mark resolved":
      await removeContradictionFromInbox(repoRoot, index);
      vscode.window.showInformationMessage("Legion: Contradiction marked resolved.");
      break;
  }

  // Refresh sidebar badge
  const remaining = await readContradictionInbox(repoRoot);
  void vscode.commands.executeCommand("legion.internal.contradictionCount", remaining.length);
}

// ── Resolution actions ────────────────────────────────────────────────────────

async function keepNewVersion(
  repoRoot: string,
  entry: ContradictionEntry,
  index: number,
  isSamePage: boolean
): Promise<void> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);

  if (isSamePage) {
    // Strip [!stale] callout from the page
    const absPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(absPath, "utf8");
      const cleaned = stripCallout(content, "stale");
      await fs.writeFile(absPath, cleaned);
    } catch {}
  } else {
    // Strip [!stale] callout from old page
    const oldAbsPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(oldAbsPath, "utf8");
      const cleaned = stripCallout(content, "stale");
      await fs.writeFile(oldAbsPath, cleaned);
    } catch {}
  }

  await removeContradictionFromInbox(repoRoot, index);
  vscode.window.showInformationMessage("Legion: Kept new version — stale callout removed.");
}

async function revertToOld(
  repoRoot: string,
  entry: ContradictionEntry,
  index: number,
  isSamePage: boolean
): Promise<void> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);

  if (isSamePage) {
    // Restore from git HEAD
    const absPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    try {
      const { stdout } = await exec(
        "git",
        ["show", `HEAD:${path.join(WIKI_REL, entry.old).replace(/\\/g, "/")}`],
        { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 }
      );
      const restored = stripCallout(stdout, "contradiction");
      await fs.writeFile(absPath, restored);
      vscode.window.showInformationMessage("Legion: Reverted to previous version.");
    } catch {
      vscode.window.showWarningMessage("Legion: Could not restore from git — no committed version found.");
    }
  } else {
    // Delete new page, strip contradiction callout from old
    const newAbsPath = path.join(wikiRoot, entry.new.replace(/\//g, path.sep));
    const oldAbsPath = path.join(wikiRoot, entry.old.replace(/\//g, path.sep));
    try {
      await fs.unlink(newAbsPath);
    } catch {}
    try {
      const content = await fs.readFile(oldAbsPath, "utf8");
      const cleaned = stripCallout(content, "stale");
      await fs.writeFile(oldAbsPath, cleaned);
    } catch {}
    vscode.window.showInformationMessage("Legion: Reverted to old version.");
  }

  await removeContradictionFromInbox(repoRoot, index);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripCallout(content: string, type: "contradiction" | "stale"): string {
  // Remove `> [!type] ...` callout blocks (single line or multi-line)
  return content.replace(
    new RegExp(`> \\[!${type}\\][^\\n]*(?:\\n>[^\\n]*)*\\n?`, "gi"),
    ""
  );
}
