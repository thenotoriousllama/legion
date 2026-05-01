import * as vscode from "vscode";
import * as path from "path";
import { CommunityGuardianManager } from "../guardians/communityGuardianManager";
import type { RegistryEntry } from "../guardians/types";
import { resolveRepoRoot } from "../util/repoRoot";

/**
 * Legion: Install Community Guardian — browse registry, preview agent.md, install.
 */
export async function installGuardian(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const legionSharedRoot = path.join(repoRoot, ".legion-shared");
  const manager = new CommunityGuardianManager(context, legionSharedRoot);

  // 1. Fetch registry
  let registry;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Legion: Fetching community guardian registry…" },
    async () => {
      try {
        registry = await manager.fetchRegistry();
      } catch (err) {
        vscode.window.showErrorMessage(`Legion: Could not fetch registry — ${String(err)}`);
      }
    }
  );
  if (!registry) return;

  const registryTyped = registry as Awaited<ReturnType<typeof manager.fetchRegistry>>;
  if (registryTyped.guardians.length === 0) {
    vscode.window.showInformationMessage("Legion: No community guardians are listed in the registry yet.");
    return;
  }

  // 2. QuickPick from registry
  const installed = await manager.listInstalled();
  const installedNames = new Set(installed.map((g) => g.manifest.name));

  const items = registryTyped.guardians.map((entry) => ({
    label: `${installedNames.has(entry.name) ? "$(check) " : ""}${entry.name}`,
    description: `v${entry.latestVersion} by ${entry.author}`,
    detail: `${entry.description}  [${entry.tags.join(", ")}]`,
    entry,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Search community guardians…",
    matchOnDescription: true,
    matchOnDetail: true,
    title: "Legion — Install Community Guardian",
  });
  if (!picked) return;

  const entry: RegistryEntry = picked.entry;

  // 3. Preview agent.md before installing
  await showPreviewAndInstall(entry, manager, context);
}

async function showPreviewAndInstall(
  entry: RegistryEntry,
  manager: CommunityGuardianManager,
  _context: vscode.ExtensionContext
): Promise<void> {
  // Fetch agent.md for preview
  let agentContent = "";
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Legion: Fetching ${entry.name} preview…` },
    async () => {
      try {
        const baseUrl = `https://raw.githubusercontent.com/${entry.repo}/main`;
        // Simple fetch via https for preview
        const https = await import("https");
        agentContent = await new Promise<string>((resolve, reject) => {
          https.get(`${baseUrl}/agent.md`, { headers: { "User-Agent": "legion-vscode/1.0" } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          }).on("error", reject);
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Legion: Could not fetch guardian preview — ${String(err)}`);
      }
    }
  );

  if (!agentContent) return;

  // Show preview as a read-only virtual document
  const previewUri = vscode.Uri.parse(`legion-preview:${entry.name}/agent.md`);
  try {
    // Register an in-memory content provider for the preview
    const provider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(): string {
        return `# ${entry.name} — Preview\n\n${agentContent}`;
      }
    })();
    const disposable = vscode.workspace.registerTextDocumentContentProvider("legion-preview", provider);
    const doc = await vscode.workspace.openTextDocument(previewUri);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    disposable.dispose();
  } catch {
    // Fallback: skip preview
  }

  // Ask to install
  const choice = await vscode.window.showInformationMessage(
    `Install ${entry.name} v${entry.latestVersion} by ${entry.author}?`,

    "Install",
    "Cancel"
  );
  if (choice !== "Install") return;

  // 4. Install
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Legion: Installing ${entry.name}…`, cancellable: false },
    async () => {
      try {
        const manifest = await manager.install(entry);
        vscode.window.showInformationMessage(
          `Legion: ${manifest.name} v${manifest.version} installed. It will appear in the guardian picker on next Initialize.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Legion: Install failed — ${String(err)}\n\nManual install: https://github.com/${entry.repo}`
        );
      }
    }
  );
}
