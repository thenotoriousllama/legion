import * as fs from "fs/promises";
import * as path from "path";
import { callLlm, type LlmConfig } from "./llmClient";
import { searchTopic, scrapeUrl, type SearchProviderConfig, type SearchResult } from "./searchProviders";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");

const RESEARCH_SYSTEM_PROMPT =
  "You are a knowledge research assistant for a software engineering wiki. " +
  "Extract structured, factual information and format it as JSON. " +
  "Be concise, accurate, and cite sources when they are provided. " +
  "Return ONLY the requested JSON object — no markdown fences, no preamble.";

export interface ResearchResult {
  pagesWritten: string[];
  rounds: number;
  topic: string;
  provider: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a 3-round autonomous research loop on the given topic.
 *
 * When a search provider is configured (Exa / Firecrawl / Context7):
 *   Round 1: Search → ground Anthropic synthesis in real web content
 *   Round 2: Deep-fetch top URLs (Firecrawl) or secondary search → gap-fill
 *   Round 3: Contradictions + open questions from the full corpus
 *
 * When provider is "model-only":
 *   All rounds use Anthropic's training knowledge (no web calls).
 */
export async function runResearchPass(
  repoRoot: string,
  topic: string,
  llmConfig: LlmConfig,
  maxRounds: number,
  searchConfig: SearchProviderConfig,
  onProgress: (msg: string) => void
): Promise<ResearchResult> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);
  const pagesWritten: string[] = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug = slugify(topic);
  const hasProvider = searchConfig.provider !== "model-only";
  const researchType = hasProvider ? "web-search" : "knowledge-synthesis";

  // ── Round 1: Search + synthesis ──────────────────────────────────────────
  const r1Label = hasProvider
    ? `Round 1/3: Searching "${topic}" via ${searchConfig.provider}…`
    : `Round 1/3: Synthesizing knowledge on "${topic}"…`;
  onProgress(r1Label);

  let r1SearchResults: SearchResult[] = [];
  if (hasProvider) {
    r1SearchResults = await searchTopic(topic, searchConfig).catch(() => []);
    onProgress(`Round 1/3: Got ${r1SearchResults.length} results — synthesizing…`);
  }

  const r1Prompt = buildRound1Prompt(topic, r1SearchResults);
  const r1Raw = await callLlm(llmConfig, RESEARCH_SYSTEM_PROMPT, r1Prompt);
  const r1 = parseResearchOutput(r1Raw);

  // Write source overview page (with citations if web search)
  const sourcePath = `sources/${slug}.md`;
  const sourceContent = buildSourcePage(
    topic, r1.overview, dateStr, researchType, r1SearchResults
  );
  await writePage(wikiRoot, sourcePath, sourceContent);
  pagesWritten.push(sourcePath);

  // Write concept pages (Round 1)
  for (const concept of r1.concepts.slice(0, 5)) {
    const cPath = `concepts/${slugify(concept.name)}.md`;
    const cContent = buildConceptPage(concept.name, concept.description, topic, dateStr);
    await writePage(wikiRoot, cPath, cContent);
    pagesWritten.push(cPath);
  }

  if (maxRounds < 2) {
    await finalizeResearch(wikiRoot, repoRoot, topic, pagesWritten, dateStr);
    return { pagesWritten, rounds: 1, topic, provider: searchConfig.provider };
  }

  // ── Round 2: Deep-dive / gap-filling ─────────────────────────────────────
  onProgress(`Round 2/3: Filling gaps in "${topic}"…`);

  let r2SearchResults: SearchResult[] = [];
  if (hasProvider && r1.gaps.length > 0) {
    // Search for the first identified gap
    const gapQuery = `${topic} ${r1.gaps[0]}`;
    r2SearchResults = await searchTopic(gapQuery, searchConfig).catch(() => []);

    // Firecrawl: deep-fetch the top URL from Round 1 for richer content
    if (searchConfig.provider === "firecrawl" && r1SearchResults[0]?.url) {
      const deepPage = await scrapeUrl(
        r1SearchResults[0].url,
        searchConfig.firecrawlApiKey ?? ""
      ).catch(() => null);
      if (deepPage) r2SearchResults.unshift(deepPage);
    }
  }

  const r2Prompt = buildRound2Prompt(topic, r1.overview, r1.gaps, r2SearchResults);
  const r2Raw = await callLlm(llmConfig, RESEARCH_SYSTEM_PROMPT, r2Prompt);
  const r2 = parseResearchOutput(r2Raw);

  for (const concept of r2.concepts.slice(0, 3)) {
    const cPath = `concepts/${slugify(concept.name)}.md`;
    const cContent = buildConceptPage(concept.name, concept.description, topic, dateStr);
    await writePage(wikiRoot, cPath, cContent);
    pagesWritten.push(cPath);
  }

  if (maxRounds < 3) {
    await finalizeResearch(wikiRoot, repoRoot, topic, pagesWritten, dateStr);
    return { pagesWritten, rounds: 2, topic, provider: searchConfig.provider };
  }

  // ── Round 3: Contradictions + questions ──────────────────────────────────
  onProgress(`Round 3/3: Surfacing contradictions and questions for "${topic}"…`);
  const r3Prompt = buildRound3Prompt(topic, r1.overview, r2.overview);
  const r3Raw = await callLlm(llmConfig, RESEARCH_SYSTEM_PROMPT, r3Prompt);
  const r3 = parseResearchOutput(r3Raw);

  for (const q of r3.questions.slice(0, 5)) {
    const qPath = `questions/${slugify(q)}.md`;
    const qContent = buildQuestionPage(q, topic, dateStr);
    await writePage(wikiRoot, qPath, qContent);
    pagesWritten.push(qPath);
  }

  await finalizeResearch(wikiRoot, repoRoot, topic, pagesWritten, dateStr);
  return { pagesWritten, rounds: 3, topic, provider: searchConfig.provider };
}

// ── Finalization ──────────────────────────────────────────────────────────────

async function finalizeResearch(
  wikiRoot: string,
  repoRoot: string,
  topic: string,
  pagesWritten: string[],
  dateStr: string
): Promise<void> {
  // Append to log.md
  const logPath = path.join(wikiRoot, "log.md");
  const logEntry = `\n## [${dateStr}] autoresearch | ${topic} | created: ${pagesWritten.length}\n`;
  try {
    await fs.appendFile(logPath, logEntry);
  } catch {
    // log.md may not exist yet
  }

  // Append to index.md
  const indexPath = path.join(wikiRoot, "index.md");
  try {
    let indexContent = await fs.readFile(indexPath, "utf8");
    const newLinks = pagesWritten
      .filter((p) => !indexContent.includes(p.replace(/\.md$/, "")))
      .map((p) => `- [[${p.replace(/\.md$/, "")}]]`);

    if (newLinks.length > 0) {
      const sourcesHeading = "## Sources";
      if (indexContent.includes(sourcesHeading)) {
        const lines = indexContent.split("\n");
        const hIdx = lines.findIndex((l) => l === sourcesHeading);
        lines.splice(hIdx + 1, 0, ...newLinks);
        indexContent = lines.join("\n");
      } else {
        indexContent = indexContent.trimEnd() + `\n\n${sourcesHeading}\n${newLinks.join("\n")}\n`;
      }
      await fs.writeFile(indexPath, indexContent);
    }
  } catch {
    // index.md missing
  }

  // Update hot.md
  const hotPath = path.join(wikiRoot, "hot.md");
  const hotUpdate = `\n## Recently researched\n\n- ${dateStr}: "${topic}" (${pagesWritten.length} pages filed)\n`;
  try {
    let hotContent = await fs.readFile(hotPath, "utf8");
    if (hotContent.includes("## Recently researched")) {
      hotContent = hotContent.replace(
        /## Recently researched[\s\S]*?(?=^## |\z)/m,
        hotUpdate.trimStart() + "\n"
      );
    } else {
      hotContent = hotContent.trimEnd() + "\n\n" + hotUpdate;
    }
    await fs.writeFile(hotPath, hotContent);
  } catch {
    // hot.md missing
  }

  // Refresh .cursor/rules/wiki-hot-context.md
  try {
    const hotContent = await fs.readFile(hotPath, "utf8");
    const rulesDir = path.join(repoRoot, ".cursor", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    const contextContent = [
      `---`,
      `description: Legion wiki hot cache — recently touched entities and modules.`,
      `globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]`,
      `alwaysApply: false`,
      `---`,
      ``,
      `<!-- Auto-generated by Legion. Do not edit. -->`,
      ``,
      hotContent.replace(/^---[\s\S]*?---\n/m, "").trim(),
    ].join("\n");
    await fs.writeFile(path.join(rulesDir, "wiki-hot-context.md"), contextContent);
  } catch {
    // ignore
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function formatSearchContext(results: SearchResult[]): string {
  if (results.length === 0) return "";
  const sections = results.map((r, i) =>
    `[Source ${i + 1}] ${r.title}\nURL: ${r.url}${r.publishedDate ? `\nDate: ${r.publishedDate}` : ""}\n\n${r.content.slice(0, 2000)}`
  );
  return `\n\n## Real web sources to use as primary evidence:\n\n${sections.join("\n\n---\n\n")}`;
}

function buildRound1Prompt(topic: string, searchResults: SearchResult[] = []): string {
  const hasWeb = searchResults.length > 0;
  const sourceInstruction = hasWeb
    ? `Base your response PRIMARILY on the web sources provided below. Cite sources by index [1], [2], etc.`
    : `Base your response on established knowledge. Be factual.`;
  const webContext = formatSearchContext(searchResults);

  return `You are a knowledge research assistant. Research the topic: "${topic}"

${sourceInstruction}${webContext}

Provide a structured JSON response with this exact shape:
{
  "overview": "2-3 paragraph overview of ${topic}${hasWeb ? " (cite sources as [1], [2], etc.)" : ""}",
  "concepts": [
    {"name": "ConceptName", "description": "1-2 sentence description"},
    ... (3-5 concepts)
  ],
  "entities": [
    {"name": "EntityName", "type": "one of: function|class|module|service|endpoint|data-model", "description": "brief description"},
    ... (0-3 entities, only if code-relevant)
  ],
  "gaps": ["gap1", "gap2", "gap3"],
  "questions": []
}

Return ONLY the JSON object.`;
}

function buildRound2Prompt(
  topic: string,
  r1Overview: string,
  gaps: string[],
  searchResults: SearchResult[] = []
): string {
  const hasWeb = searchResults.length > 0;
  const webContext = formatSearchContext(searchResults);

  return `You are a knowledge research assistant deepening research on: "${topic}"

Previous overview: ${r1Overview.slice(0, 400)}

Identified gaps to fill:
${gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")}${webContext}

Provide additional structured knowledge to address these gaps:
{
  "overview": "Summary of gap-filling findings${hasWeb ? " (cite sources as [1], [2], etc.)" : ""}",
  "concepts": [
    {"name": "ConceptName", "description": "1-2 sentence description addressing a gap"},
    ... (2-4 concepts)
  ],
  "entities": [],
  "gaps": [],
  "questions": []
}

Return ONLY the JSON object.`;
}

function buildRound3Prompt(topic: string, r1: string, r2: string): string {
  return `You are a knowledge quality reviewer. Review research on: "${topic}"

Round 1 summary: ${r1.slice(0, 300)}
Round 2 summary: ${r2.slice(0, 300)}

Identify contradictions and open questions:
{
  "overview": "Quality review summary",
  "concepts": [],
  "entities": [],
  "gaps": [],
  "questions": [
    "Open question 1?",
    "Open question 2?",
    ... (2-5 questions)
  ]
}

Return ONLY the JSON object.`;
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface RoundOutput {
  overview: string;
  concepts: Array<{ name: string; description: string }>;
  entities: Array<{ name: string; type: string; description: string }>;
  gaps: string[];
  questions: string[];
}

function parseResearchOutput(raw: string): RoundOutput {
  const empty: RoundOutput = { overview: "", concepts: [], entities: [], gaps: [], questions: [] };
  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json) as Partial<RoundOutput>;
    return {
      overview: parsed.overview ?? "",
      concepts: parsed.concepts ?? [],
      entities: parsed.entities ?? [],
      gaps: parsed.gaps ?? [],
      questions: parsed.questions ?? [],
    };
  } catch {
    return { ...empty, overview: raw.slice(0, 500) };
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  try { JSON.parse(trimmed); return trimmed; } catch {}
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

// ── Page builders ─────────────────────────────────────────────────────────────

function buildSourcePage(
  topic: string,
  overview: string,
  dateStr: string,
  researchType: string,
  searchResults: SearchResult[] = []
): string {
  const lines = [
    `---`,
    `type: source`,
    `title: "${topic}"`,
    `research_type: ${researchType}`,
    `researched_at: "${dateStr}"`,
    `created: "${dateStr}"`,
    `tags: [source, research]`,
    `---`,
    ``,
    `# ${topic}`,
    ``,
    overview || `_(Research synthesis for ${topic})_`,
    ``,
  ];

  if (searchResults.length > 0) {
    lines.push(`## Sources`, ``);
    searchResults.forEach((r, i) => {
      const dateNote = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
      lines.push(`${i + 1}. [${r.title}](${r.url})${dateNote}`);
    });
    lines.push(``);
  }

  return lines.join("\n");
}

function buildConceptPage(
  name: string,
  description: string,
  sourceTopic: string,
  dateStr: string
): string {
  return [
    `---`,
    `type: concept`,
    `title: "${name}"`,
    `created: "${dateStr}"`,
    `related: [[sources/${slugify(sourceTopic)}]]`,
    `tags: [concept, research]`,
    `---`,
    ``,
    `# ${name}`,
    ``,
    description || `_(Concept extracted from research on [[sources/${slugify(sourceTopic)}]])_`,
    ``,
  ].join("\n");
}

function buildQuestionPage(question: string, sourceTopic: string, dateStr: string): string {
  return [
    `---`,
    `type: question`,
    `title: "${question}"`,
    `created: "${dateStr}"`,
    `related: [[sources/${slugify(sourceTopic)}]]`,
    `tags: [question, research]`,
    `---`,
    ``,
    `# ${question}`,
    ``,
    `Open question surfaced during research on [[sources/${slugify(sourceTopic)}]].`,
    ``,
  ].join("\n");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function writePage(wikiRoot: string, relPath: string, content: string): Promise<void> {
  const absPath = path.join(wikiRoot, relPath.replace(/\//g, path.sep));
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  // Don't overwrite existing pages
  try {
    await fs.access(absPath);
    return; // already exists
  } catch {}
  await fs.writeFile(absPath, content);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

