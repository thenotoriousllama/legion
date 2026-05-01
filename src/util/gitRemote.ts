import { execSync } from "child_process";

export interface GitHubRemote {
  owner: string;
  repo: string;
}

/**
 * Run `git remote get-url origin` in the given repo root.
 * Returns the raw URL string, or throws on failure.
 */
export function getOriginUrl(repoRoot: string): string {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    if (!url) throw new Error("Empty remote URL");
    return url;
  } catch (err) {
    throw new Error(`No git remote 'origin' found: ${String(err)}`);
  }
}

/**
 * Parse a GitHub remote URL (HTTPS or SSH) and return { owner, repo }.
 * Returns null for non-GitHub remotes or unrecognised formats.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\s|$)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  // SSH: git@github.com:owner/repo[.git]
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?(?:\s|$)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return null;
}
