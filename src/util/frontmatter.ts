/**
 * Shared utility — parse the YAML frontmatter block (between `---` fences) of
 * a markdown file into a flat key→string map. Handles only scalar values;
 * sufficient for the frontmatter shapes wiki-guardian writes.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return {};

  const result: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (key) result[key] = raw.replace(/^["']|["']$/g, "");
  }
  return result;
}

/** Extract the first non-frontmatter heading or paragraph from a markdown file. */
export function extractFirstBody(content: string): string {
  const lines = content.split(/\r?\n/);
  let inFrontmatter = lines[0]?.trim() === "---";
  let passedClose = false;

  for (const line of lines) {
    if (inFrontmatter) {
      if (line.trim() === "---" && passedClose) {
        inFrontmatter = false;
      } else {
        passedClose = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--")) {
      return trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
    }
  }
  return "";
}
