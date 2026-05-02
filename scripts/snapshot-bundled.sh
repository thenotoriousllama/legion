#!/usr/bin/env bash
# Snapshot the Angels (agents/) and Weapons (skills/) from the legion-project
# source-of-truth into bundled/. Run before `vsce package` so the .vsix ships
# the latest guardian roster.
#
# Source resolution order:
#   1. $LEGION_SOURCE  — explicit override (absolute path to a .cursor/ folder)
#   2. ../legion-project/legion/.cursor/  — canonical CI layout
#                                           (gh checkout thenotoriousllama/legion-project)
#   3. ../God/legion/.cursor/  — legacy local layout (kept for backward compat)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLED="$EXT_ROOT/bundled"

# v1.2.10: prevent the duplicate-webview-js bug from recurring. The sidebar
# webview loads `media/webview.js` (resolved via extensionUri/media/...).
# A duplicate at `src/sidebar/media/webview.js` would silently shadow the
# real file in source control and trick anyone editing it into thinking
# their changes are loading. They aren't. v1.2.0–v1.2.9 all hit this exact
# foot-gun. Fail fast if the duplicate path is ever resurrected.
if [ -d "$EXT_ROOT/src/sidebar/media" ]; then
  echo "ERROR: src/sidebar/media/ exists — this duplicates the runtime path media/." >&2
  echo "       The sidebar webview only loads media/webview.{js,css}; anything in" >&2
  echo "       src/sidebar/media/ is silently ignored. Move files to media/ and delete" >&2
  echo "       src/sidebar/media/. See CHANGELOG v1.2.10 for context." >&2
  exit 1
fi

resolve_source() {
  if [ -n "${LEGION_SOURCE:-}" ]; then
    if [ ! -d "$LEGION_SOURCE" ]; then
      echo "ERROR: LEGION_SOURCE is set to '$LEGION_SOURCE' but that path does not exist." >&2
      exit 1
    fi
    (cd "$LEGION_SOURCE" && pwd)
    return
  fi

  local candidates=(
    "$EXT_ROOT/../legion-project/legion/.cursor"
    "$EXT_ROOT/../God/legion/.cursor"
  )

  for candidate in "${candidates[@]}"; do
    if [ -d "$candidate" ]; then
      (cd "$candidate" && pwd)
      return
    fi
  done

  echo "ERROR: Could not locate the legion-project source." >&2
  echo "Expected one of:" >&2
  for candidate in "${candidates[@]}"; do
    echo "  - $candidate" >&2
  done
  echo "Or set LEGION_SOURCE=/absolute/path/to/.cursor" >&2
  echo "" >&2
  echo "To clone the source repo locally:" >&2
  echo "  git clone https://github.com/thenotoriousllama/legion-project ../legion-project" >&2
  exit 1
}

LEGION_SRC="$(resolve_source)"
echo "Snapshotting from $LEGION_SRC -> $BUNDLED"

rm -rf "$BUNDLED"
mkdir -p "$BUNDLED/agents" "$BUNDLED/skills"

if [ -d "$LEGION_SRC/agents" ]; then
  cp -r "$LEGION_SRC/agents/." "$BUNDLED/agents/"
  echo "  Copied $(ls "$BUNDLED/agents" | wc -l) agent(s)"
fi

if [ -d "$LEGION_SRC/skills" ]; then
  cp -r "$LEGION_SRC/skills/." "$BUNDLED/skills/"
  echo "  Copied $(ls "$BUNDLED/skills" | wc -l) weapon(s)"
fi

echo "Snapshot complete."
