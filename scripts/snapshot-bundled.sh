#!/usr/bin/env bash
# Snapshot the agents and weapons from ../legion/.cursor/ into bundled/
# Run before `vsce package` to ensure the .vsix ships the latest guardian versions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LEGION_SRC="$(cd "$EXT_ROOT/../legion/.cursor" && pwd)"
BUNDLED="$EXT_ROOT/bundled"

if [ ! -d "$LEGION_SRC" ]; then
  echo "ERROR: Source not found at $LEGION_SRC"
  echo "Expected layout: God/legion/.cursor/{agents,skills}/ and God/legion-extension/"
  exit 1
fi

echo "Snapshotting from $LEGION_SRC -> $BUNDLED"

rm -rf "$BUNDLED"
mkdir -p "$BUNDLED/agents" "$BUNDLED/skills"

# Copy all agents
if [ -d "$LEGION_SRC/agents" ]; then
  cp -r "$LEGION_SRC/agents/." "$BUNDLED/agents/"
  echo "  Copied $(ls "$BUNDLED/agents" | wc -l) agent(s)"
fi

# Copy all weapons (skills)
if [ -d "$LEGION_SRC/skills" ]; then
  cp -r "$LEGION_SRC/skills/." "$BUNDLED/skills/"
  echo "  Copied $(ls "$BUNDLED/skills" | wc -l) weapon(s)"
fi

echo "Snapshot complete."
