import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as https from "https";
import type {
  GuardianManifest,
  GuardianRegistry,
  InstalledGuardian,
  RegistryEntry,
} from "./types";

// ── Cache keys ────────────────────────────────────────────────────────────────

const REGISTRY_CACHE_KEY = "legion.guardianRegistryCache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedRegistry {
  data: GuardianRegistry;
  etag: string;
  fetchedAt: number;
}

// ── Manager class ─────────────────────────────────────────────────────────────

export class CommunityGuardianManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly legionSharedRoot: string
  ) {}

  // ── Registry fetch ──────────────────────────────────────────────────────────

  /**
   * Fetch the community guardian registry JSON.
   * Uses ETag-based HTTP caching; returns cached data within the TTL.
   */
  async fetchRegistry(): Promise<GuardianRegistry> {
    const cfg = vscode.workspace.getConfiguration("legion");
    const url = cfg.get<string>(
      "guardianRegistryUrl",
      "https://raw.githubusercontent.com/legion-project/legion-guardian-registry/main/registry.json"
    );

    const cached = this.context.globalState.get<CachedRegistry>(REGISTRY_CACHE_KEY);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const extraHeaders: Record<string, string> = {};
    if (cached?.etag) extraHeaders["If-None-Match"] = cached.etag;

    const { statusCode, body, etag } = await httpsGet(url, extraHeaders);

    if (statusCode === 304 && cached) {
      await this.context.globalState.update(REGISTRY_CACHE_KEY, { ...cached, fetchedAt: now });
      return cached.data;
    }

    if (statusCode !== 200) {
      if (cached) return cached.data; // serve stale on error
      throw new Error(`Registry fetch failed: HTTP ${statusCode}`);
    }

    const data = JSON.parse(body) as GuardianRegistry;
    await this.context.globalState.update(REGISTRY_CACHE_KEY, { data, etag: etag ?? "", fetchedAt: now });
    return data;
  }

  // ── Install ─────────────────────────────────────────────────────────────────

  /**
   * Download and install a community guardian from GitHub.
   * Writes to `.legion-shared/community-guardians/<name>/`.
   */
  async install(entry: RegistryEntry): Promise<GuardianManifest> {
    const baseUrl = `https://raw.githubusercontent.com/${entry.repo}/main`;

    // Fetch manifest
    const manifestResult = await httpsGet(`${baseUrl}/guardian.json`, {});
    if (manifestResult.statusCode !== 200) {
      throw new Error(`Failed to fetch guardian.json (HTTP ${manifestResult.statusCode})`);
    }
    const manifest = JSON.parse(manifestResult.body) as GuardianManifest;

    // ── Path-traversal guards ─────────────────────────────────────────────────
    // manifest.name must be a safe npm-package-name style identifier so it cannot
    // escape the community-guardians/ directory (e.g. "../../.cursor/rules/evil").
    assertSafeGuardianName(manifest.name);

    const communityRoot = path.join(this.legionSharedRoot, "community-guardians");
    const destDir = path.resolve(communityRoot, manifest.name);
    // Double-check after resolve (should be redundant after name validation, but
    // defence-in-depth requires the prefix check here too).
    assertWithinRoot(communityRoot, destDir, "guardian name");

    // agentFile must resolve inside destDir
    assertWithinRoot(destDir, path.resolve(destDir, manifest.agentFile), "agentFile");

    // Fetch agent.md
    const agentResult = await httpsGet(`${baseUrl}/${manifest.agentFile}`, {});
    if (agentResult.statusCode !== 200) {
      throw new Error(`Failed to fetch ${manifest.agentFile} (HTTP ${agentResult.statusCode})`);
    }
    const agentContent = agentResult.body;

    // Fetch skill files — each must also stay within destDir
    const skillContents: Record<string, string> = {};
    for (const skillFile of manifest.skillFiles ?? []) {
      assertWithinRoot(destDir, path.resolve(destDir, skillFile), `skillFile "${skillFile}"`);
      const skillResult = await httpsGet(`${baseUrl}/${skillFile}`, {});
      if (skillResult.statusCode !== 200) {
        throw new Error(`Failed to fetch skill file: ${skillFile} (HTTP ${skillResult.statusCode})`);
      }
      skillContents[skillFile] = skillResult.body;
    }

    // Write to disk
    await fs.mkdir(path.join(destDir, "skills"), { recursive: true });

    await fs.writeFile(path.join(destDir, "guardian.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(destDir, manifest.agentFile), agentContent);

    for (const [filePath, content] of Object.entries(skillContents)) {
      const dest = path.resolve(destDir, filePath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content);
    }

    return manifest;
  }

  // ── List installed ─────────────────────────────────────────────────────────

  /** Return all community guardians installed in `.legion-shared/community-guardians/`. */
  async listInstalled(): Promise<InstalledGuardian[]> {
    const dir = path.join(this.legionSharedRoot, "community-guardians");
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const guardians: InstalledGuardian[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const manifestPath = path.join(dir, entry.name, "guardian.json");
          const raw = await fs.readFile(manifestPath, "utf8");
          const manifest = JSON.parse(raw) as GuardianManifest;
          guardians.push({ manifest, dir: path.join(dir, entry.name) });
        } catch {
          // skip malformed guardian directories
        }
      }
      return guardians;
    } catch {
      return [];
    }
  }
}

// ── Path-traversal guard helpers ──────────────────────────────────────────────

/**
 * Validates that `name` is a safe npm-package-name style identifier:
 * lowercase letters, digits, hyphens, and underscores only, starting with
 * a letter or digit.  Rejects anything containing slashes, dots, or `..`.
 */
function assertSafeGuardianName(name: string): void {
  if (!/^[a-z0-9][a-z0-9\-_]{0,213}$/.test(name)) {
    throw new Error(
      `Guardian name "${name}" is invalid. Expected lowercase-kebab format (letters, digits, hyphens, underscores only).`
    );
  }
}

/**
 * Asserts that `resolved` (an absolute path that is already path.resolve()-d)
 * is a strict sub-path of `root` (also absolute).
 * Throws if `resolved` equals `root` (must be *inside*, not at root itself)
 * or if it escapes the root via traversal.
 */
function assertWithinRoot(root: string, resolved: string, label: string): void {
  const normalizedRoot = path.normalize(root);
  const normalizedResolved = path.normalize(resolved);
  if (
    normalizedResolved !== normalizedRoot &&
    !normalizedResolved.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(
      `Unsafe ${label}: path escapes the allowed directory ("${normalizedResolved}" is not inside "${normalizedRoot}")`
    );
  }
}

// ── HTTP helper (uses Node https — no node-fetch needed) ─────────────────────

interface HttpResult {
  statusCode: number;
  body: string;
  etag?: string;
}

function httpsGet(url: string, extraHeaders: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        "User-Agent": "legion-vscode/1.0",
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          etag: res.headers["etag"] as string | undefined,
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.end();
  });
}
