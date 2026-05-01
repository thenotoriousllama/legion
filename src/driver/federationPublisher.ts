import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

/**
 * Federation manifest — a machine-readable catalog of all entity stubs in
 * this repo's wiki, publishable as a JSON file at a stable URL so peer repos
 * can fetch external entity references.
 */
export interface FederationManifest {
  repo: string;
  generated: string;
  entities: FederationEntity[];
}

export interface FederationEntity {
  name: string;
  type: string;
  module: string;
  path: string;
  status: string;
  depends_on: string[];
}

const ENTITY_DIR = path.join("library", "knowledge-base", "wiki", "entities");
const MANIFEST_PATH = path.join("library", "knowledge-base", "wiki", "federation-manifest.json");

/**
 * Serialize all entity pages into `library/knowledge-base/wiki/federation-manifest.json`.
 * Called from reconcile() when `legion.federation.publishManifest` is true.
 */
export async function publishFederationManifest(repoRoot: string): Promise<void> {
  const entityDir = path.join(repoRoot, ENTITY_DIR);
  let files: string[];
  try {
    files = await fs.readdir(entityDir);
  } catch {
    return; // wiki not initialized
  }

  const entities: FederationEntity[] = [];

  for (const file of files) {
    if (!file.endsWith(".md") || file.startsWith("_")) continue;
    const absPath = path.join(entityDir, file);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    const name = file.replace(/\.md$/, "");

    // Parse depends_on wikilinks
    const dependsRaw = fm["depends_on"] ?? "";
    const depends_on = extractWikiLinkNames(dependsRaw);

    entities.push({
      name,
      type: fm["entity_type"] ?? fm["type"] ?? "entity",
      module: (fm["path"] ?? "").split("/")[0] ?? "unknown",
      path: fm["path"] ?? "",
      status: fm["status"] ?? "seed",
      depends_on,
    });
  }

  const manifest: FederationManifest = {
    repo: path.basename(repoRoot),
    generated: new Date().toISOString(),
    entities,
  };

  const manifestPath = path.join(repoRoot, MANIFEST_PATH);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function extractWikiLinkNames(raw: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const target = m[1].trim().split("/").pop() ?? m[1].trim();
    results.push(target);
  }
  return results;
}
