import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * Auto-commit wiki changes to git after a successful scan pass.
 *
 * Stages `library/` and `.legion/`, then commits only if there are
 * staged changes (avoids empty commits). Uses the same git binary
 * as the rest of the extension. Controlled by `legion.autoGitCommit`.
 */
export async function autoCommitWiki(repoRoot: string): Promise<void> {
  const opts = { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 };
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // Stage wiki and local state files
  await exec("git", ["add", "library/", ".legion/"], opts);

  // Check if there's anything to commit
  const { stdout } = await exec("git", ["diff", "--cached", "--quiet", "--exit-code"], opts).catch(
    (e: { code?: number }) => {
      // exit code 1 means there ARE staged changes — that's what we want
      if (e.code === 1) return { stdout: "", stderr: "" };
      throw e;
    }
  );
  void stdout;

  // Re-check by examining diff output (--quiet+--exit-code returns exit 1 when dirty)
  let hasStagedChanges = false;
  try {
    await exec("git", ["diff", "--cached", "--exit-code"], opts);
    // exit 0 = nothing staged
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) return; // Nothing to commit

  await exec(
    "git",
    ["commit", "-m", `wiki: auto-commit ${ts}`],
    opts
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
