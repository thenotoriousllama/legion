/**
 * Tests for src/util/gitRemote.ts
 *
 * NOTE: Stubs. Full coverage tracked in library/qa/2026-04-30-qa-report.md.
 */

import { parseGitHubRemote } from "./gitRemote";

describe("parseGitHubRemote", () => {
  it("parses HTTPS URL", () => {
    const result = parseGitHubRemote("https://github.com/acme/my-repo.git");
    expect(result).toEqual({ owner: "acme", repo: "my-repo" });
  });

  it("parses HTTPS URL without .git suffix", () => {
    const result = parseGitHubRemote("https://github.com/acme/my-repo");
    expect(result).toEqual({ owner: "acme", repo: "my-repo" });
  });

  it("parses SSH URL", () => {
    const result = parseGitHubRemote("git@github.com:acme/my-repo.git");
    expect(result).toEqual({ owner: "acme", repo: "my-repo" });
  });

  it("returns null for non-GitHub remote", () => {
    expect(parseGitHubRemote("https://gitlab.com/acme/my-repo.git")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubRemote("")).toBeNull();
  });
});
