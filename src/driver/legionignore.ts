import * as fs from "fs/promises";
import * as path from "path";

export interface LegionIgnore {
  /** Returns true if the given absolute path should be skipped. */
  shouldIgnore(absPath: string): boolean;
}

interface CompiledPattern {
  negated: boolean;
  regex: RegExp;
}

/**
 * Always-on patterns merged in BEFORE the user's `.legionignore` so even a
 * missing or stale file never lets the scanner walk into Legion's own
 * internals or other AI tools' config folders. These are not negatable —
 * if you genuinely want one of them indexed (rare), open an issue.
 *
 * Subfolders are listed explicitly (e.g. `.cursor/agents/`) on top of the
 * parent (`.cursor/`) as a triple-belt against any future regex regression
 * in `compilePattern` and to make `Show ignored` audits read intuitively.
 *
 * v1.2.19: introduced after multiple users reported `.cursor/agents/*.md`
 * and `.claude-plugin/*` showing up as wiki entities even with an updated
 * `.legionignore` on disk — turned out their `.legionignore` was the
 * pre-v1.2.14 template (initializer was skip-if-exists, never updated).
 */
export const IMPLICIT_IGNORE_PATTERNS = [
  // Legion's own state
  ".legion/",
  ".legion-shared/",
  "library/",
  "bundled/",

  // VCS + editor
  ".git/",
  ".svn/",
  ".hg/",
  ".vscode/",
  ".idea/",

  // AI / agent tool folders — DO NOT index these (we own .cursor/, others
  // own theirs). Listed both as parent dirs and as subfolders for safety.
  ".cursor/",
  ".cursor/agents/",
  ".cursor/skills/",
  ".cursor/rules/",
  ".cursor/plugins/",
  ".claude/",
  ".claude-plugin/",
  ".claude-plugin/agents/",
  ".claude-plugin/skills/",
  ".aider/",
  ".continue/",
  ".windsurf/",
  ".codeium/",
  ".tabnine/",

  // Build outputs (catch even if user deleted them from .legionignore)
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".venv/",
  "__pycache__/",

  // Secrets — NEVER index, period
  ".env",
  ".env.*",
  ".envrc",
  "*.pem",
  "*.key",
  "secrets/",
  ".secrets/",
];

/**
 * Loads `.legionignore` from the repo root and returns a matcher.
 * Always merges in `IMPLICIT_IGNORE_PATTERNS` regardless of whether the
 * file exists, so the scanner has a baseline of safe-to-skip paths even
 * before any user configuration.
 *
 * Syntax is gitignore-compatible (https://git-scm.com/docs/gitignore):
 *   - Blank lines and `#` comments are ignored
 *   - Trailing `/` matches a directory and everything inside it
 *   - Leading `/` anchors the pattern to the repo root
 *   - `*` matches any chars except `/`
 *   - `**` matches any chars including `/`
 *   - `!pattern` negates a previous match
 */
export async function loadLegionIgnore(repoRoot: string): Promise<LegionIgnore> {
  const ignorePath = path.join(repoRoot, ".legionignore");
  let userLines: string[] = [];
  try {
    const content = await fs.readFile(ignorePath, "utf8");
    userLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    // No file — implicit patterns alone still apply.
  }
  // Implicit patterns first so user negations (`!foo`) can override them.
  const allLines = [...IMPLICIT_IGNORE_PATTERNS, ...userLines];
  const compiled = allLines.map(compilePattern);

  return {
    shouldIgnore(absPath: string): boolean {
      const rel = path.relative(repoRoot, absPath).replace(/\\/g, "/");
      let ignored = false;
      for (const { negated, regex } of compiled) {
        if (regex.test(rel)) {
          ignored = !negated;
        }
      }
      return ignored;
    },
  };
}

function compilePattern(raw: string): CompiledPattern {
  let pattern = raw;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  const isDir = pattern.endsWith("/");
  if (isDir) pattern = pattern.slice(0, -1);

  // Escape regex specials, then translate glob → regex
  // Order matters: handle `**` before `*`
  let r = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  r = r.replace(/\*\*/g, "::DOUBLESTAR::");
  r = r.replace(/\*/g, "[^/]*");
  r = r.replace(/::DOUBLESTAR::/g, ".*");
  r = r.replace(/\?/g, "[^/]");

  // Anchor: leading `/` means relative to root, otherwise match any depth
  if (r.startsWith("/")) {
    r = "^" + r.slice(1);
  } else {
    r = "(^|.*/)" + r;
  }

  // Suffix: directory pattern matches the dir or anything inside
  if (isDir) {
    r += "(/.*)?$";
  } else {
    r += "($|/.*)";
  }

  return { negated, regex: new RegExp(r) };
}
