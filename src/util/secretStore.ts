/**
 * Encrypted API-key storage for Legion using VS Code's SecretStorage API.
 *
 * Keys are stored in the OS-native secret store (DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux). They are no longer written to settings.json,
 * which could end up in screenshots, dotfiles repos, or VS Code Settings Sync.
 *
 * Resolution chain (same precedence for every key):
 *   1. Environment variables (for CI / headless / devcontainer use)
 *   2. SecretStorage (set by Setup Wizard, inline prompts, or onDidChangeConfiguration)
 *   3. settings.json config.get() (legacy; drained by migration on first v1.2.0 activate)
 *   4. Empty string (caller decides whether to surface an error)
 */
import * as vscode from "vscode";

// ── Key metadata ──────────────────────────────────────────────────────────────

/** All known Legion secret keys with their metadata. */
export const SECRET_KEYS = {
  cursorApiKey: {
    label: "Cursor API key",
    envVars: ["CURSOR_API_KEY", "LEGION_CURSOR_API_KEY"],
    required: "cursor-sdk" as const,
    helpUrl: "https://cursor.com/dashboard/cloud-agents",
    placeholder: "cursor_...",
  },
  anthropicApiKey: {
    label: "Anthropic API key",
    envVars: ["LEGION_ANTHROPIC_API_KEY"],
    required: "direct-anthropic-api" as const,
    helpUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-...",
  },
  openRouterApiKey: {
    label: "OpenRouter API key",
    envVars: ["LEGION_OPENROUTER_API_KEY"],
    required: null,
    helpUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-...",
  },
  cohereApiKey: {
    label: "Cohere API key",
    envVars: ["LEGION_COHERE_API_KEY"],
    required: null,
    helpUrl: "https://dashboard.cohere.com/api-keys",
    placeholder: "",
  },
  exaApiKey: {
    label: "Exa API key",
    envVars: ["LEGION_EXA_API_KEY"],
    required: null,
    helpUrl: "https://exa.ai",
    placeholder: "",
  },
  firecrawlApiKey: {
    label: "Firecrawl API key",
    envVars: ["LEGION_FIRECRAWL_API_KEY"],
    required: null,
    helpUrl: "https://firecrawl.dev",
    placeholder: "",
  },
  context7ApiKey: {
    label: "Context7 API key",
    envVars: ["LEGION_CONTEXT7_API_KEY"],
    required: null,
    helpUrl: "https://context7.com",
    placeholder: "",
  },
} as const;

export type SecretKey = keyof typeof SECRET_KEYS;

/** Namespace prefix for all keys stored in VS Code SecretStorage. */
const NS = "legion.secret.";

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Retrieve a secret following the full resolution chain:
 * env vars → SecretStorage → settings.json config fallback.
 *
 * Returns empty string when nothing is found. Callers decide whether to
 * surface an error or silently skip.
 */
export async function getSecret(
  context: vscode.ExtensionContext,
  key: SecretKey
): Promise<string> {
  const meta = SECRET_KEYS[key];

  // 1. Environment variables (highest priority — CI / headless)
  for (const envVar of meta.envVars) {
    const val = process.env[envVar];
    if (val?.trim()) return val.trim();
  }

  // 2. SecretStorage
  const stored = await context.secrets.get(NS + key);
  if (stored?.trim()) return stored.trim();

  // 3. Legacy settings.json fallback (for users who set keys before v1.2.0
  //    and whose migration hasn't fired yet, or who manually set them)
  const cfg = vscode.workspace.getConfiguration("legion");
  const legacy = cfg.get<string>(key, "");
  if (legacy?.trim()) return legacy.trim();

  return "";
}

/**
 * Store a secret in SecretStorage.
 * Throws if the value is empty (use deleteSecret to clear).
 */
export async function setSecret(
  context: vscode.ExtensionContext,
  key: SecretKey,
  value: string
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`setSecret: value for '${key}' must not be empty.`);
  await context.secrets.store(NS + key, trimmed);
}

/** Remove a secret from SecretStorage. */
export async function deleteSecret(
  context: vscode.ExtensionContext,
  key: SecretKey
): Promise<void> {
  await context.secrets.delete(NS + key);
}

/**
 * Check whether a secret has a value (any source: env, SecretStorage, config).
 * Cheaper than getSecret() only when you don't need the value itself.
 */
export async function hasSecret(
  context: vscode.ExtensionContext,
  key: SecretKey
): Promise<boolean> {
  return (await getSecret(context, key)) !== "";
}

/** Return a masked preview like "cursor_••••8a3f" (last 4 chars visible). */
export function maskSecret(value: string): string {
  if (!value) return "";
  const visible = value.slice(-4);
  const parts = value.split("_");
  const prefix = parts.length > 1 ? (parts[0] + "_") : "";
  const hiddenLen = Math.max(0, value.length - prefix.length - 4);
  return prefix + "•".repeat(Math.min(hiddenLen, 8)) + visible;
}

// ── One-time migration from settings.json ─────────────────────────────────────

const MIGRATION_FLAG = "legion.secretsMigrated.v1.2.0";

/**
 * Run once per install: drain any plaintext API keys from settings.json into
 * SecretStorage, then null them out. Idempotent — guarded by a globalState flag.
 *
 * The migration is strictly additive: it only writes to SecretStorage if the
 * settings.json value is non-empty AND SecretStorage doesn't already have a
 * value for that key. It clears the setting only after a successful write.
 */
export async function migrateSettingsKeysToSecretStorage(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_FLAG)) return;

  const cfg = vscode.workspace.getConfiguration("legion");
  const migratedLabels: string[] = [];

  for (const [key, meta] of Object.entries(SECRET_KEYS) as [SecretKey, (typeof SECRET_KEYS)[SecretKey]][]) {
    const plaintext = cfg.get<string>(key, "").trim();
    if (!plaintext) continue;

    // Don't overwrite a value already in SecretStorage (e.g. user set it via the wizard)
    const existing = await context.secrets.get(NS + key);
    if (!existing?.trim()) {
      await context.secrets.store(NS + key, plaintext);
    }

    // Clear from settings.json regardless of whether we wrote (it's plaintext either way)
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    migratedLabels.push(meta.label);
  }

  // Mark done before showing toast so a crash-on-toast never causes a re-run
  await context.globalState.update(MIGRATION_FLAG, true);

  if (migratedLabels.length > 0) {
    vscode.window.showInformationMessage(
      `Legion v1.2.0: ${migratedLabels.join(", ")} moved to encrypted OS storage — ` +
        `settings.json no longer contains your API keys.`
    );
  }
}

// ── Setup-state snapshot (for sidebar and wizard) ─────────────────────────────

export interface SetupKeyState {
  key: SecretKey;
  label: string;
  configured: boolean;
  masked: string;
  required: string | null;
  helpUrl: string;
}

/**
 * Return the full setup state snapshot for all known keys. Used by the sidebar
 * Setup section and the Setup Wizard to show current key status.
 */
export async function getSetupState(
  context: vscode.ExtensionContext,
  currentMode: string
): Promise<SetupKeyState[]> {
  const states: SetupKeyState[] = [];

  for (const [key, meta] of Object.entries(SECRET_KEYS) as [SecretKey, (typeof SECRET_KEYS)[SecretKey]][]) {
    const value = await getSecret(context, key);
    states.push({
      key,
      label: meta.label,
      configured: value !== "",
      masked: value ? maskSecret(value) : "",
      required: meta.required !== undefined ? (meta.required as string | null) : null,
      helpUrl: meta.helpUrl,
    });
  }

  // Re-order: put the key required for the current mode first, then others
  return states.sort((a, b) => {
    const aRequired = a.required === currentMode;
    const bRequired = b.required === currentMode;
    if (aRequired && !bRequired) return -1;
    if (!aRequired && bRequired) return 1;
    return 0;
  });
}
