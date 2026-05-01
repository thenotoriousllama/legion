# Feature #006: PR Review Bot — One-click GitHub Actions Setup and Rich PR Comments

> **Legion VS Code Extension** — Feature PRD #006 of 6
>
> **Status:** Ready for implementation
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Phase Overview

### Goals

Legion ships a `bundled/templates/legion-wiki-diff.yml` GitHub Actions workflow that runs a wiki diff on every pull request and posts a comment summarising which entity pages were created, updated, or had contradictions detected. This workflow delivers significant value — developers get instant documentation impact feedback on PRs — but it sees low adoption because setup is entirely manual: the user must copy the YAML file, configure three secrets, and commit the workflow. Many developers discover the workflow exists only after reading the README carefully.

This PRD defines a `legion.installPrReviewBot` command that automates the four-step setup: it detects the GitHub remote URL, copies the workflow file (idempotently), opens the GitHub secrets configuration URL in the browser, and shows completion instructions. It also significantly upgrades the PR comment format: replacing a simple text block with structured Markdown tables, a docs-health badge, and an idempotent comment-update strategy (find the existing Legion comment and update it on every push, rather than posting a new comment each time).

### Scope

- New command: `legion.installPrReviewBot` registered in `extension.ts` and `package.json`
- Step 1: parse owner/repo from `git remote get-url origin` output (supports HTTPS and SSH remote formats)
- Step 2: copy `bundled/templates/legion-wiki-diff.yml` to `.github/workflows/legion-wiki-diff.yml`; if the file already exists, show a diff QuickPick and ask "Overwrite?", "Skip", or "Show diff"
- Step 3: open `https://github.com/{owner}/{repo}/settings/secrets/actions/new` in VS Code's `vscode.env.openExternal`
- Step 4: show a multi-step information message with the required secret names and next-steps instructions
- PR comment improvements in `bundled/templates/legion-wiki-diff.yml`:
  - Idempotent update: search existing PR comments for the Legion bot marker, update if found rather than posting a new comment
  - Structured tables: pages created, pages updated, contradictions, ADRs filed
  - Docs-health badge (green/yellow/red) based on contradiction status
  - Link to the wiki diff commit on the PR branch
- New sidebar button: "Install PR Review Bot" in the sidebar footer

### Out of scope

- GitLab / Bitbucket CI pipeline equivalents — GitHub Actions only for Phase 1
- Automatic secret injection via GitHub API — requires a GitHub OAuth token; out of scope; the browser-open approach is the right UX tradeoff
- Monitoring existing PR bot runs from within VS Code — separate PRD
- Webhook-based triggers (posting comments on issue creation, etc.) — separate PRD
- GHES (GitHub Enterprise Server) support — standard github.com only for Phase 1

### Dependencies

- **Blocks:** none
- **Blocked by:** none
- **External:** GitHub account with write access to the target repo. `LEGION_ANTHROPIC_API_KEY` secret must be set in the repo's GitHub Actions secrets.

---

## User Stories

### US-6.1 — One-command PR bot installation

**As a** developer who wants Legion to comment on PRs, **I want** a single command that installs the GitHub Actions workflow and walks me through the secret setup, **so that** I don't need to manually copy files or read documentation to get the bot running.

**Acceptance criteria:**
- AC-6.1.1 When I run `legion.installPrReviewBot`, Legion detects my GitHub remote (HTTPS or SSH format), copies the workflow file, and confirms each step with VS Code information messages.
- AC-6.1.2 The workflow file is copied to `.github/workflows/legion-wiki-diff.yml` in the repo root.
- AC-6.1.3 If `.github/workflows/legion-wiki-diff.yml` already exists and is identical to the bundled template, Legion skips the copy and shows "Workflow already installed — no changes needed."
- AC-6.1.4 If the file exists but differs (user has customised it), Legion shows a QuickPick: "Overwrite with latest", "Skip (keep existing)", "Show differences in editor".
- AC-6.1.5 After the file step, Legion opens `https://github.com/{owner}/{repo}/settings/secrets/actions/new` in the default browser.
- AC-6.1.6 After the browser step, Legion shows a final information message listing the required secret names (`LEGION_ANTHROPIC_API_KEY`) and a "Done — commit your workflow file to enable the bot" instruction.

### US-6.2 — GitHub remote detection

**As a** developer with a non-standard remote URL format, **I want** Legion to correctly parse my GitHub remote regardless of whether I use HTTPS or SSH, **so that** the secrets URL is always correct.

**Acceptance criteria:**
- AC-6.2.1 Given `git remote get-url origin` returns `https://github.com/acme/my-repo.git`, Legion extracts `owner=acme` and `repo=my-repo`.
- AC-6.2.2 Given the remote returns `git@github.com:acme/my-repo.git`, Legion extracts the same `owner=acme` and `repo=my-repo`.
- AC-6.2.3 Given no remote named `origin` exists (or the repo has no remote), Legion shows an error: "No GitHub remote detected. Please push your repo to GitHub first."
- AC-6.2.4 Given the remote URL points to a non-GitHub host (e.g., `gitlab.com`), Legion shows: "Remote is not a GitHub repository. GitHub Actions setup requires a GitHub remote."

### US-6.3 — Idempotent PR comment update

**As a** developer reviewing a PR where I've pushed multiple commits, **I want** the Legion PR comment to update in-place on each push rather than posting a new comment, **so that** the PR thread is not flooded with Legion comments.

**Acceptance criteria:**
- AC-6.3.1 On first push to a PR, Legion posts one new comment with the wiki diff summary.
- AC-6.3.2 On subsequent pushes to the same PR, the workflow finds the existing Legion comment (by its `<!-- legion-wiki-diff -->` HTML marker) and updates it rather than posting a new comment.
- AC-6.3.3 If the Legion comment was manually deleted from the PR, the next push creates a fresh comment.

### US-6.4 — Rich structured PR comment

**As a** developer reviewing a PR, **I want** the Legion comment to show structured tables of created/updated/contradicted pages with a health badge, **so that** I can quickly assess the documentation impact of the changes without reading raw output.

**Acceptance criteria:**
- AC-6.4.1 The comment includes a "Docs health" badge: `![Docs Health](https://img.shields.io/badge/Docs-green-brightgreen)` when zero contradictions, yellow when contradictions detected but resolved, red when unresolved contradictions.
- AC-6.4.2 A "Pages Created" table lists: entity name, type, link to wiki page on the PR branch.
- AC-6.4.3 A "Pages Updated" table lists: entity name, type, change summary (first non-empty diff line).
- AC-6.4.4 A "Contradictions" table lists: entity name, old value, new value, resolution status.
- AC-6.4.5 An "ADRs Filed" table (if any) lists: ADR title, link to the ADR file on the PR branch.
- AC-6.4.6 A link to the wiki diff commit: "View wiki changes: [abc1234](https://github.com/{owner}/{repo}/commit/{sha})".

### US-6.5 — Sidebar installation button

**As a** developer browsing the Legion sidebar, **I want** a "Install PR Review Bot" button in the footer, **so that** I can discover and install the bot from within VS Code without searching the README.

**Acceptance criteria:**
- AC-6.5.1 The sidebar footer contains an "Install PR Review Bot" button (icon + label).
- AC-6.5.2 Clicking it runs `legion.installPrReviewBot`.
- AC-6.5.3 If the workflow is already installed, the button label changes to "PR Review Bot ✓" with a checkmark, and clicking it shows "Workflow already installed" rather than re-running the wizard.

---

## Data Model Changes

None. The workflow YAML file is the only artifact written to disk.

---

## API / Endpoint Specs

No HTTP API from Legion's side. The GitHub Actions workflow uses the GitHub REST API internally (via `actions/github-script`) for the PR comment CRUD. The relevant GitHub API operations are:

### GitHub REST — List PR comments

```
GET /repos/{owner}/{repo}/issues/{pull_number}/comments
Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}
```

Response: array of comment objects, each with `{ id, body, user.login }`.

### GitHub REST — Create PR comment

```
POST /repos/{owner}/{repo}/issues/{pull_number}/comments
{
  "body": "<!-- legion-wiki-diff -->\n## Legion Docs Update\n..."
}
```

### GitHub REST — Update PR comment

```
PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
{
  "body": "<!-- legion-wiki-diff -->\n## Legion Docs Update\n...(updated body)..."
}
```

The `<!-- legion-wiki-diff -->` HTML comment is the idempotency marker. The workflow script searches all PR comments for this marker string to find the existing Legion comment.

---

## UI/UX Description

### Install wizard — step-by-step information messages

**Step 1: Remote detection** (shown as a progress step, no user input needed)
- "Detecting GitHub remote… ✓ Found: acme/my-repo"

**Step 2: Workflow file** (shown as information message if file already exists)
- "Workflow file already exists. What would you like to do?"
  - [Overwrite with latest] — copies bundled template over existing file
  - [Keep existing] — skips copy step
  - [Show diff] — opens a diff editor between existing file and bundled template

**Step 3: GitHub secrets** (information message)
- "Next: add your Anthropic API key as a GitHub Actions secret."
- [Open GitHub Secrets →] — opens the browser URL

**Step 4: Final instructions** (information message)
- "Almost done! Commit `.github/workflows/legion-wiki-diff.yml` and push it to enable the PR bot. Required secrets:
  - `LEGION_ANTHROPIC_API_KEY` — your Anthropic API key
  [Open README for details] [Done]"

### Sidebar button — PR bot status

The sidebar footer button has two states:

| State | Label | Icon | On click |
|---|---|---|---|
| Not installed | Install PR Review Bot | `$(cloud-upload)` | Run `legion.installPrReviewBot` |
| Installed (workflow file exists) | PR Review Bot ✓ | `$(check)` | Show "Already installed" info message |

### PR comment format (in `legion-wiki-diff.yml`)

```markdown
<!-- legion-wiki-diff -->
## Legion Docs Update

![Docs Health](https://img.shields.io/badge/Docs-No%20Contradictions-brightgreen)

**Commit:** [abc1234](https://github.com/acme/my-repo/commit/abc1234) | **Branch:** `feature/auth-refresh`

### Pages Created (3)

| Entity | Type | Wiki Page |
|---|---|---|
| `RefreshTokenService` | Class | [view](…/wiki/classes/RefreshTokenService.md) |
| `rotateTokens` | Function | [view](…/wiki/functions/rotateTokens.md) |
| `TokenRotationPolicy` | Interface | [view](…/wiki/interfaces/TokenRotationPolicy.md) |

### Pages Updated (1)

| Entity | Type | Change |
|---|---|---|
| `JwtService` | Class | Added `rotateRefreshToken()` method |

### Contradictions Detected (0)

None — docs are consistent.

### ADRs Filed (1)

| ADR | Title |
|---|---|
| [ADR-004](…/wiki/ADR-004-refresh-token-rotation.md) | Adopt rotating refresh tokens with 7-day sliding expiry |

---
*Generated by [Legion](https://github.com/…) — wiki diff from merge base to HEAD*
```

---

## Technical Considerations

### Git remote URL parsing

GitHub remote URLs come in two formats. The parser must handle both:

```typescript
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/.]+)(\.git)?/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+)(\.git)?/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // GitHub CLI SSH shorthand: gh repo clone owner/repo (sets remote to ssh)
  return null;
}
```

`git remote get-url origin` is called via Node.js `child_process.execSync` with `{ cwd: repoRoot }`. If the command fails (no git remote), Legion catches the error and shows the "No GitHub remote detected" message.

### Workflow file idempotency check

```typescript
async function checkWorkflowFile(
  repoRoot: string,
  bundledTemplate: string
): Promise<'missing' | 'identical' | 'modified'> {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'legion-wiki-diff.yml');
  try {
    const existing = await fs.readFile(workflowPath, 'utf8');
    return existing.trim() === bundledTemplate.trim() ? 'identical' : 'modified';
  } catch {
    return 'missing';
  }
}
```

When status is `'modified'`, Legion opens a diff editor:
```typescript
await vscode.commands.executeCommand(
  'vscode.diff',
  vscode.Uri.file(workflowPath),            // existing (left)
  vscode.Uri.parse(`data:text/plain,${encodeURIComponent(bundledTemplate)}`), // template (right)
  'legion-wiki-diff.yml (existing ↔ latest)'
);
```

### PR comment idempotency in the workflow YAML

The `github-script` step in the workflow uses this JavaScript logic:

```javascript
const marker = '<!-- legion-wiki-diff -->';
const comments = await github.rest.issues.listComments({
  owner: context.repo.owner,
  repo: context.repo.repo,
  issue_number: context.issue.number,
});

const existing = comments.data.find(c => c.body.includes(marker));
const body = `${marker}\n${buildCommentBody(diffOutput)}`;

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
```

### Docs-health badge logic

The badge URL is dynamically constructed from the diff output:

```javascript
function healthBadge(contradictions) {
  if (contradictions.unresolved > 0) {
    return '![Docs Health](https://img.shields.io/badge/Docs-Contradictions-red)';
  } else if (contradictions.resolved > 0) {
    return '![Docs Health](https://img.shields.io/badge/Docs-Resolved-yellow)';
  }
  return '![Docs Health](https://img.shields.io/badge/Docs-No%20Contradictions-brightgreen)';
}
```

Shields.io does not require an API key for static badge URLs. The badge is rendered as an `<img>` in GitHub Markdown.

### Workflow trigger configuration

The bundled `legion-wiki-diff.yml` triggers on:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'src/**'
      - 'packages/**/src/**'
```

The `paths` filter prevents the workflow from running on PRs that only change documentation, tests, or config files — reducing unnecessary API calls. Users can expand the paths list after installation.

### Sidebar button state detection

The sidebar provider checks for the presence of `.github/workflows/legion-wiki-diff.yml` at webview render time:

```typescript
const isInstalled = await fs.access(
  path.join(repoRoot, '.github', 'workflows', 'legion-wiki-diff.yml')
).then(() => true).catch(() => false);
```

This check runs each time the sidebar is refreshed (on Legion activation and after commands complete). No watcher is needed for Phase 1.

---

## Files Touched

### New files

- `src/commands/installPrReviewBot.ts` — command handler; remote parsing; file copy; browser open; wizard steps
- `src/util/gitRemote.ts` — `parseGitHubRemote(url)`, `getOriginUrl(repoRoot)` utilities
- `src/util/gitRemote.test.ts` — unit tests for remote URL parsing (HTTPS, SSH, no-remote, non-GitHub)

### Modified files

- `bundled/templates/legion-wiki-diff.yml` — upgrade PR comment format: idempotent comment update, structured tables, health badge, ADRs table, commit link
- `extension.ts` — register `legion.installPrReviewBot` command
- `package.json` — add `legion.installPrReviewBot` to `contributes.commands`
- `src/sidebar/sidebarProvider.ts` — add "Install PR Review Bot" / "PR Review Bot ✓" footer button with state detection
- `README.md` — update PR bot documentation to reference the command instead of manual file copy instructions

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — Remote detection and workflow file copy

Implement `src/util/gitRemote.ts`:
- `getOriginUrl(repoRoot)` — runs `git remote get-url origin` via `execSync`
- `parseGitHubRemote(url)` — regex parser for HTTPS + SSH formats

Implement `src/commands/installPrReviewBot.ts`:
- Remote detection (Step 1)
- Workflow file idempotency check
- File copy or diff offer (Step 2)
- Show informational messages for Steps 3 + 4

**Acceptance gate:** manual test on a real repo with HTTPS remote and another with SSH remote.

### Phase 2 — Browser open + sidebar button

- Open secrets URL via `vscode.env.openExternal`
- Add "Install PR Review Bot" footer button to `sidebarProvider.ts`
- State detection (installed / not installed)
- Register command in `extension.ts` and `package.json`

### Phase 3 — Upgraded `legion-wiki-diff.yml`

Update the bundled workflow template:
- Idempotent comment update using `github-script` and the `<!-- legion-wiki-diff -->` marker
- Structured Markdown tables (created, updated, contradictions, ADRs)
- Docs-health badge construction from diff output
- Commit link in comment footer

Write a test fixture (`test/fixtures/sample-diff-output.txt`) and unit test for `buildCommentBody()`.

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Remote URL parsing success rate (HTTPS + SSH) | 100% | `gitRemote.test.ts` unit tests |
| Workflow installation end-to-end success (manual test) | 100% (no errors in wizard steps) | Manual QA on 2 test repos |
| PR comment idempotency (N pushes → 1 comment, not N) | 0 duplicate comments | Integration test with GitHub API mock |
| PR comment renders correctly on GitHub (tables + badge) | All tables visible, badge shown | Manual review of a test PR |
| Sidebar button state correct (installed vs. not) | 0 incorrect states | Manual test |

---

## Open Questions

- **Q1:** Should the `legion.installPrReviewBot` command also offer to commit and push the workflow file as a final step? This would make setup truly one-click but requires the extension to run `git commit && git push`, which is a significant action. **Current plan:** leave commit/push to the user; show a clear instruction instead. This avoids the risk of committing to the wrong branch.
- **Q2:** Should the health badge link to a Legion docs page explaining what the badge means? **Current plan:** the badge is a static Shields.io URL with no click target (GitHub Markdown renders it as a non-linked image unless we add `[![badge](url)](link-url)`). Add a link target in Phase 2 if users find the badge confusing.
- **Q3:** Should the workflow YAML support fine-grained `paths` filters that auto-detect monorepo packages from `legion.scanRoots`? **Current plan:** static `paths` filter in the template; users can edit after installation. Dynamic generation from settings is a follow-up.
- **Q4:** What should the bot do if `LEGION_ANTHROPIC_API_KEY` is not set (secret missing)? **Current plan:** the workflow already has a `continue-on-error: true` guard; the comment will say "Legion run failed — check your LEGION_ANTHROPIC_API_KEY secret."

---

## Risks and Open Questions

- **Risk:** GitHub changes the PR comments API or rate-limits heavily. **Mitigation:** the `GITHUB_TOKEN` provided by GitHub Actions has built-in rate limits (1,000 requests/hour for REST API); one comment update per push is well within limits.
- **Risk:** The Shields.io badge URL may become rate-limited or unavailable. **Mitigation:** the badge is a non-critical UI element; if it fails to render, the rest of the comment is unaffected. A fallback text badge (`**Docs Health: ✅ No Contradictions**`) is included in the comment body above the badge image.
- **Risk:** The `execSync('git remote get-url origin')` call blocks the VS Code main thread. **Mitigation:** wrap in a `Promise` with `spawnSync` timeout (5s) or use the async `child_process.exec` variant. For the install wizard this is acceptable as it runs once, not in a tight loop.
- **Risk:** The bundled `legion-wiki-diff.yml` template diverges from user-customised installations after an extension update. **Mitigation:** the idempotency check in `installPrReviewBot` shows a diff when the files differ, letting the user see exactly what changed and decide whether to overwrite.

---

## Related

- [`feature-003-wiki-export/prd-feature-003-wiki-export.md`](../feature-003-wiki-export/prd-feature-003-wiki-export.md) — a future CI step could trigger a wiki export after the PR bot run
- [`feature-004-scheduled-research/prd-feature-004-scheduled-research.md`](../feature-004-scheduled-research/prd-feature-004-scheduled-research.md) — both features use `legion.autoGitCommit`; the PR bot workflow should include `[skip ci]` on auto-commits to avoid triggering itself
- [`feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md`](../feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md) — the workflow `paths` filter should eventually reflect `legion.scanRoots` sub-paths for monorepo repos
