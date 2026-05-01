import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { readConfig, writeConfig, type Contradiction } from "../utils/configReader";

export const LEGION_CONTRADICTION_VIEW = "legion-contradiction-inbox";

export class ContradictionInboxView extends ItemView {
  private contradictions: Contradiction[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return LEGION_CONTRADICTION_VIEW;
  }

  getDisplayText(): string {
    return "Legion Contradiction Inbox";
  }

  getIcon(): string {
    return "alert-triangle";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const config = await readConfig(this.app);
    this.contradictions = (config?.contradictions ?? []).filter((c) => !c.resolved);
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("legion-contradiction-inbox");

    if (this.contradictions.length === 0) {
      container.createEl("p", {
        text: "No unresolved contradictions. Wiki is consistent.",
        cls: "legion-empty-inbox",
      });
      return;
    }

    container.createEl("h4", {
      text: `Contradiction Inbox (${this.contradictions.length})`,
    });

    for (const contradiction of this.contradictions) {
      const card = container.createEl("div", { cls: "legion-contradiction-card" });

      card.createEl("p", {
        text: contradiction.description,
        cls: "legion-contradiction-description",
      });

      card.createEl("small", {
        text: `${contradiction.pageA} ↔ ${contradiction.pageB}`,
        cls: "legion-contradiction-pages",
      });

      const actions = card.createEl("div", { cls: "legion-contradiction-actions" });

      const diffBtn = actions.createEl("button", { text: "Open diff" });
      diffBtn.addEventListener("click", async () => {
        await this.openDiff(contradiction.pageA, contradiction.pageB);
      });

      const resolveBtn = actions.createEl("button", { text: "Mark resolved" });
      resolveBtn.addEventListener("click", async () => {
        await this.markResolved(contradiction.id);
      });
    }
  }

  private async openDiff(pageA: string, pageB: string): Promise<void> {
    const fileA = this.app.vault.getAbstractFileByPath(pageA);
    const fileB = this.app.vault.getAbstractFileByPath(pageB);

    if (fileA && "stat" in fileA) {
      await this.app.workspace.getLeaf("split").openFile(fileA as Parameters<typeof this.app.workspace.getLeaf>[0] extends string ? never : ReturnType<typeof this.app.vault.getFiles>[0]);
    }
    if (fileB && "stat" in fileB) {
      await this.app.workspace.getLeaf("split").openFile(fileB as Parameters<typeof this.app.workspace.getLeaf>[0] extends string ? never : ReturnType<typeof this.app.vault.getFiles>[0]);
    }
  }

  private async markResolved(id: string): Promise<void> {
    try {
      const config = await readConfig(this.app);
      if (!config) return;

      const updated = {
        ...config,
        contradictions: (config.contradictions ?? []).map((c) =>
          c.id === id ? { ...c, resolved: true } : c
        ),
      };

      await writeConfig(this.app, updated);
      new Notice("Legion: Contradiction marked resolved.");
      await this.refresh();
    } catch (err) {
      new Notice(`Legion: Could not update config — ${String(err)}`);
    }
  }
}
