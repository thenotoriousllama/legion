import * as fs from "fs/promises";
import * as path from "path";

/**
 * Post-commit git hook installer. v0.2.0+.
 *
 * When the legion.installPostCommitHook setting is true and Initialize is run
 * (or the user runs Legion: Install Hook explicitly), this drops a script at
 * .git/hooks/post-commit that writes a marker into .legion/queue/ on every
 * commit. The next Update button drain (or the next session-start hook in
 * Cursor) processes the markers.
 *
 * v0.1.0: stub. Fully wired in v0.2.0.
 */

const HOOK_PATH = path.join(".git", "hooks", "post-commit");

const HOOK_TEMPLATE = [
  "#!/usr/bin/env bash",
  "# Installed by Legion (https://github.com/thenotoriousllama/legion)",
  "# Drops a 'scan-needed' marker into .legion/queue/ on every commit.",
  "set -e",
  "COMMIT_SHA=$(git rev-parse HEAD)",
  "SHORT_SHA=${COMMIT_SHA:0:7}",
  "TIMESTAMP=$(date +%Y%m%d-%H%M%S)",
  'MARKER=".legion/queue/${TIMESTAMP}-${SHORT_SHA}-scan-needed.json"',
  "mkdir -p .legion/queue",
  'cat > "$MARKER" <<MARKER_EOF',
  "{",
  '  "type": "scan-needed",',
  '  "request_id": "post-commit-${SHORT_SHA}",',
  '  "payload": {',
  '    "commit_sha": "$COMMIT_SHA",',
  '    "trigger": "post-commit"',
  "  },",
  '  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  "}",
  "MARKER_EOF",
  "",
].join("\n");

export async function installPostCommitHook(repoRoot: string): Promise<void> {
  const hookPath = path.join(repoRoot, HOOK_PATH);
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, HOOK_TEMPLATE);
  await fs.chmod(hookPath, 0o755);
}
