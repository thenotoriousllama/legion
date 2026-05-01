import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const SCAN_DIRS = ["entities", "concepts"];

export interface BoundaryResult {
  name: string;
  score: number;
  path: string;
  module: string;
}

/**
 * Score wiki pages by their "frontier" value using a boundary score formula:
 *
 *   boundary_score(p) = (out_degree(p) - in_degree(p)) * recency_weight(p)
 *
 * Pages that point outward to many others (out_degree >> in_degree) and were
 * recently updated are likely frontier knowledge — the most productive next
 * research targets.
 *
 * Returns the top N pages sorted by score descending.
 * Returns [] if the wiki is empty or the score of all pages is <= 0.
 */
export async function scoreBoundary(
  repoRoot: string,
  topN: number
): Promise<BoundaryResult[]> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);

  // Collect all pages with their metadata
  interface PageMeta {
    name: string;
    relPath: string;  // wiki-root-relative
    module: string;
    updatedAt: Date;
    dependsOn: string[]; // outbound wikilinks
  }

  const pages: PageMeta[] = [];

  for (const dir of SCAN_DIRS) {
    const dirPath = path.join(wikiRoot, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      const absPath = path.join(dirPath, file);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      const name = file.replace(/\.md$/, "");
      const relPath = `${dir}/${file}`;
      const module = (fm["path"] ?? "").split("/")[0] ?? dir;

      // Parse updated date from frontmatter; fall back to file mtime
      let updatedAt = new Date(0);
      const updatedStr = fm["updated"] ?? fm["created"] ?? "";
      if (updatedStr) {
        const parsed = new Date(updatedStr);
        if (!isNaN(parsed.getTime())) updatedAt = parsed;
      }
      if (updatedAt.getTime() === 0) {
        try {
          const stat = await fs.stat(absPath);
          updatedAt = stat.mtime;
        } catch {}
      }

      // Extract outbound wikilinks from depends_on and body
      const dependsRaw = fm["depends_on"] ?? "";
      const bodyLinks = extractWikilinks(content);
      const fmLinks = extractWikilinks(dependsRaw);
      const dependsOn = [...new Set([...fmLinks, ...bodyLinks])];

      pages.push({ name, relPath, module, updatedAt, dependsOn });
    }
  }

  if (pages.length === 0) return [];

  // Build a name → page map for quick lookup
  const nameMap = new Map(pages.map((p) => [p.name.toLowerCase(), p]));

  // Compute in-degree (how many OTHER pages point to this page)
  const inDegree = new Map<string, number>();
  for (const p of pages) {
    for (const dep of p.dependsOn) {
      const key = dep.toLowerCase();
      if (nameMap.has(key)) {
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }
  }

  const now = Date.now();
  const results: BoundaryResult[] = [];

  for (const p of pages) {
    const outDegree = p.dependsOn.filter((d) => nameMap.has(d.toLowerCase())).length;
    const inDeg = inDegree.get(p.name.toLowerCase()) ?? 0;
    const daysSinceUpdate = Math.max(0, (now - p.updatedAt.getTime()) / 86_400_000);
    const recencyWeight = 1 / (daysSinceUpdate + 1);
    const score = (outDegree - inDeg) * recencyWeight;

    if (score > 0) {
      results.push({
        name: p.name,
        score,
        path: p.relPath,
        module: p.module,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWikilinks(text: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].trim().split("/").pop() ?? m[1].trim();
    results.push(target.replace(/\.md$/, ""));
  }
  return results;
}
