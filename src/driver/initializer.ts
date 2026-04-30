import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

const STRUCTURE = [
  ".legion",
  ".legion/queue",
  ".legion/git-cache",
  ".legion/chunks",
  "library",
  "library/notes",
  "library/knowledge-base",
  "library/knowledge-base/wiki",
  "library/knowledge-base/wiki/entities",
  "library/knowledge-base/wiki/concepts",
  "library/knowledge-base/wiki/decisions",
  "library/knowledge-base/wiki/comparisons",
  "library/knowledge-base/wiki/questions",
  "library/knowledge-base/wiki/meta",
  "library/qa",
  "library/requirements",
  "library/requirements/issues",
  "library/requirements/issues/completed",
  "library/requirements/features",
  "library/requirements/features/completed",
  ".cursor",
  ".cursor/agents",
  ".cursor/skills",
];

interface GuardianOption extends vscode.QuickPickItem {
  agentName: string;
  weaponName: string;
}

const AVAILABLE_GUARDIANS: GuardianOption[] = [
  { label: "wiki-guardian", detail: "Entity extraction + wiki maintenance (recommended)", agentName: "wiki-guardian", weaponName: "wiki-weapon", picked: true },
  { label: "library-guardian", detail: "Module narrative + PRD authorship (recommended)", agentName: "library-guardian", weaponName: "library-weapon", picked: true },
  { label: "quality-guardian", detail: "QA report authorship", agentName: "quality-guardian", weaponName: "quality-weapon" },
  { label: "security-guardian", detail: "Security audit (CVEs, OWASP, PII)", agentName: "security-guardian", weaponName: "security-weapon" },
  { label: "react-guardian", detail: "React-specific reviews", agentName: "react-guardian", weaponName: "react-weapon" },
  { label: "ux-ui-guardian", detail: "UX/UI reviews", agentName: "ux-ui-guardian", weaponName: "ux-ui-weapon" },
  { label: "design-system-guardian", detail: "Design system enforcement", agentName: "design-system-guardian", weaponName: "design-system-weapon" },
  { label: "seo-aeo-guardian", detail: "SEO + AEO reviews", agentName: "seo-aeo-guardian", weaponName: "seo-aeo-weapon" },
];

export async function runInitializer(
  repoRoot: string,
  context: vscode.ExtensionContext
): Promise<void> {
  // 1. Pick guardians
  const guardians = await vscode.window.showQuickPick(AVAILABLE_GUARDIANS, {
    canPickMany: true,
    placeHolder: "Select guardians to bundle in this repo (Space to toggle, Enter to confirm)",
  });
  if (!guardians) {
    vscode.window.showInformationMessage("Legion: Initialize cancelled.");
    return;
  }

  let createdCount = 0;
  let skippedCount = 0;
  const warnings: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Legion: Initializing repository",
      cancellable: false,
    },
    async (progress) => {
      // 2. Directory structure (idempotent — fs.mkdir with recursive doesn't fail if exists)
      progress.report({ message: "Creating directory structure…", increment: 10 });
      for (const dir of STRUCTURE) {
        await fs.mkdir(path.join(repoRoot, dir), { recursive: true });
      }

      // 3. .legionignore (preserve existing)
      progress.report({ message: "Writing .legionignore…", increment: 10 });
      const ignorePath = path.join(repoRoot, ".legionignore");
      if (await exists(ignorePath)) {
        skippedCount++;
      } else {
        await copyTemplate(context, "legionignore.template", ignorePath);
        createdCount++;
      }

      // 4. .legion/config.json
      progress.report({ message: "Writing .legion/config.json…", increment: 10 });
      const configPath = path.join(repoRoot, ".legion", "config.json");
      if (await exists(configPath)) {
        skippedCount++;
      } else {
        await copyTemplate(context, "legion-config.template.json", configPath);
        // Patch in selected guardians
        const config = JSON.parse(await fs.readFile(configPath, "utf8"));
        config.guardians_installed = guardians.map((g) => g.agentName);
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        createdCount++;
      }

      // 5. .legion/file-hashes.json (empty manifest)
      const hashesPath = path.join(repoRoot, ".legion", "file-hashes.json");
      if (await exists(hashesPath)) {
        skippedCount++;
      } else {
        await fs.writeFile(
          hashesPath,
          JSON.stringify({ files: {}, last_scan: null }, null, 2)
        );
        createdCount++;
      }

      // 6. Wiki state files (idempotent — preserve existing)
      progress.report({ message: "Seeding wiki state files…", increment: 20 });
      const wikiRoot = path.join(repoRoot, "library", "knowledge-base", "wiki");
      const stateFiles: Array<[string, string]> = [
        ["wiki-index.template.md", "index.md"],
        ["wiki-hot.template.md", "hot.md"],
        ["wiki-log.template.md", "log.md"],
        ["wiki-overview.template.md", "overview.md"],
      ];
      for (const [tpl, dst] of stateFiles) {
        const dstPath = path.join(wikiRoot, dst);
        if (await exists(dstPath)) {
          skippedCount++;
        } else {
          await copyTemplate(context, tpl, dstPath);
          createdCount++;
        }
      }

      // 7. Copy bundled agents + weapons for selected guardians
      progress.report({ message: "Copying bundled guardians…", increment: 50 });
      const bundledRoot = path.join(context.extensionPath, "bundled");
      for (const g of guardians) {
        // Agent file
        const agentSrc = path.join(bundledRoot, "agents", `${g.agentName}.md`);
        const agentDst = path.join(repoRoot, ".cursor", "agents", `${g.agentName}.md`);
        if (await exists(agentDst)) {
          skippedCount++;
        } else if (!(await exists(agentSrc))) {
          warnings.push(`Bundled agent missing: ${g.agentName}.md (run \`npm run snapshot\` in the extension repo before packaging)`);
        } else {
          await fs.copyFile(agentSrc, agentDst);
          createdCount++;
        }

        // Weapon folder
        const weaponSrc = path.join(bundledRoot, "skills", g.weaponName);
        const weaponDst = path.join(repoRoot, ".cursor", "skills", g.weaponName);
        if (await exists(weaponDst)) {
          skippedCount++;
        } else if (!(await exists(weaponSrc))) {
          warnings.push(`Bundled weapon missing: ${g.weaponName}/ (run \`npm run snapshot\`)`);
        } else {
          await copyDir(weaponSrc, weaponDst);
          createdCount++;
        }
      }
    }
  );

  // 8. Report
  const summary = `Legion: Initialized. ${createdCount} created, ${skippedCount} skipped (already existed).`;
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(`${summary} ${warnings.length} warning(s).`, "Show details").then((choice) => {
      if (choice === "Show details") {
        const channel = vscode.window.createOutputChannel("Legion");
        channel.appendLine(summary);
        warnings.forEach((w) => channel.appendLine(`  ⚠ ${w}`));
        channel.show();
      }
    });
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplate(context: vscode.ExtensionContext, tplName: string, dst: string): Promise<void> {
  const src = path.join(context.extensionPath, "templates", tplName);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (await exists(dstPath)) continue; // no-clobber
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}
