import { Plugin, Notice } from "obsidian";
import {
  LegionStatusPanel,
  LEGION_STATUS_VIEW,
} from "./views/LegionStatusPanel";
import {
  ContradictionInboxView,
  LEGION_CONTRADICTION_VIEW,
} from "./views/ContradictionInboxView";
import { triggerUpdate } from "./commands/triggerUpdate";
import { showDependencyGraph } from "./commands/dependencyGraph";
import { createAnnotateProcessor } from "./widgets/AnnotateButton";

const CSS_SNIPPET_PATH = ".obsidian/snippets/legion-vault-colors.css";

export default class LegionPlugin extends Plugin {
  async onload(): Promise<void> {
    // Register status sidebar panel
    this.registerView(LEGION_STATUS_VIEW, (leaf) => new LegionStatusPanel(leaf));

    // Register contradiction inbox view
    this.registerView(
      LEGION_CONTRADICTION_VIEW,
      (leaf) => new ContradictionInboxView(leaf)
    );

    // Open status panel in left sidebar on load
    this.app.workspace.onLayoutReady(() => {
      void this.activateStatusView();
    });

    // Ribbon icon — trigger update
    this.addRibbonIcon("refresh-cw", "Legion: Trigger Update", () => {
      void triggerUpdate(this.app);
    });

    // Command palette: trigger update
    this.addCommand({
      id: "legion-trigger-update",
      name: "Trigger Update",
      callback: () => {
        void triggerUpdate(this.app);
      },
    });

    // Command palette: open status panel
    this.addCommand({
      id: "legion-open-status",
      name: "Open Status Panel",
      callback: () => {
        void this.activateStatusView();
      },
    });

    // Command palette: show entity dependency graph
    this.addCommand({
      id: "legion-dependency-graph",
      name: "Show Entity Dependency Graph",
      callback: () => {
        void showDependencyGraph(this.app);
      },
    });

    // Markdown post-processor: inject "Annotate" button into wiki entity pages
    this.registerMarkdownPostProcessor(createAnnotateProcessor(this.app));

    // Write CSS snippet once (non-destructive: skip if already exists)
    await this.writeCssSnippetOnce();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(LEGION_STATUS_VIEW);
    this.app.workspace.detachLeavesOfType(LEGION_CONTRADICTION_VIEW);
  }

  private async activateStatusView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(LEGION_STATUS_VIEW);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: LEGION_STATUS_VIEW, active: true });
    }
  }

  private async writeCssSnippetOnce(): Promise<void> {
    if (await this.app.vault.adapter.exists(CSS_SNIPPET_PATH)) return;

    try {
      // Read our bundled CSS from the plugin directory
      const cssContent = await this.app.vault.adapter.read(
        `${this.manifest.dir}/assets/legion-vault-colors.css`
      );
      await this.app.vault.adapter.mkdir(".obsidian/snippets");
      await this.app.vault.adapter.write(CSS_SNIPPET_PATH, cssContent);
      new Notice(
        "Legion: CSS snippet written to .obsidian/snippets/legion-vault-colors.css. Enable it in Appearance → CSS Snippets."
      );
    } catch {
      // Non-fatal: snippet can be added manually
    }
  }
}
