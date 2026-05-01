import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { callLlm, type LlmConfig } from "../driver/llmClient";
import { parseFrontmatter, extractFirstBody } from "../util/frontmatter";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const PARTICIPANT_ID = "legion.wiki";

const SYSTEM_PROMPT = `You are @legion, an expert assistant that answers questions about a software codebase by drawing exclusively from its Legion wiki — a curated knowledge base of entity pages, concept pages, ADRs, and architectural decisions written by wiki-guardian agents.

Rules:
- Answer ONLY from the provided wiki context. Do not use general knowledge beyond what's in the pages.
- Cite wiki pages by name using [[double brackets]] when you reference them.
- If the wiki context is insufficient, say so and suggest running "Legion: Document Repository" or "Legion: Autoresearch" to build the relevant pages.
- Be concise and precise. Developers are reading this in a chat panel.`;

// ── Public registration ───────────────────────────────────────────────────────

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  repoRoot: string
): void {
  let participant: vscode.ChatParticipant;
  try {
    participant = vscode.chat.createChatParticipant(
      PARTICIPANT_ID,
      makeHandler(repoRoot)
    );
  } catch {
    // vscode.chat may not be available in older Cursor builds — fail silently.
    return;
  }

  participant.iconPath = vscode.Uri.file(
    path.join(context.extensionPath, "media", "legion-icon.png")
  );

  // Follow-up suggestions
  participant.followupProvider = {
    provideFollowups(_result, _context, _token) {
      return [
        { prompt: "What entities depend on this?", label: "Show dependents" },
        { prompt: "List all ADRs in this module", label: "List ADRs" },
        { prompt: "What are the open questions?", label: "Show questions" },
      ];
    },
  };

  context.subscriptions.push(participant);
}

// ── Handler ───────────────────────────────────────────────────────────────────

function makeHandler(
  repoRoot: string
): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> => {
    if (!repoRoot) {
      stream.markdown("Legion: No workspace folder open. Open a repository first.");
      return;
    }

    const cfg = vscode.workspace.getConfiguration("legion");
    const llmConfig = buildLlmConfig(cfg);

    // Check API key availability
    if (cfg.get<string>("apiProvider", "anthropic") === "anthropic" && !llmConfig.anthropicApiKey) {
      stream.markdown(
        "**Legion:** No API key configured. Set `legion.anthropicApiKey` or switch to OpenRouter via `legion.apiProvider`."
      );
      stream.button({
        command: "workbench.action.openSettings",
        arguments: ["legion.anthropicApiKey"],
        title: "Open Settings",
      });
      return;
    }

    stream.progress("Searching the wiki…");

    const wikiRoot = path.join(repoRoot, WIKI_REL);
    const question = request.prompt.trim();

    // Load wiki context
    const context_ = await gatherWikiContext(wikiRoot, question);

    if (!context_.hasContent) {
      stream.markdown(
        "**Legion:** The wiki is empty or not yet initialized. Run **Legion: Document Repository** first to build entity pages."
      );
      stream.button({
        command: "legion.document",
        title: "Document Repository",
      });
      return;
    }

    stream.progress(`Found ${context_.pageCount} relevant pages — synthesizing…`);

    // Call LLM with wiki context
    const userMessage = buildUserMessage(question, context_);
    let answer: string;
    try {
      answer = await callLlm(llmConfig, SYSTEM_PROMPT, userMessage);
    } catch (e) {
      stream.markdown(
        `**Legion:** LLM call failed — ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }

    stream.markdown(answer);

    // Surface referenced wiki page links
    const referencedPages = extractWikiLinks(answer);
    if (referencedPages.length > 0) {
      stream.markdown("\n\n---\n**Referenced wiki pages:**");
      for (const pageName of referencedPages.slice(0, 8)) {
        const absPath_ = resolveWikiPage(wikiRoot, pageName);
        if (absPath_) {
          stream.anchor(vscode.Uri.file(absPath_), pageName);
          stream.markdown("  ");
        }
      }
    }
  };
}

// ── Wiki context gathering ────────────────────────────────────────────────────

interface WikiContext {
  hasContent: boolean;
  pageCount: number;
  text: string;
}

async function gatherWikiContext(
  wikiRoot: string,
  question: string
): Promise<WikiContext> {
  const parts: string[] = [];
  let pageCount = 0;

  // 1. Hot cache (always include — recent context)
  try {
    const hot = await fs.readFile(path.join(wikiRoot, "hot.md"), "utf8");
    const hotBody = hot.replace(/^---[\s\S]*?---\n/m, "").trim();
    if (hotBody) {
      parts.push(`## Recent wiki activity (hot cache)\n\n${hotBody.slice(0, 800)}`);
    }
  } catch {
    // Not yet generated
  }

  // 2. Find relevant entity/concept pages by keyword matching
  const tokens = tokenize(question);
  const matchedPages = await findMatchingPages(wikiRoot, tokens);
  pageCount = matchedPages.length;

  for (const { name, content } of matchedPages.slice(0, 6)) {
    // Include frontmatter + first ~400 chars of body
    const body = content.replace(/^---[\s\S]*?---\n/m, "").trim().slice(0, 400);
    parts.push(`## Wiki page: [[${name}]]\n\n${body}`);
  }

  // 3. Overview if no specific pages found
  if (matchedPages.length === 0) {
    try {
      const overview = await fs.readFile(path.join(wikiRoot, "overview.md"), "utf8");
      parts.push(overview.slice(0, 600));
    } catch {}
  }

  return {
    hasContent: parts.length > 0,
    pageCount,
    text: parts.join("\n\n---\n\n"),
  };
}

async function findMatchingPages(
  wikiRoot: string,
  tokens: string[]
): Promise<Array<{ name: string; content: string }>> {
  const results: Array<{ name: string; score: number; content: string }> = [];
  const dirs = ["entities", "concepts", "decisions", "sources"];

  for (const dir of dirs) {
    const dirPath = path.join(wikiRoot, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      const name = file.replace(/\.md$/, "");
      const score = scoreRelevance(name, tokens);
      if (score > 0) {
        try {
          const content = await fs.readFile(path.join(dirPath, file), "utf8");
          // Also score against page content for better matching
          const contentScore = scoreRelevance(content.slice(0, 200), tokens);
          results.push({ name: `${dir}/${name}`, score: score + contentScore, content });
        } catch {}
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function scoreRelevance(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((score, token) => {
    if (lower.includes(token.toLowerCase())) return score + 1;
    return score;
  }, 0);
}

function tokenize(text: string): string[] {
  // Extract meaningful tokens: camelCase, PascalCase, kebab-case, and words > 3 chars
  const words = text
    .replace(/([a-z])([A-Z])/g, "$1 $2") // split camelCase
    .split(/[\s\-_/\\.,;:!?'"()[\]{}]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3);

  // Also extract the original camelCase/PascalCase tokens
  const camelRe = /[A-Z][a-z]+[A-Za-z]*/g;
  const camelTokens = Array.from(text.matchAll(camelRe), (m) => m[0]);

  return [...new Set([...words, ...camelTokens])];
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildUserMessage(question: string, context_: WikiContext): string {
  return `## Question from developer

${question}

## Wiki context (use ONLY this to answer)

${context_.text}

## Instructions

Answer the question using ONLY the wiki context above. Cite pages as [[page-name]]. Be concise.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWikiLinks(text: string): string[] {
  const re = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m[1].trim());
  }
  return [...new Set(results)];
}

function resolveWikiPage(wikiRoot: string, name: string): string | null {
  // name may be "entities/foo" or just "foo"
  const candidates = [
    path.join(wikiRoot, `${name}.md`),
    path.join(wikiRoot, "entities", `${name}.md`),
    path.join(wikiRoot, "concepts", `${name}.md`),
    path.join(wikiRoot, "decisions", `${name}.md`),
  ];
  // Sync check — in production we'd want async but this is post-response
  for (const c of candidates) {
    try {
      require("fs").accessSync(c);
      return c;
    } catch {}
  }
  return null;
}

function buildLlmConfig(cfg: vscode.WorkspaceConfiguration): LlmConfig {
  const provider = cfg.get<"anthropic" | "openrouter">("apiProvider", "anthropic");
  return {
    provider,
    anthropicApiKey:
      cfg.get<string>("anthropicApiKey") || process.env.LEGION_ANTHROPIC_API_KEY || "",
    openRouterApiKey:
      cfg.get<string>("openRouterApiKey") || process.env.LEGION_OPENROUTER_API_KEY || "",
    model:
      provider === "openrouter"
        ? (cfg.get<string>("openRouterModel") || "anthropic/claude-sonnet-4-5")
        : (cfg.get<string>("model") || "claude-sonnet-4-5"),
    maxTokens: 4096,
  };
}
