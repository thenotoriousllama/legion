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
 * Loads `.legionignore` from the repo root and returns a matcher.
 * If the file is absent, the matcher returns `false` for everything.
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
  let lines: string[] = [];
  try {
    const content = await fs.readFile(ignorePath, "utf8");
    lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    // No file = no ignores
  }
  const compiled = lines.map(compilePattern);

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
