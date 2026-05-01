import type { App } from "obsidian";

/**
 * Open the Obsidian graph view filtered to entities/ files with dependency edges.
 * Uses Obsidian's standard graph view local filter — the filter persists once applied.
 */
export async function showDependencyGraph(app: App): Promise<void> {
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({
    type: "graph",
    state: {
      // Filter to files under entities/ only
      localFile: "",
      filters: {
        showOrphans: false,
        search: "path:entities/",
      },
    },
  });
  app.workspace.revealLeaf(leaf);
}
