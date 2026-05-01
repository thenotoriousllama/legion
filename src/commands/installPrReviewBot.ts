import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { getOriginUrl, parseGitHubRemote } from "../util/gitRemote";
import { resolveRepoRoot } from "../util/repoRoot";

const WORKFLOW_REL = ".github/workflows/legion-wiki-diff.yml";

/**
 * Four-step wizard to install the Legion PR Review Bot GitHub Actions workflow.
 * Step 1: detect GitHub remote
 * Step 2: copy / idempotency-check workflow file
 * Step 3: open GitHub Secrets URL in browser
 * Step 4: show final instructions
 */
export async function installPrReviewBot(
  _repoRootLegacy: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  // ── Step 1: Detect GitHub remote ────────────────────────────────────────────
  let remoteUrl: string;
  try {
    remoteUrl = getOriginUrl(repoRoot);
  } catch {
    vscode.window.showErrorMessage(
      "Legion: No GitHub remote detected. Please push your repo to GitHub first."
    );
    return;
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    vscode.window.showErrorMessage(
      `Legion: Remote is not a GitHub repository. GitHub Actions setup requires a GitHub remote. (Found: ${remoteUrl})`
    );
    return;
  }

  vscode.window.showInformationMessage(
    `Legion: GitHub remote detected — ${remote.owner}/${remote.repo}`
  );

  // ── Step 2: Workflow file ────────────────────────────────────────────────────
  const workflowPath = path.join(repoRoot, WORKFLOW_REL);
  const bundledTemplate = getWorkflowTemplate(remote.owner, remote.repo);

  const fileStatus = await checkWorkflowFile(workflowPath, bundledTemplate);

  if (fileStatus === "identical") {
    vscode.window.showInformationMessage(
      "Legion: Workflow already installed — no changes needed."
    );
  } else if (fileStatus === "missing") {
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(workflowPath, bundledTemplate, "utf8");
    vscode.window.showInformationMessage(
      `Legion: Workflow file written to ${WORKFLOW_REL}`
    );
  } else {
    // "modified" — offer diff / overwrite / keep
    const choice = await vscode.window.showWarningMessage(
      `Legion: ${WORKFLOW_REL} already exists and differs from the bundled template.`,
      "Overwrite with latest",
      "Keep existing",
      "Show diff"
    );

    if (choice === "Overwrite with latest") {
      await fs.writeFile(workflowPath, bundledTemplate, "utf8");
      vscode.window.showInformationMessage("Legion: Workflow file updated.");
    } else if (choice === "Show diff") {
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(workflowPath),
        vscode.Uri.parse(
          `data:text/plain;charset=utf-8,${encodeURIComponent(bundledTemplate)}`
        ),
        "legion-wiki-diff.yml (existing ↔ latest)"
      );
      // Re-prompt after showing diff
      const overwrite = await vscode.window.showInformationMessage(
        "Overwrite with the latest template?",
        "Overwrite",
        "Keep existing"
      );
      if (overwrite === "Overwrite") {
        await fs.writeFile(workflowPath, bundledTemplate, "utf8");
      }
    }
    // "Keep existing": no-op
  }

  // ── Step 3: Open GitHub Secrets URL ─────────────────────────────────────────
  const secretsUrl = `https://github.com/${remote.owner}/${remote.repo}/settings/secrets/actions/new`;
  const openSecrets = await vscode.window.showInformationMessage(
    "Legion: Next — add your Anthropic API key as a GitHub Actions secret.",
    "Open GitHub Secrets →"
  );
  if (openSecrets === "Open GitHub Secrets →") {
    await vscode.env.openExternal(vscode.Uri.parse(secretsUrl));
  }

  // ── Step 4: Final instructions ───────────────────────────────────────────────
  await vscode.window.showInformationMessage(
    [
      "Legion: Almost done! Commit .github/workflows/legion-wiki-diff.yml and push to enable the PR bot.",
      "Required secret: LEGION_ANTHROPIC_API_KEY",
    ].join("\n"),
    "Open README for details",
    "Done"
  );
}

/** Check whether the workflow file at `workflowPath` is missing, identical, or modified. */
async function checkWorkflowFile(
  workflowPath: string,
  bundledTemplate: string
): Promise<"missing" | "identical" | "modified"> {
  try {
    const existing = await fs.readFile(workflowPath, "utf8");
    return existing.trim() === bundledTemplate.trim() ? "identical" : "modified";
  } catch {
    return "missing";
  }
}

/** Returns the workflow YAML content (Feature 006 upgraded version). */
function getWorkflowTemplate(_owner: string, _repo: string): string {
  return `name: Legion Wiki Diff

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'src/**'
      - 'packages/**/src/**'

jobs:
  wiki-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Legion CLI
        run: npm install -g @thenotoriousllama/legion-cli 2>/dev/null || true

      - name: Run Legion Update (PR diff)
        id: legion
        env:
          LEGION_ANTHROPIC_API_KEY: \${{ secrets.LEGION_ANTHROPIC_API_KEY }}
        run: |
          git diff --name-only origin/\${{ github.base_ref }}...HEAD \\
            | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$' \\
            | tr '\\n' ',' > /tmp/changed_files.txt || true

          FILES=\$(cat /tmp/changed_files.txt)
          if [ -z "\$FILES" ]; then
            echo "LEGION_SUMMARY={}" >> "\$GITHUB_OUTPUT"
            exit 0
          fi

          node dist/cli.js --mode update --files "\$FILES" 2>&1 | tee /tmp/legion-output.txt || true
          SUMMARY=\$(grep 'LEGION_SUMMARY=' /tmp/legion-output.txt | tail -1 | sed 's/LEGION_SUMMARY=//' || echo '{}')
          echo "LEGION_SUMMARY=\$SUMMARY" >> "\$GITHUB_OUTPUT"

      - name: Post PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const marker = '<!-- legion-wiki-diff -->';
            const summaryRaw = '\${{ steps.legion.outputs.LEGION_SUMMARY }}' || '{}';

            let summary;
            try { summary = JSON.parse(summaryRaw); } catch { summary = {}; }

            const created = summary.pages_created ?? 0;
            const updated = summary.pages_updated ?? 0;
            const contradictions = summary.contradictions ?? 0;

            function healthBadge(c) {
              if (c > 0) return '![Docs Health](https://img.shields.io/badge/Docs-Contradictions-red)';
              return '![Docs Health](https://img.shields.io/badge/Docs-No%20Contradictions-brightgreen)';
            }

            const sha = context.sha.slice(0, 7);
            const repoUrl = \`https://github.com/\${context.repo.owner}/\${context.repo.repo}\`;

            const body = [
              marker,
              '## Legion Docs Update',
              '',
              healthBadge(contradictions),
              '',
              \`**Commit:** [\${sha}](\${repoUrl}/commit/\${context.sha}) | **Branch:** \\\`\${context.payload.pull_request.head.ref}\\\`\`,
              '',
              \`### Pages Created (\${created})\`,
              created === 0 ? '_None_' : \`\${created} new wiki page(s) created.\`,
              '',
              \`### Pages Updated (\${updated})\`,
              updated === 0 ? '_None_' : \`\${updated} wiki page(s) updated.\`,
              '',
              \`### Contradictions Detected (\${contradictions})\`,
              contradictions === 0 ? 'None — docs are consistent.' : \`\${contradictions} contradiction(s) detected. Run \\\`legion.resolveContradiction\\\` to review.\`,
              '',
              '---',
              '*Generated by [Legion](https://github.com/thenotoriousllama/legion) — wiki diff from merge base to HEAD*',
            ].join('\\n');

            const comments = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });

            const existing = comments.data.find(c => c.body && c.body.includes(marker));

            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }
`;
}
