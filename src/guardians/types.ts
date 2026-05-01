// ── Guardian package format ────────────────────────────────────────────────────

/** Manifest file (`guardian.json`) for a community guardian package. */
export interface GuardianManifest {
  /** npm-package-name style: lowercase-kebab, no spaces. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** ≤ 120-character description. */
  description: string;
  /** Semver version string. */
  version: string;
  /** Minimum Legion extension version required. */
  minLegionVersion: string;
  /** Relative path to the agent file within the package (typically "agent.md"). */
  agentFile: string;
  /** Relative paths to skill files within the package (under skills/). */
  skillFiles: string[];
  /** Author display name or GitHub handle. */
  author: string;
  /** GitHub repo URL. */
  homepage: string;
  /** Searchable tags. */
  tags: string[];
  /** SPDX license identifier. */
  license: string;
  /** If true, the guardian is excluded from auto-update checks. */
  pinned?: boolean;
}

// ── Registry format ────────────────────────────────────────────────────────────

/** Registry index file served at `legion.guardianRegistryUrl`. */
export interface GuardianRegistry {
  /** Registry schema version (currently 1). */
  version: number;
  /** ISO-8601 timestamp of last registry update. */
  updatedAt: string;
  guardians: RegistryEntry[];
}

/** Single entry in the registry index. */
export interface RegistryEntry {
  name: string;
  /** GitHub "owner/repo" string, e.g. "janedeveloper/legion-nextjs-guardian". */
  repo: string;
  latestVersion: string;
  description: string;
  author: string;
  tags: string[];
  homepage: string;
}

// ── Installed guardian ─────────────────────────────────────────────────────────

/** A community guardian that is installed in `.legion-shared/community-guardians/<name>/`. */
export interface InstalledGuardian {
  manifest: GuardianManifest;
  /** Absolute path to the guardian's directory. */
  dir: string;
}
