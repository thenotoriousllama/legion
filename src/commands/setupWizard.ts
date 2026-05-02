/**
 * Legion: Setup Wizard
 *
 * A multi-step guided flow that walks users through:
 *   1. Picking an agent invocation mode
 *   2. Entering the required API key for that mode
 *   3. Optionally configuring additional provider keys
 *
 * Keys are stored in VS Code's SecretStorage (DPAPI / Keychain / libsecret).
 * Never in settings.json.
 *
 * Auto-fires on the first Initialize Repository run if no key is configured
 * for the current mode. A globalState flag prevents repeat firings.
 *
 * Also available via Command Palette: "Legion: Setup Wizard…"
 */
import * as vscode from "vscode";
import { setSecret, getSecret, getSetupState, maskSecret, SECRET_KEYS, type SecretKey } from "../util/secretStore";

export const WIZARD_COMPLETED_FLAG = "legion.setupWizardCompleted";

interface WizardOptions {
  /** If set, jump straight to step 3 for this key (skip mode picker). */
  focusKey?: SecretKey;
  /** Called each time a key is saved (for live sidebar refresh). */
  onKeyUpdated?: () => void;
}

// ── Step definitions ────────────────────────────────────────────────────────

const MODE_ITEMS: vscode.QuickPickItem[] = [
  {
    label: "$(cloud) cursor-sdk",
    description: "Recommended for Cursor users",
    detail:
      "Uses @cursor/sdk — invokes guardians via Cursor's agent runtime. " +
      "Requires a Cursor API key (paid plan). Agents have full file-system access.",
  },
  {
    label: "$(key) direct-anthropic-api",
    description: "Works everywhere, no Cursor subscription needed",
    detail:
      "Calls Anthropic (Claude) or OpenRouter directly. Fast, reliable, " +
      "works in VS Code, Cursor, devcontainers, and CI. Best for most users.",
  },
  {
    label: "$(list-unordered) queue-file",
    description: "Manual — write request files, process via /legion-drain",
    detail:
      "Legion writes JSON payloads to .legion/queue/. You process them manually " +
      "with a Cursor slash command. Full control, no API key required.",
  },
];

interface OptionalProvider {
  key: SecretKey;
  label: string;
  detail: string;
  helpUrl: string;
}

const OPTIONAL_PROVIDERS: OptionalProvider[] = [
  {
    key: "cohereApiKey",
    label: "$(search) Cohere — Semantic Search",
    detail: "Powers Find Entity semantic search. Without it, TF-IDF fallback is used (slower, less accurate).",
    helpUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    key: "exaApiKey",
    label: "$(globe) Exa — Autoresearch web search",
    detail: "Neural web search for Autoresearch. Finds semantically relevant pages with clean extracted text.",
    helpUrl: "https://exa.ai",
  },
  {
    key: "firecrawlApiKey",
    label: "$(browser) Firecrawl — Web scraping + Ingest URL",
    detail: "Scrapes web pages as clean markdown for Autoresearch and the Ingest URL command.",
    helpUrl: "https://firecrawl.dev",
  },
  {
    key: "context7ApiKey",
    label: "$(book) Context7 — Library documentation",
    detail: "Higher-rate access to official library / framework docs in Autoresearch. Works without a key at basic rate.",
    helpUrl: "https://context7.com",
  },
];

// ── Main entry point ─────────────────────────────────────────────────────────

export async function setupWizard(
  context: vscode.ExtensionContext,
  sidebarProvider?: { refreshSetupState: (ctx: vscode.ExtensionContext) => Promise<void> },
  options: WizardOptions = {}
): Promise<void> {
  // Visible breadcrumb so users know the click registered. If you don't see
  // this status-bar message when clicking "Run Setup Wizard", the click never
  // reached the extension host (most likely cause: the sidebar webview is
  // running stale code from a previous version — reload the window with
  // Ctrl+Shift+P → "Developer: Reload Window").
  const breadcrumb = vscode.window.setStatusBarMessage(
    "$(rocket) Legion Setup Wizard…",
    3000
  );

  const refresh = async () => {
    options.onKeyUpdated?.();
    await sidebarProvider?.refreshSetupState(context).catch(() => undefined);
  };

  // If focused on a specific key, jump straight to the prompt
  if (options.focusKey) {
    await promptForKey(context, options.focusKey, refresh);
    breadcrumb.dispose();
    return;
  }

  // ── Step 1: Pick invocation mode (QuickPick — appears at top of screen, unmissable) ─
  const cfg = vscode.workspace.getConfiguration("legion");
  const currentMode = cfg.get<string>("agentInvocationMode", "cursor-sdk");

  const modePick = await vscode.window.showQuickPick(
    MODE_ITEMS.map((item) => ({
      ...item,
      picked: item.label.includes(currentMode),
    })),
    {
      title: "Legion Setup (1/2) — Invocation mode",
      placeHolder: "How should Legion invoke guardians?",
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );

  if (!modePick) {
    breadcrumb.dispose();
    return;
  }

  const selectedMode = modePick.label.includes("cursor-sdk")
    ? "cursor-sdk"
    : modePick.label.includes("direct-anthropic-api")
    ? "direct-anthropic-api"
    : "queue-file";

  await cfg.update("agentInvocationMode", selectedMode, vscode.ConfigurationTarget.Global);

  // ── Step 3: Required key for chosen mode ───────────────────────────────────
  let requiredKey: SecretKey | null = null;
  if (selectedMode === "cursor-sdk") {
    requiredKey = "cursorApiKey";
  } else if (selectedMode === "direct-anthropic-api") {
    requiredKey = "anthropicApiKey";
  }

  if (requiredKey) {
    const saved = await promptForKey(context, requiredKey, refresh);
    if (!saved) {
      breadcrumb.dispose();
      return;
    }
  }

  // ── Step 4: Optional providers ─────────────────────────────────────────────
  const alreadyConfigured = new Set<SecretKey>();
  for (const p of OPTIONAL_PROVIDERS) {
    if (await getSecret(context, p.key)) alreadyConfigured.add(p.key);
  }

  const optionalItems = OPTIONAL_PROVIDERS.map((p) => ({
    ...p,
    label: alreadyConfigured.has(p.key) ? `$(check) ${p.label.replace(/^\$\(\w+\) /, "")}` : p.label,
    picked: false,
  }));

  if (optionalItems.length > 0) {
    const picks = await vscode.window.showQuickPick(optionalItems, {
      title: "Legion Setup (2/2) — Optional providers",
      placeHolder:
        "Select additional providers to configure (Space to toggle, Enter to confirm). ESC to skip.",
      canPickMany: true,
      matchOnDetail: true,
    });

    if (picks && picks.length > 0) {
      for (const pick of picks) {
        await promptForKey(context, pick.key, refresh);
      }
    }
  }

  // ── Step 5: Done ──────────────────────────────────────────────────────────
  await context.globalState.update(WIZARD_COMPLETED_FLAG, true);
  await refresh();

  const setupState = await getSetupState(context, selectedMode);
  const configuredCount = setupState.filter((s) => s.configured).length;
  const totalCount = setupState.length;

  const doneChoice = await vscode.window.showInformationMessage(
    `Legion: Setup complete — ${configuredCount}/${totalCount} keys configured. ` +
      (selectedMode === "queue-file"
        ? "Queue-file mode needs no API key — you're ready."
        : "Run Document Repository to build your wiki."),
    "Document Repository",
    "Close"
  );

  if (doneChoice === "Document Repository") {
    await vscode.commands.executeCommand("legion.document");
  }
  breadcrumb.dispose();
}

// ── Prompt for a single key ──────────────────────────────────────────────────

/**
 * Show an input box for a specific API key. Stores it in SecretStorage on
 * save. Returns true if a value was saved, false if cancelled.
 */
export async function promptForKey(
  context: vscode.ExtensionContext,
  key: SecretKey,
  onSaved?: () => Promise<void>
): Promise<boolean> {
  const meta = SECRET_KEYS[key];
  const existing = await getSecret(context, key);

  const value = await vscode.window.showInputBox({
    title: `Legion — ${meta.label}`,
    prompt: `Enter your ${meta.label}. Stored in encrypted OS secret storage (not settings.json).`,
    placeHolder: existing
      ? `Current: ${maskSecret(existing)} — leave blank to keep`
      : (meta.placeholder || `Your ${meta.label}`),
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v && existing) return undefined; // keeping existing is fine
      if (!v) return `${meta.label} is required for this mode.`;
      if (v.trim() !== v) return "Remove surrounding whitespace.";
      if (v.length < 8) return "Key seems too short — double-check and try again.";
      return undefined;
    },
  });

  if (value === undefined) return false; // cancelled
  if (value === "" && existing) return true; // keeping existing
  if (!value) return false;

  await setSecret(context, key, value);
  await onSaved?.();

  // Offer quick-open to docs
  const learnMore = await vscode.window.showInformationMessage(
    `$(check) ${meta.label} saved.`,
    ...(meta.helpUrl ? ["View docs"] : [])
  );
  if (learnMore === "View docs") {
    await vscode.env.openExternal(vscode.Uri.parse(meta.helpUrl));
  }

  return true;
}
