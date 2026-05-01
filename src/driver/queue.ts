import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * `.legion/queue/` management — used by both the queue-file invocation mode
 * (extension ↔ Cursor slash command) and the post-commit hook (which drops
 * "scan needed" markers for Update to drain).
 *
 * v0.1.0: minimal helpers used by the agent invoker.
 * v0.2.0: post-commit-hook drain logic.
 */

export interface QueueEntry {
  type: "git-context-request" | "git-context-response" | "agent-request" | "agent-response" | "scan-needed";
  request_id: string;
  payload: unknown;
  created_at: string;
}

const QUEUE_DIR = path.join(".legion", "queue");

export async function ensureQueueDir(repoRoot: string): Promise<string> {
  const dir = path.join(repoRoot, QUEUE_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeQueueEntry(
  repoRoot: string,
  entry: QueueEntry
): Promise<string> {
  const dir = await ensureQueueDir(repoRoot);
  const filename = `${entry.request_id}-${entry.type}.json`;
  const p = path.join(dir, filename);
  await fs.writeFile(p, JSON.stringify(entry, null, 2));
  return p;
}

export async function listScanNeededMarkers(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, QUEUE_DIR);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith("-scan-needed.json"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function clearMarker(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // already gone
  }
}

/**
 * Check for pending post-commit scan-needed markers and prompt the user to
 * run an Update pass if any are found. Called from `activate()`.
 *
 * Only prompts when `legion.installPostCommitHook` is true — if the user never
 * installed the hook, there are no markers and no prompt.
 */
export async function drainPostCommitQueue(
  repoRoot: string,
  onConfirm: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration("legion");
  if (!config.get<boolean>("installPostCommitHook", false)) return;

  const markers = await listScanNeededMarkers(repoRoot);
  if (markers.length === 0) return;

  const choice = await vscode.window.showInformationMessage(
    `Legion: ${markers.length} commit(s) are pending wiki documentation. Run Update now?`,
    "Update now",
    "Later"
  );
  if (choice !== "Update now") return;

  await onConfirm();
  await Promise.all(markers.map(clearMarker));
}
