# Feature #001: Semantic Search with Cohere Embeddings + TF-IDF Fallback

> **Legion VS Code Extension** — Feature PRD #001 of 6
>
> **Status:** Ready for implementation
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (file-based cache only)

---

## Phase Overview

### Goals

Legion's `legion.findEntity` command currently ranks wiki pages using fuzzy string matching against page titles. This works for exact or near-exact name recall but fails badly for semantic queries — a developer searching for "how we handle auth tokens" will not surface a page titled `JwtService` unless they already know the name. Semantic search solves this by encoding both pages and queries as dense vector embeddings and ranking by cosine similarity.

This PRD upgrades `legion.findEntity` to semantic search backed by Cohere's `embed-english-v3.0` model. When the API key is absent (offline environments, open-source users without a Cohere account), the command falls back gracefully to a pure-TypeScript TF-IDF implementation that requires zero external dependencies and zero configuration. The result is a dramatically more useful "find" experience in both connected and air-gapped environments.

The embedding cache is stored in `.legion/embeddings.json` — a flat JSON map from wiki page path to `{hash, vector}`. This file is git-ignored and rebuilt incrementally: after each Document or Update reconcile pass, only pages whose SHA-256 content hash changed since the last embed run are re-submitted to the Cohere API. At 500 wiki pages the brute-force cosine similarity scan takes under 1ms; a vector database (Qdrant, Pinecone) is unnecessary until the wiki exceeds roughly 10,000 pages.

### Scope

- New module `src/driver/semanticSearch.ts` with four exported functions: `embedText`, `cosineSimil`, `buildIndex`, `query`
- Embedding cache at `.legion/embeddings.json` — path/SHA-256/vector map, gitignored
- Cohere REST integration via existing `httpsPost` helper in `src/driver/agentInvoker.ts`
- TF-IDF fallback: pure-TypeScript, no npm dependencies; activates automatically when `legion.cohereApiKey` is not set
- Two new VS Code settings: `legion.cohereApiKey` and `legion.semanticSearchEnabled`
- `legion.findEntity` command upgraded to use `semanticSearch.query()` instead of fuzzy string match
- Cohere API key onboarding step added to the `createSharedConfig` wizard
- Incremental re-embedding after every Document / Update reconcile pass (only changed pages)

### Out of scope

- Vector database backends (Qdrant, Pinecone, Weaviate) — not needed below 10k pages; addressed in a future PRD
- Cross-repo or federated search — Legion federated search is a separate capability
- Semantic similarity threshold auto-tuning — topN is user-configurable, threshold is hardcoded at 0.25
- Caching Cohere responses server-side — the local `.legion/embeddings.json` file is the cache

### Dependencies

- **Blocks:** none
- **Blocked by:** none
- **External:** Cohere API key (`legion.cohereApiKey` setting or `LEGION_COHERE_API_KEY` env var). Free tier provides 1,000 API calls/month — adequate for a 500-page wiki with incremental updates.

---

## User Stories

### US-1.1 — Semantic keyword search

**As a** developer using Legion, **I want to** search wiki pages with natural language ("how auth tokens are validated"), **so that** I find the right entity even if I don't remember its exact name.

**Acceptance criteria:**
- AC-1.1.1 Given `legion.semanticSearchEnabled` is true and `legion.cohereApiKey` is set, when I run `legion.findEntity` and type a natural-language query, then the Quick Pick shows the top-N wiki pages ranked by cosine similarity, each with a score badge.
- AC-1.1.2 Given the same query, results with score ≥ 0.7 appear first; results below 0.25 are filtered out entirely.
- AC-1.1.3 Given the Cohere API returns an error (HTTP 4xx/5xx), when I run findEntity, then Legion shows an error notification and falls back to TF-IDF for that session.

### US-1.2 — Offline / no-API-key fallback

**As a** developer in an air-gapped environment, **I want to** use `legion.findEntity` without a Cohere API key, **so that** search still works without internet access.

**Acceptance criteria:**
- AC-1.2.1 Given `legion.cohereApiKey` is empty, when I run `legion.findEntity`, then Legion uses TF-IDF scoring without any network call.
- AC-1.2.2 Given TF-IDF is active, search results are returned in ≤ 200ms for a 500-page wiki on a 2019-era laptop.
- AC-1.2.3 Given `legion.semanticSearchEnabled` is false, when I run `legion.findEntity`, then the command uses the original fuzzy-string-match path regardless of whether an API key is present.

### US-1.3 — Incremental index refresh

**As a** developer whose wiki is continuously updated by Legion's Document / Update passes, **I want** the embedding index to stay current without re-embedding every page on each pass, **so that** Cohere API call volume stays within the free-tier limit.

**Acceptance criteria:**
- AC-1.3.1 After a Document pass that creates or updates N pages, only those N pages are re-embedded; unchanged pages reuse their cached vectors.
- AC-1.3.2 The `lastIndexed` timestamp in `.legion/embeddings.json` is updated after each successful batch embed.
- AC-1.3.3 If `.legion/embeddings.json` does not exist, `buildIndex` re-embeds all wiki pages and creates the file.

### US-1.4 — Cohere API key onboarding

**As a** new Legion user, **I want** the setup wizard to prompt me for a Cohere API key, **so that** I know semantic search is available and how to enable it.

**Acceptance criteria:**
- AC-1.4.1 When I run `legion.createSharedConfig`, the wizard includes a "Cohere API key (optional — enables semantic search)" step.
- AC-1.4.2 Skipping the step (pressing Escape or leaving it blank) sets `legion.cohereApiKey` to `""` and activates TF-IDF fallback.
- AC-1.4.3 After the wizard, if a key was entered, Legion triggers `buildIndex` in the background.

---

## Data Model Changes

None. The embedding cache is a plain JSON file at `.legion/embeddings.json`, not a database table.

**File format:**

```jsonc
{
  "version": 1,
  "lastIndexed": "2026-04-30T14:22:00Z",
  "pages": {
    "library/knowledge-base/wiki/functions/jwtService.md": {
      "hash": "sha256:a3f8...",
      "vector": [0.021, -0.087, 0.134, /* …1024 floats total */ ]
    }
  }
}
```

`hash` is the SHA-256 of the page file content at index time. The vector is 1,024-dimensional (Cohere `embed-english-v3.0` output dimension). The file is not committed to git (add `.legion/embeddings.json` to `.gitignore`).

---

## API / Endpoint Specs

### Cohere Embed REST API

**Endpoint:** `POST https://api.cohere.ai/v1/embed`

**Auth:** `Authorization: Bearer <cohereApiKey>`

**Request:**

```json
{
  "texts": ["JwtService validates bearer tokens against the secret key stored in…"],
  "model": "embed-english-v3.0",
  "input_type": "search_document"
}
```

For query embedding (at search time):

```json
{
  "texts": ["how auth tokens are validated"],
  "model": "embed-english-v3.0",
  "input_type": "search_query"
}
```

**Response `200`:**

```json
{
  "id": "abc123",
  "embeddings": [[0.021, -0.087, 0.134]],
  "meta": { "api_version": { "version": "1" } }
}
```

**Errors:**
- `401` — invalid or missing API key
- `429` — rate limit exceeded (free tier: 1,000 calls/month)
- `500` — Cohere server error

Legion treats any non-200 as a transient failure, logs the error, and falls back to TF-IDF for the current session.

---

## UI/UX Description

**`legion.findEntity` Quick Pick — updated behaviour:**

- Placeholder text changes from "Search entities…" to "Search wiki (semantic)…" when Cohere is active, or "Search wiki (TF-IDF)…" when in fallback mode.
- Each result item shows: `$(symbol-class) JwtService` (icon + name) in the label, `Functions · score 0.87` in the description.
- Items are sorted descending by score. Items below 0.25 are not shown.
- If the index is stale (> 24 h since last `buildIndex` and `cohereApiKey` is set), a status-bar item shows a warning icon "⚠ Semantic index stale — run Update". Clicking it runs `legion.update`.

**Settings UI:**

- `legion.cohereApiKey` appears in the Extensions settings view as "Cohere API Key" with a password-type input (VS Code renders `string` settings with `markdownDescription` containing sensitive notes as regular strings; the key is not stored in plaintext settings.json in production — recommend using VS Code secrets API or env var).
- `legion.semanticSearchEnabled` is a boolean checkbox, default `true`.

---

## Technical Considerations

### Embedding dimension and similarity

Cohere `embed-english-v3.0` outputs 1,024-dimensional float vectors. Cosine similarity between two vectors **a** and **b** is:

```
sim(a, b) = (a · b) / (‖a‖ · ‖b‖)
```

At 500 pages × 1,024 floats × 4 bytes = ~2 MB in memory. Brute-force scan of all 500 pages to rank a query takes ≈ 500 dot products at 1,024 dimensions = 512,000 multiplications — well under 1ms on any modern CPU. No HNSW index is needed.

### TF-IDF implementation

TF-IDF is computed at query time over the entire corpus loaded from disk. No persistent index file for TF-IDF — it is recomputed on each `findEntity` invocation (≤ 50ms for 500 pages of typical wiki content).

```
TF(t, d)  = count(t in d) / count(all tokens in d)
IDF(t, D) = log(|D| / (1 + |{d ∈ D : t ∈ d}|))
TF-IDF(t, d, D) = TF(t, d) × IDF(t, D)
```

The query is tokenized identically to documents (lowercase, strip punctuation, split on whitespace). Document vectors are the sum of their term TF-IDF weights. Similarity uses the same `cosineSimil` function as the Cohere path.

### Cohere API call batching

When `buildIndex` needs to embed many pages at once, it batches them into groups of 96 texts per API call (Cohere's per-request limit). With 500 pages this is 6 API calls total, consuming 6 of the 1,000 monthly free-tier budget.

### Security

The `cohereApiKey` value should not be stored in committed `settings.json`. Recommended storage hierarchy (checked in order):
1. `LEGION_COHERE_API_KEY` environment variable
2. VS Code's `context.secrets` API (`context.secrets.store('cohereApiKey', key)`)
3. `legion.cohereApiKey` workspace setting (acceptable for dev machines, discouraged for shared configs)

The wizard writes to workspace settings if the user provides a key interactively, with an inline warning to consider using an env var instead.

### Backwards compatibility

The original fuzzy-string-match path in `legionCli.ts` / the Find Entity QuickPick is preserved as the final fallback when `legion.semanticSearchEnabled` is false. No existing behaviour changes unless the user opts in.

---

## Files Touched

### New files

- `src/driver/semanticSearch.ts` — `embedText`, `cosineSimil`, `buildIndex`, `query` functions; TF-IDF implementation; cache read/write
- `src/driver/semanticSearch.test.ts` — unit tests for cosineSimil, TF-IDF, cache staleness logic

### Modified files

- `src/driver/agentInvoker.ts` — re-export `httpsPost` helper so `semanticSearch.ts` can import it, OR copy the helper inline (prefer re-export to avoid duplication)
- `src/commands/findEntity.ts` — replace fuzzy-match with `semanticSearch.query()`; add status-bar mode label
- `src/commands/createSharedConfig.ts` — add Cohere API key step to the wizard
- `src/commands/document.ts` — call `semanticSearch.buildIndex(repoRoot, createdPaths)` after reconcile pass
- `src/commands/update.ts` — call `semanticSearch.buildIndex(repoRoot, updatedPaths)` after reconcile pass
- `package.json` — add `legion.cohereApiKey` and `legion.semanticSearchEnabled` configuration contributions
- `.gitignore` — add `.legion/embeddings.json`
- `README.md` — document semantic search setup under "Configuration"

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — Core module and TF-IDF (no external API)

**Files:** `src/driver/semanticSearch.ts` (TF-IDF path only), `src/driver/semanticSearch.test.ts`

**Key code — `semanticSearch.ts` skeleton:**

```typescript
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SearchResult {
  pagePath: string;
  score: number;
  title: string;
  snippet: string;
}

interface EmbeddingCache {
  version: number;
  lastIndexed: string;
  pages: Record<string, { hash: string; vector: number[] }>;
}

export function cosineSimil(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function buildTfIdfVectors(corpus: Map<string, string[]>): Map<string, Map<string, number>> {
  const N = corpus.size;
  const df = new Map<string, number>();

  for (const tokens of corpus.values()) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const docVectors = new Map<string, Map<string, number>>();
  for (const [docId, tokens] of corpus) {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const tfScore = count / tokens.length;
      const idfScore = Math.log(N / (1 + (df.get(term) ?? 0)));
      vec.set(term, tfScore * idfScore);
    }
    docVectors.set(docId, vec);
  }
  return docVectors;
}

function sparseCosineSim(
  queryVec: Map<string, number>,
  docVec: Map<string, number>
): number {
  let dot = 0, normQ = 0, normD = 0;
  for (const [term, weight] of queryVec) {
    dot += weight * (docVec.get(term) ?? 0);
    normQ += weight * weight;
  }
  for (const w of docVec.values()) normD += w * w;
  const denom = Math.sqrt(normQ) * Math.sqrt(normD);
  return denom === 0 ? 0 : dot / denom;
}

export async function queryTfIdf(
  repoRoot: string,
  queryText: string,
  topN = 10
): Promise<SearchResult[]> {
  const wikiDir = path.join(repoRoot, 'library', 'knowledge-base', 'wiki');
  const pages = await collectWikiPages(wikiDir);

  const corpus = new Map<string, string[]>();
  for (const [p, content] of pages) corpus.set(p, tokenize(content));

  const docVectors = buildTfIdfVectors(corpus);
  const queryVec = buildTfIdfVectors(new Map([['__q__', tokenize(queryText)]])).get('__q__')!;

  const scores: { pagePath: string; score: number; content: string }[] = [];
  for (const [pagePath, docVec] of docVectors) {
    const score = sparseCosineSim(queryVec, docVec);
    if (score > 0.05) {
      scores.push({ pagePath, score, content: pages.get(pagePath) ?? '' });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topN).map(({ pagePath, score, content }) => ({
    pagePath,
    score,
    title: extractTitle(content),
    snippet: content.slice(0, 200).replace(/\n/g, ' '),
  }));
}
```

**Goal of Phase 1:** TF-IDF search works end-to-end, `findEntity` upgraded, existing fuzzy path preserved as `legion.semanticSearchEnabled = false` escape hatch.

### Phase 2 — Cohere embedding integration

**Files:** `src/driver/semanticSearch.ts` (Cohere path), cache read/write

**Key code — Cohere API call:**

```typescript
const COHERE_EMBED_URL = 'https://api.cohere.ai/v1/embed';
const COHERE_MODEL     = 'embed-english-v3.0';
const BATCH_SIZE       = 96; // Cohere per-request limit

export async function embedText(
  texts: string[],
  apiKey: string,
  inputType: 'search_document' | 'search_query' = 'search_document'
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({ texts: batch, model: COHERE_MODEL, input_type: inputType });
    const raw = await httpsPost(COHERE_EMBED_URL, body, {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    const parsed = JSON.parse(raw) as { embeddings: number[][] };
    results.push(...parsed.embeddings);
  }
  return results;
}

export async function buildIndex(
  repoRoot: string,
  changedPaths?: string[]  // undefined = full rebuild
): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) return; // TF-IDF mode: no index file needed

  const cachePath = path.join(repoRoot, '.legion', 'embeddings.json');
  let cache: EmbeddingCache = await loadCache(cachePath);

  const wikiDir = path.join(repoRoot, 'library', 'knowledge-base', 'wiki');
  const pages = await collectWikiPages(wikiDir);

  const toEmbed: string[] = [];
  const toEmbedPaths: string[] = [];

  for (const [pagePath, content] of pages) {
    if (changedPaths && !changedPaths.includes(pagePath)) continue;
    const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    if (cache.pages[pagePath]?.hash === hash) continue; // unchanged
    toEmbedPaths.push(pagePath);
    toEmbed.push(content.slice(0, 4096)); // truncate at 4k chars
  }

  if (toEmbed.length === 0) return;

  const vectors = await embedText(toEmbed, apiKey, 'search_document');
  for (let i = 0; i < toEmbedPaths.length; i++) {
    const content = pages.get(toEmbedPaths[i])!;
    const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    cache.pages[toEmbedPaths[i]] = { hash, vector: vectors[i] };
  }

  cache.lastIndexed = new Date().toISOString();
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}
```

**Goal of Phase 2:** Cohere path live; incremental caching works; API key resolved from env var or setting.

### Phase 3 — Settings, wizard, and onboarding

- Add `legion.cohereApiKey` and `legion.semanticSearchEnabled` to `package.json` `contributes.configuration`
- Update `createSharedConfig.ts` wizard with optional Cohere key step
- Background `buildIndex` after wizard completes
- Status-bar "stale index" warning logic
- Update `.gitignore` and `README.md`

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Semantic search p95 latency (Cohere path, hot cache) | ≤ 50ms | Instrument `query()` with `Date.now()` timers in dev mode |
| Semantic search p95 latency (TF-IDF, 500 pages) | ≤ 200ms | Same |
| Cohere API calls per Document pass (500-page wiki, 10 pages changed) | ≤ 10 | Log batch call count to Legion output channel |
| findEntity result relevance (manual spot-check, 20 queries) | Top result correct in ≥ 15/20 queries | Manual QA pass before ship |
| Zero regressions in existing `legion.findEntity` behaviour when `semanticSearchEnabled = false` | All existing tests pass | CI |

---

## Open Questions

- **Q1:** Should `cohereApiKey` be stored in VS Code's `context.secrets` API to prevent it appearing in plaintext `settings.json`? The secrets API is more secure but harder to share across machines. **Blocks:** Phase 3 implementation. **Current plan:** store in workspace settings with a warning; migrate to secrets API in a follow-up.
- **Q2:** What similarity threshold (currently 0.25) is optimal for filtering low-relevance results? **Blocks:** product decision. **Plan:** ship at 0.25, expose as `legion.semanticSearchThreshold` setting in a follow-up based on user feedback.
- **Q3:** Should the TF-IDF index be persisted to disk (like the Cohere cache) for a warm startup? **Current plan:** recompute on each invocation (≤ 50ms), ship without persistence, revisit if startup cost is noticeable on very large wikis.

---

## Risks and Open Questions

- **Risk:** Cohere free tier (1,000 calls/month) is exhausted on a wiki > 1,000 pages with frequent Document passes. **Mitigation:** incremental indexing (only changed pages), batch size of 96 (6 calls per 500-page full rebuild), and a warning log when monthly limit is approached. Users with large wikis should upgrade to Cohere's paid tier.
- **Risk:** `embeddings.json` grows large on huge wikis (500 pages × 1,024 floats × 8 bytes ≈ 4 MB). **Mitigation:** acceptable for a developer's local disk; not committed to git. If the file exceeds 10 MB, add a compression step (gzip) in a follow-up.
- **Risk:** Cohere API latency (cold start > 500ms) makes interactive search feel slow. **Mitigation:** query embedding is 1 API call returning 1 vector; the expensive batch embedding happens asynchronously in the background after Document/Update passes, not on the search path.

---

## Related

- [`feature-002-mcp-server/prd-feature-002-mcp-server.md`](../feature-002-mcp-server/prd-feature-002-mcp-server.md) — MCP `legion_find_entity` tool uses this module's `query()` function
- [`feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md`](../feature-005-multi-workspace-monorepo/prd-feature-005-multi-workspace-monorepo.md) — `repoRoot` resolution affects where `buildIndex` writes the cache
