# Legion Obsidian Plugin

A companion plugin for the [Legion VS Code Extension](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion) that brings Legion's wiki operational state into Obsidian — the knowledge management tool most non-developers already use.

## What it does

- **Status sidebar panel** — shows wiki health at a glance: initialized status, last scan date, entity count, coverage %, and unresolved contradiction count. Updates within 2 seconds when `.legion/config.json` changes.
- **Contradiction inbox** — list unresolved wiki contradictions, open both conflicting pages side-by-side, and mark them resolved without touching VS Code.
- **Trigger Update** — ribbon icon and command palette entry writes a queue marker that the Legion VS Code extension picks up on next activation, triggering an incremental wiki scan.
- **Human annotations** — "Annotate" button on every wiki entity page appends a `## Human Notes` section that Legion's wiki-guardian will never overwrite.
- **Entity color coding** — installs a CSS snippet that color-codes entity files by type in the file explorer (entities=blue, concepts=green, decisions=purple, questions=orange).
- **Dependency graph** — command palette entry opens the graph view filtered to `entities/` files.

## Requirements

- Obsidian 1.4.0 or later (desktop only)
- Legion VS Code Extension 0.6.0 or later installed and initialized in the repo
- The vault root must contain `.legion/config.json` (created by `Legion: Initialize Repository`)

## Installation

### Via BRAT (recommended for beta)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community plugins.
2. Open BRAT settings and click "Add Beta Plugin".
3. Enter the repository URL: `https://github.com/thenotoriousllama/legion` (or the GitHub path to this plugin once extracted to its own repo).
4. Enable the Legion plugin in Settings → Community Plugins.

### Manual installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault at `.obsidian/plugins/legion-obsidian/`.
2. Reload Obsidian.
3. Enable the plugin in Settings → Community Plugins.

## Usage

### Status panel

The Legion Status panel opens automatically in the left sidebar on plugin load. If it does not appear, run "Legion: Open Status Panel" from the command palette.

### Contradiction inbox

Click the contradiction count row in the Status panel to open the inbox. For each contradiction:
- **Open diff** — opens both conflicting pages side-by-side.
- **Mark resolved** — updates `.legion/config.json` (with a `.bak` safety backup) and removes the entry from the inbox.

### Trigger Update

Click the refresh icon in the ribbon, or run "Legion: Trigger Update" from the command palette. This writes a marker to `.legion/queue/` — the Legion VS Code extension processes it the next time VS Code activates.

### Human annotations

When reading any wiki entity page, an "Annotate" button appears at the top. Clicking it:
- Appends `## Human Notes` to the file if the section is absent.
- Opens the file for editing.

Legion's wiki-guardian will never overwrite the `## Human Notes` section.

### CSS snippet

On first install, the plugin writes `legion-vault-colors.css` to `.obsidian/snippets/`. Enable it in **Obsidian → Appearance → CSS Snippets** to activate entity-type color coding in the file explorer.

## `.legion/config.json` schema

The plugin reads (and minimally writes) `.legion/config.json`. Required fields:

```json
{
  "initialized": true,
  "lastScanDate": "2026-04-30T18:00:00.000Z",
  "entityCount": 142,
  "wikiPath": "library/knowledge-base/wiki",
  "contradictions": [],
  "coveragePct": 68
}
```

The `contradictions` array follows the schema in `src/utils/configReader.ts`. Older Legion versions that do not write `coveragePct` will show `—` in the status panel (graceful degradation).

## Development

```bash
cd companion-plugins/legion-obsidian
npm install
npm run dev      # watch mode with inline sourcemaps
npm run build    # production build → main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/legion-obsidian/` directory to test.
