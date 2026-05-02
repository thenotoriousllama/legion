// Bootstrap environment hooks that the lazily-loaded `@cursor/sdk` reads
// during its internal startup. Called once from extension activate(), before
// anything can transitively `require("@cursor/sdk")`.
//
// Background: the SDK does background gitignore scanning (.gitignore +
// .cursorignore) the first time an Agent or Cursor instance touches the
// workspace. That scanner shells out to ripgrep, and the SDK resolves the
// binary in this order:
//
//   1. process.env.CURSOR_RIPGREP_PATH (must be absolute)
//   2. internal lookup helper (best-effort)
//   3. `which("rg")` on PATH
//
// If all three miss, every gitignore initialization throws:
//   "Ripgrep path not configured. Call configureRipgrepPath() at startup."
//
// Cursor (and VS Code) always ship a ripgrep binary at
//   <appRoot>/node_modules/@vscode/ripgrep/bin/rg{.exe}
// (and on some installs `node_modules.asar.unpacked/@vscode/ripgrep/...` if
// asar packing is in play). We probe both locations and seed the env var if
// either exists. If neither exists, we leave the env var alone and let the
// SDK's own fallbacks try.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function bootstrapCursorSdkEnv(): void {
  // Don't clobber an env var the user has explicitly set.
  if (process.env.CURSOR_RIPGREP_PATH && path.isAbsolute(process.env.CURSOR_RIPGREP_PATH)) {
    return;
  }

  const appRoot = vscode.env.appRoot;
  if (!appRoot) return;

  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [
    path.join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exe),
    path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        process.env.CURSOR_RIPGREP_PATH = candidate;
        return;
      }
    } catch {
      // existsSync should never throw, but stay defensive — a single
      // missing-permissions error here must not break extension activation.
    }
  }
}
