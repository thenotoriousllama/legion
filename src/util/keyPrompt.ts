/**
 * Reusable inline key-prompt helpers (Phase 3 — v1.2.0).
 *
 * Replaces the pattern of:
 *   vscode.window.showWarningMessage("...set X...", "Open Settings")
 *   → commands.executeCommand("workbench.action.openSettings", "legion.X")
 *
 * With a three-button modal:
 *   "Enter API Key" | "Open Settings" | "Switch Mode"
 *
 * and stores the entered value in SecretStorage immediately.
 */
import * as vscode from "vscode";
import { setSecret, type SecretKey, SECRET_KEYS } from "./secretStore";
import { promptForKey } from "../commands/setupWizard";

export type KeyPromptResult = "entered" | "settings" | "switched" | "wizard" | "dismissed";

/**
 * Show a 3-button warning when a required key is missing.
 *
 *   "Enter API Key" → opens a password InputBox, saves to SecretStorage
 *   "Setup Wizard"  → fires legion.setupWizard
 *   "Open Settings" → opens the Settings UI filtered to the relevant key
 *
 * Returns a string indicating what the user chose, so callers can decide
 * whether to continue or abort the operation.
 */
export async function showKeyMissingError(
  context: vscode.ExtensionContext,
  key: SecretKey,
  messageOverride?: string,
  fallbackMode?: string
): Promise<KeyPromptResult> {
  const meta = SECRET_KEYS[key];

  const message =
    messageOverride ??
    `Legion: No ${meta.label} configured. ` +
      (fallbackMode
        ? `You can also switch to '${fallbackMode}' mode which uses a different key.`
        : "");

  const buttons: string[] = ["Enter API Key", "Setup Wizard", "Open Settings"];

  const choice = await vscode.window.showWarningMessage(message, ...buttons);

  if (choice === "Enter API Key") {
    const saved = await promptForKey(context, key);
    return saved ? "entered" : "dismissed";
  }
  if (choice === "Setup Wizard") {
    await vscode.commands.executeCommand("legion.setupWizard");
    return "wizard";
  }
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `@id:legion.${key}`
    );
    return "settings";
  }

  return "dismissed";
}

/**
 * Prompt for a key inline and save it. A lighter alternative to
 * showKeyMissingError when you just need the input box without a warning modal.
 */
export async function promptAndSaveKey(
  context: vscode.ExtensionContext,
  key: SecretKey,
  promptText?: string,
  helpUrl?: string
): Promise<string | undefined> {
  const meta = SECRET_KEYS[key];
  const value = await vscode.window.showInputBox({
    title: `Legion — ${meta.label}`,
    prompt: promptText ?? `Enter your ${meta.label}. Stored encrypted in OS secret storage.`,
    placeHolder: meta.placeholder || `Your ${meta.label}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v) return "Value is required.";
      if (v.trim() !== v) return "Remove surrounding whitespace.";
      if (v.length < 8) return "Key seems too short — double-check and try again.";
      return undefined;
    },
  });

  if (!value) return undefined;

  await setSecret(context, key, value);

  if (helpUrl ?? meta.helpUrl) {
    const view = await vscode.window.showInformationMessage(
      `$(check) ${meta.label} saved.`,
      "View docs"
    );
    if (view === "View docs") {
      await vscode.env.openExternal(vscode.Uri.parse(helpUrl ?? meta.helpUrl));
    }
  }

  return value;
}
