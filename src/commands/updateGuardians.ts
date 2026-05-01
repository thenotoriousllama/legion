import * as vscode from "vscode";
import * as path from "path";
import { CommunityGuardianManager } from "../guardians/communityGuardianManager";
import { resolveRepoRoot } from "../util/repoRoot";

/**
 * Legion: Update Community Guardians — check all installed community guardians
 * against the registry and update those with newer versions available.
 */
export async function updateGuardians(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const legionSharedRoot = path.join(repoRoot, ".legion-shared");
  const manager = new CommunityGuardianManager(context, legionSharedRoot);

  // 1. Load installed + fetch registry
  const [installed, registry] = await Promise.all([
    manager.listInstalled(),
    manager.fetchRegistry().catch((err: unknown) => {
      vscode.window.showErrorMessage(`Legion: Could not fetch registry — ${String(err)}`);
      return null;
    }),
  ]);

  if (!registry) return;

  if (installed.length === 0) {
    vscode.window.showInformationMessage("Legion: No community guardians are installed yet.");
    return;
  }

  // 2. Diff: find upgradable (skip pinned)
  const registryMap = new Map(registry.guardians.map((e) => [e.name, e]));

  interface Upgradable {
    label: string;
    description: string;
    name: string;
  }

  const upgradable: Upgradable[] = [];
  for (const g of installed) {
    if (g.manifest.pinned) continue;
    const entry = registryMap.get(g.manifest.name);
    if (!entry) continue;
    if (semverGt(entry.latestVersion, g.manifest.version)) {
      upgradable.push({
        label: g.manifest.name,
        description: `${g.manifest.version} → ${entry.latestVersion}`,
        name: g.manifest.name,
      });
    }
  }

  if (upgradable.length === 0) {
    vscode.window.showInformationMessage("Legion: All community guardians are up to date.");
    return;
  }

  // 3. QuickPick of upgradable guardians
  const picked = await vscode.window.showQuickPick(upgradable, {
    canPickMany: true,
    placeHolder: `Select guardians to update (${upgradable.length} update(s) available)`,
    title: "Legion — Update Community Guardians",
  });
  if (!picked || picked.length === 0) return;

  // 4. Update selected
  let successCount = 0;
  const errors: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Legion: Updating ${picked.length} guardian(s)…`,
      cancellable: false,
    },
    async (progress) => {
      for (const item of picked) {
        const entry = registryMap.get(item.name);
        if (!entry) continue;
        progress.report({ message: item.name });
        try {
          await manager.install(entry);
          successCount++;
        } catch (err) {
          errors.push(`${item.name}: ${String(err)}`);
        }
      }
    }
  );

  const summary = `Legion: ${successCount} guardian(s) updated.`;
  if (errors.length > 0) {
    vscode.window.showWarningMessage(`${summary} ${errors.length} error(s).`, "Show errors").then((c) => {
      if (c === "Show errors") {
        const ch = vscode.window.createOutputChannel("Legion");
        errors.forEach((e) => ch.appendLine(e));
        ch.show();
      }
    });
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

/** Minimal semver greater-than (major.minor.patch only). */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}
