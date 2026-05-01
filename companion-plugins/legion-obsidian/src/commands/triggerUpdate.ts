import type { App } from "obsidian";
import { Notice } from "obsidian";

const QUEUE_DIR = ".legion/queue";

/**
 * Drop a `.legion/queue/<timestamp>-scan-needed.json` file to request a Legion
 * Update pass. The VS Code extension watches this directory and picks up the
 * marker on next activation.
 */
export async function triggerUpdate(app: App): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const markerPath = `${QUEUE_DIR}/${timestamp}-scan-needed.json`;

  const payload = JSON.stringify(
    {
      source: "obsidian",
      triggeredAt: new Date().toISOString(),
    },
    null,
    2
  );

  try {
    // Ensure queue directory exists
    if (!(await app.vault.adapter.exists(QUEUE_DIR))) {
      await app.vault.adapter.mkdir(QUEUE_DIR);
    }
    await app.vault.adapter.write(markerPath, payload);
    new Notice("Legion: Update queued. VS Code will pick this up on next activation.");
  } catch (err) {
    new Notice(`Legion: Could not write queue marker — ${String(err)}`);
  }
}
