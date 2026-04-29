import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readLatestRunMetadata, writeRunMetadata } from "../../src/metadata.js";

describe("run metadata", () => {
  it("writes latest run metadata without tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-meta-"));
    try {
      await writeRunMetadata({
        workRoot: root,
        metadata: {
          runId: "run-1",
          runDir: join(root, "runs", "run-1"),
          destDir: join(root, "runs", "run-1", "dest"),
          status: "completed",
          sourceRepo: "https://gitlab.example.com/repo-a.git",
          destRepo: "https://gitlab.example.com/repo-b.git",
          sourceMergeRequestIid: 123,
          baseBranch: "main",
          portBranch: "gitport/repo-a-mr-123",
          remainingCommits: [],
        },
      });

      const latest = await readLatestRunMetadata({ workRoot: root });
      expect(latest?.runId).toBe("run-1");
      const raw = await readFile(join(root, "runs", "run-1", "metadata.json"), "utf8");
      expect(raw).not.toContain("token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips optional merge request fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-meta-mr-"));
    try {
      await writeRunMetadata({
        workRoot: root,
        metadata: {
          runId: "run-1",
          runDir: join(root, "runs", "run-1"),
          destDir: join(root, "runs", "run-1", "dest"),
          status: "completed",
          sourceRepo: "source",
          destRepo: "dest",
          sourceMergeRequestIid: 123,
          baseBranch: "main",
          portBranch: "port",
          remainingCommits: [],
          mergeRequestUrl: "https://gitlab.example.com/mr/1",
          mergeRequestIid: 1,
        },
      });

      await expect(readLatestRunMetadata({ workRoot: root })).resolves.toMatchObject({
        mergeRequestUrl: "https://gitlab.example.com/mr/1",
        mergeRequestIid: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when no latest run exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-meta-missing-"));
    try {
      await expect(readLatestRunMetadata({ workRoot: root })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid latest run pointers", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-meta-invalid-"));
    try {
      await writeFile(join(root, "latest-run.json"), "{}\n", "utf8");
      await expect(readLatestRunMetadata({ workRoot: root })).rejects.toThrow(/pointer/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
