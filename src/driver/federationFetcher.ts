import * as fs from "fs/promises";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import type { FederationManifest, FederationEntity } from "./federationPublisher";

const EXTERNAL_DIR = path.join("library", "knowledge-base", "wiki", "external");

/**
 * Fetch federation manifests from peer repos and write read-only stub pages
 * for each external entity into `library/knowledge-base/wiki/external/<repo>/`.
 *
 * Peers are configured via `legion.federation.peers` — an array of raw URLs
 * pointing to `federation-manifest.json` files (e.g. raw GitHub URLs).
 *
 * Called from reconcile() when `legion.federation.peers` is non-empty.
 */
export async function fetchFederationPeers(
  repoRoot: string,
  peerUrls: string[]
): Promise<void> {
  for (const url of peerUrls) {
    let manifest: FederationManifest;
    try {
      const raw = await fetchUrl(url);
      manifest = JSON.parse(raw) as FederationManifest;
    } catch (e) {
      console.warn(`Legion [federation]: Could not fetch ${url}: ${String(e)}`);
      continue;
    }

    const repoName = manifest.repo ?? sanitize(new URL(url).pathname.split("/")[1] ?? "peer");
    const externalDir = path.join(repoRoot, EXTERNAL_DIR, repoName);
    await fs.mkdir(externalDir, { recursive: true });

    // Write an _index.md for the external repo
    const indexContent = [
      `---`,
      `type: meta`,
      `title: "External: ${repoName}"`,
      `federation_source: "${url}"`,
      `fetched: "${manifest.generated}"`,
      `tags: [external, federation]`,
      `---`,
      ``,
      `# External — ${repoName}`,
      ``,
      `> Read-only stubs fetched from \`${url}\`.`,
      `> Do not edit — regenerated on every Document/Update pass.`,
      ``,
      `## Entities`,
      ``,
      ...manifest.entities.map((e) => `- [[external/${repoName}/${e.name}]] — \`${e.type}\``),
    ].join("\n");

    await fs.writeFile(path.join(externalDir, "_index.md"), indexContent);

    // Write one stub page per entity
    for (const entity of manifest.entities) {
      await writeEntityStub(externalDir, repoName, entity, url);
    }
  }
}

async function writeEntityStub(
  dir: string,
  repoName: string,
  entity: FederationEntity,
  sourceUrl: string
): Promise<void> {
  const stubPath = path.join(dir, `${entity.name}.md`);

  // Don't overwrite stubs that are newer than 1 hour (avoid hammering the network)
  try {
    const stat = await fs.stat(stubPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 60 * 60 * 1000) return;
  } catch {
    // doesn't exist yet — write it
  }

  const depends = entity.depends_on.length > 0
    ? entity.depends_on.map((d) => `[[external/${repoName}/${d}]]`).join(", ")
    : "";

  const content = [
    `---`,
    `type: entity`,
    `entity_type: ${entity.type}`,
    `status: ${entity.status}`,
    `path: ${entity.path}`,
    `federation_repo: ${repoName}`,
    `federation_source: "${sourceUrl}"`,
    ...(depends ? [`depends_on: ${depends}`] : []),
    `tags: [external, ${entity.type}]`,
    `---`,
    ``,
    `# ${entity.name}`,
    ``,
    `> **External entity** from \`${repoName}\`. This is a read-only federation stub.`,
    `> Source: \`${sourceUrl}\``,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Type | \`${entity.type}\` |`,
    `| Module | \`${entity.module}\` |`,
    `| Status | ${entity.status} |`,
    ...(entity.path ? [`| Source | \`${entity.path}\` |`] : []),
    ...(depends ? [`| Depends on | ${depends} |`] : []),
  ].join("\n");

  await fs.writeFile(stubPath, content);
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) {
          resolve(fetchUrl(res.headers.location));
          return;
        }
      }
      if ((res.statusCode ?? 0) >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
