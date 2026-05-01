/**
 * Tests for src/context/claudeMdWriter.ts
 *
 * NOTE: Stubs. Full coverage tracked in library/qa/2026-04-30-qa-report.md.
 * Integration tests require a real temp directory with filesystem access.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { injectClaudeContext } from "./claudeMdWriter";

describe("injectClaudeContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "legion-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates CLAUDE.md when absent", async () => {
    await injectClaudeContext(tmpDir, 42);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf8");
    expect(content).toContain("## Legion Wiki");
    expect(content).toContain("Entities: 42");
  });

  it("appends to existing CLAUDE.md without fences", async () => {
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    await fs.writeFile(claudeMdPath, "# My Project\n\nExisting content.\n");
    await injectClaudeContext(tmpDir, 10);
    const content = await fs.readFile(claudeMdPath, "utf8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing content.");
    expect(content).toContain("## Legion Wiki");
  });

  it("surgically replaces existing Legion block", async () => {
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    await injectClaudeContext(tmpDir, 10);
    await injectClaudeContext(tmpDir, 20); // second pass
    const content = await fs.readFile(claudeMdPath, "utf8");
    // Should contain exactly one Legion block, not two
    const matches = content.match(/## Legion Wiki/g);
    expect(matches).toHaveLength(1);
    expect(content).toContain("Entities: 20");
  });
});
