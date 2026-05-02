<div align="center">

<img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/legion-icon.png" alt="Legion for Obsidian" width="128" />

# Legion for Obsidian

### The non-developer's window into your Legion wiki.

Status panel. Contradiction inbox. Human annotations.<br/>
Trigger Update from the ribbon. Color-coded entities. All inside Obsidian.

<br/>

[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0%2B-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Version](https://img.shields.io/badge/version-1.0.0-0B0F19?style=for-the-badge)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-0B0F19?style=for-the-badge)](../../LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-PayPal-FFDD00?style=for-the-badge)](https://www.paypal.com/ncp/payment/7F5JZAHDHGCXC)

<br/>

[**Legion VS Code Extension**](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion) &nbsp;·&nbsp; [**Source**](https://github.com/thenotoriousllama/legion) &nbsp;·&nbsp; [**Sponsor**](https://www.paypal.com/ncp/payment/7F5JZAHDHGCXC) &nbsp;·&nbsp; [**Linktree**](https://linktr.ee/marioaldayuz)

</div>

<br/>

---

## Why this exists

Legion's heavy lifting happens in VS Code / Cursor — chunking the repo, invoking guardians, reconciling the wiki. But your PMs, designers, and domain experts live in Obsidian, not VS Code. This plugin gives them a first-class seat at the wiki:

- Read the wiki the way they already read everything else.
- See drift the moment it appears.
- Annotate pages without ever opening a terminal.
- Trigger fresh scans without bothering an engineer.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Status sidebar panel

Wiki health at a glance: initialized state, last scan date, entity count, coverage %, and unresolved contradiction count. Updates within 2 seconds when `.legion/config.json` changes.

</td>
<td width="50%" valign="top">

### Contradiction inbox

List unresolved wiki contradictions, open both conflicting pages side-by-side, and mark them resolved without ever leaving Obsidian. Writes a `.bak` safety backup before mutating state.

</td>
</tr>
<tr>
<td valign="top">

### Trigger Update

Ribbon icon and command-palette entry write a queue marker that the Legion VS Code extension picks up on its next activation. Incremental wiki scan — no engineer required.

</td>
<td valign="top">

### Human annotations

"Annotate" button on every wiki entity page appends a `## Human Notes` section. Legion's wiki-guardian is contractually forbidden from overwriting it. Your team's voice survives every regen.

</td>
</tr>
<tr>
<td valign="top">

### Entity color coding

Installs a CSS snippet that color-codes wiki files in the file explorer: entities (blue), concepts (green), decisions (purple), questions (orange). One glance, full picture.

</td>
<td valign="top">

### Dependency graph

Command-palette entry opens Obsidian's graph view filtered to `entities/` files only — see the entity relationships Legion has discovered in pure visual form.

</td>
</tr>
</table>

---

## Requirements

- Obsidian **1.4.0** or later (desktop only)
- [Legion VS Code Extension](https://marketplace.visualstudio.com/items?itemName=thenotoriousllama.legion) **0.6.0** or later, installed and initialized in the repo
- The vault root must contain `.legion/config.json` (created by `Legion: Initialize Repository`)

---

## Installation

### Via BRAT (recommended for beta)

```
1. Install the BRAT plugin from Obsidian community plugins.
2. Open BRAT settings → "Add Beta Plugin".
3. Enter: https://github.com/thenotoriousllama/legion
4. Enable "Legion" under Settings → Community Plugins.
```

### Manual

```
1. Copy main.js, manifest.json, and styles.css into your vault at:
   .obsidian/plugins/legion-obsidian/
2. Reload Obsidian.
3. Enable the plugin under Settings → Community Plugins.
```

---

## Usage

**Status panel.** Opens automatically in the left sidebar on plugin load. If hidden, run `Legion: Open Status Panel` from the command palette.

**Contradiction inbox.** Click the contradiction count row in the Status panel. For each entry, **Open diff** loads both pages side-by-side; **Mark resolved** updates `.legion/config.json` and clears the entry.

**Trigger Update.** Click the refresh icon in the ribbon, or run `Legion: Trigger Update`. Writes a marker to `.legion/queue/` — the VS Code extension processes it next time VS Code activates.

**Human annotations.** Open any wiki entity page; click **Annotate** at the top. Appends `## Human Notes` to the file (if absent) and opens it for editing.

**CSS snippet.** On first install the plugin writes `legion-vault-colors.css` to `.obsidian/snippets/`. Enable it in **Obsidian → Appearance → CSS Snippets** to activate entity-type color coding.

---

## `.legion/config.json` schema

<details>
<summary><b>The contract this plugin reads (and minimally writes)</b></summary>

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

The `contradictions` array follows the schema in `src/utils/configReader.ts`. Older Legion versions that do not write `coveragePct` show `—` in the status panel (graceful degradation).

</details>

---

## Development

```bash
cd companion-plugins/legion-obsidian
npm install
npm run dev      # watch mode with inline sourcemaps
npm run build    # production build → main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/legion-obsidian/` directory to test.

---

## About the author

<table>
<tr>
<td width="160" valign="top" align="center">
<img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/mario-portrait.png" width="140" alt="Mario Aldayuz" />
</td>
<td valign="top">

### Mario Aldayuz

Marine Corps veteran. Former Creative Director (BRMC, ~10 years). Founder of [OllieBot.ai](https://olliebot.ai) and [ManageN8N](https://managen8n.com). Elite automation consultant through Wise Guys Consulting.

I build tools I wish I'd had. Legion is one of them.

[**marioaldayuz.com**](https://www.marioaldayuz.com) &nbsp;·&nbsp; [**Linktree**](https://linktr.ee/marioaldayuz)

</td>
</tr>
</table>

---

## Support

If this plugin earns its keep on your team, buy me a coffee — or a finger of bourbon.

<div align="center">

<a href="https://www.paypal.com/ncp/payment/7F5JZAHDHGCXC">
  <img src="https://raw.githubusercontent.com/thenotoriousllama/legion/HEAD/media/bmc.png" alt="Buy Me a Coffee" width="220" />
</a>

</div>

---

## Connect

- Linktree — [linktr.ee/marioaldayuz](https://linktr.ee/marioaldayuz)
- Website — [marioaldayuz.com](https://www.marioaldayuz.com)
- GitHub — [@thenotoriousllama](https://github.com/thenotoriousllama)
- Issues — [github.com/thenotoriousllama/legion/issues](https://github.com/thenotoriousllama/legion/issues)
