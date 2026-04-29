import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunId, gitportWorkRoot, latestRunPath, runPaths } from "../../src/paths.js";

describe("paths", () => {
  it("creates stable timestamp-prefixed run IDs", () => {
    const id = createRunId(new Date("2026-04-29T10:30:00.000Z"));
    expect(id).toMatch(/^20260429103000-[a-f0-9-]{8}$/);
  });

  it("builds paths under an explicit work root", () => {
    const root = "/tmp/gitport";
    const paths = runPaths("run-1", root);
    expect(gitportWorkRoot(root)).toBe(root);
    expect(paths.runsDir).toBe(join(root, "runs"));
    expect(paths.destDir).toBe(join(root, "runs", "run-1", "dest"));
    expect(paths.latestRunPath).toBe(latestRunPath(root));
  });

  it("builds default work root under .saptools/gitport", () => {
    expect(gitportWorkRoot()).toContain(join(".saptools", "gitport"));
  });
});
