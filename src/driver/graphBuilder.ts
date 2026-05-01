import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const MAX_NODES = 100;

interface EntityNode {
  name: string;
  type: string;
  module: string;
  dependsOn: string[];
}

/**
 * Build a Mermaid `graph TD` entity relationship diagram from all wiki entity
 * pages and write it to `library/knowledge-base/wiki/graph.md`.
 *
 * - Reads `depends_on:` frontmatter fields from every `entities/*.md` page
 * - Groups nodes into subgraphs by top-level module (derived from `path:` field)
 * - Caps at MAX_NODES (100): above that switches to a module-level summary graph
 * - Uses VS Code's built-in Markdown preview (which renders Mermaid natively)
 *   — no npm dependency required
 *
 * Called from reconcile() Step 10 after every Document/Update pass.
 */
export async function buildEntityGraph(repoRoot: string): Promise<void> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);
  const entityDir = path.join(wikiRoot, "entities");

  let files: string[];
  try {
    files = await fs.readdir(entityDir);
  } catch {
    return; // wiki not yet initialized
  }

  const nodes: EntityNode[] = [];

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
    const entityType = fm["entity_type"] ?? fm["type"] ?? "entity";
    const sourcePath = fm["path"] ?? "";

    // Derive module from path field (first segment)
    const module = sourcePath ? sourcePath.split("/")[0] : "other";

    // Parse depends_on — may be "[[entities/foo]], [[entities/bar]]" or YAML list
    const dependsRaw = fm["depends_on"] ?? "";
    const dependsOn = extractWikilinks(dependsRaw);

    nodes.push({ name, type: entityType, module, dependsOn });
  }

  const mermaid =
    nodes.length <= MAX_NODES
      ? buildDetailGraph(nodes)
      : buildModuleSummaryGraph(nodes);

  const date = new Date().toISOString().slice(0, 10);
  const graphContent = [
    `---`,
    `type: meta`,
    `title: "Entity Graph"`,
    `updated: "${date}"`,
    `tags: [meta, graph]`,
    `---`,
    ``,
    `# Entity Graph`,
    ``,
    `> Generated automatically after each Document/Update pass.`,
    `> ${nodes.length} entities${nodes.length > MAX_NODES ? " (module summary — full graph exceeds 100 nodes)" : ""}.`,
    ``,
    "```mermaid",
    mermaid,
    "```",
    ``,
    `*Last generated: ${date}*`,
  ].join("\n");

  const graphPath = path.join(wikiRoot, "graph.md");
  await fs.writeFile(graphPath, graphContent);
}

function buildDetailGraph(nodes: EntityNode[]): string {
  const lines: string[] = ["graph TD"];

  // Group into subgraphs by module
  const byModule = new Map<string, EntityNode[]>();
  for (const n of nodes) {
    const list = byModule.get(n.module) ?? [];
    list.push(n);
    byModule.set(n.module, list);
  }

  let sgIdx = 0;
  const nodeIds = new Map<string, string>(); // name → safe id
  for (const n of nodes) {
    nodeIds.set(n.name, `N${nodeIds.size}`);
  }

  for (const [mod, modNodes] of byModule) {
    const sgId = `sg${sgIdx++}`;
    const safeLabel = mod.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`  subgraph ${sgId} [${safeLabel}]`);
    for (const n of modNodes) {
      const id = nodeIds.get(n.name) ?? n.name;
      const label = `${n.name}\\n${n.type}`;
      lines.push(`    ${id}["${label}"]`);
    }
    lines.push(`  end`);
  }

  // Edges
  for (const n of nodes) {
    const fromId = nodeIds.get(n.name);
    if (!fromId) continue;
    for (const dep of n.dependsOn) {
      const toId = nodeIds.get(dep);
      if (toId) {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }

  return lines.join("\n");
}

function buildModuleSummaryGraph(nodes: EntityNode[]): string {
  const lines: string[] = ["graph TD"];
  const modules = [...new Set(nodes.map((n) => n.module))];
  const moduleIds = new Map(modules.map((m, i) => [m, `M${i}`]));

  for (const [mod, id] of moduleIds) {
    const count = nodes.filter((n) => n.module === mod).length;
    lines.push(`  ${id}["${mod}\\n${count} entities"]`);
  }

  // Cross-module edges
  const edgeSet = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const depNode = nodes.find((x) => x.name === dep);
      if (!depNode || depNode.module === n.module) continue;
      const edge = `${moduleIds.get(n.module)} --> ${moduleIds.get(depNode.module)}`;
      if (!edgeSet.has(edge)) {
        edgeSet.add(edge);
        lines.push(`  ${edge}`);
      }
    }
  }

  return lines.join("\n");
}

function extractWikilinks(raw: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    // Strip path prefix — [[entities/foo]] → "foo"
    const target = m[1].trim().split("/").pop() ?? m[1].trim();
    results.push(target);
  }
  return results;
}
