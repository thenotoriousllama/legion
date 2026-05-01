import { ItemView, WorkspaceLeaf, type App, TFile } from "obsidian";
import { readConfig, type LegionConfig } from "../utils/configReader";

export const LEGION_STATUS_VIEW = "legion-status";
export const LEGION_CONTRADICTION_VIEW = "legion-contradiction-inbox";

export class LegionStatusPanel extends ItemView {
  private config: LegionConfig | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return LEGION_STATUS_VIEW;
  }

  getDisplayText(): string {
    return "Legion Status";
  }

  getIcon(): string {
    return "book";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
    this.registerEvent(
      this.app.vault.on("modify", (file: TFile) => {
        if (file.path === ".legion/config.json") {
          void this.refresh();
        }
      })
    );
  }

  async refresh(): Promise<void> {
    this.config = await readConfig(this.app);
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("legion-status-panel");

    if (!this.config) {
      const p = container.createEl("p", {
        text: "Legion not initialized in this vault.",
        cls: "legion-not-initialized",
      });
      void p;
      container.createEl("a", {
        text: "Install the Legion VS Code Extension →",
        href: "https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion",
      });
      return;
    }

    const {
      initialized,
      lastScanDate,
      entityCount,
      contradictions,
      coveragePct,
    } = this.config;

    const unresolvedCount = (contradictions ?? []).filter((c) => !c.resolved).length;

    container.createEl("h4", { text: "Legion Wiki Status" });

    this.row(container, "Initialized", initialized ? "✓" : "✗");
    this.row(container, "Last scan", lastScanDate ? lastScanDate.slice(0, 10) : "never");
    this.row(container, "Entities", String(entityCount ?? 0));
    this.row(container, "Coverage", coveragePct !== undefined ? `${coveragePct}%` : "—");

    const inboxRow = this.row(
      container,
      "Contradictions",
      String(unresolvedCount)
    );
    if (unresolvedCount > 0) {
      inboxRow.addClass("legion-has-contradictions");
      inboxRow.style.cursor = "pointer";
      inboxRow.addEventListener("click", () => {
        void this.app.workspace
          .getLeaf("split")
          .setViewState({ type: LEGION_CONTRADICTION_VIEW });
      });
    }
  }

  private row(parent: HTMLElement, label: string, value: string): HTMLElement {
    const row = parent.createEl("div", { cls: "legion-status-row" });
    row.createEl("span", { text: label, cls: "legion-label" });
    row.createEl("span", { text: value, cls: "legion-value" });
    return row;
  }
}
