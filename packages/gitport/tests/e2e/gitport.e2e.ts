import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  buildPackage,
  cleanupFixture,
  createFixture,
  readBranchFile,
  runCli,
  startFakeGitLab,
} from "./helpers.js";
import type { FakeGitLab, Fixture } from "./helpers.js";

interface GitportJsonResult {
  readonly runId: string;
  readonly runDir: string;
  readonly mergeRequestUrl: string;
  readonly commits: readonly { readonly status: string; readonly title: string }[];
  readonly conflicts: readonly unknown[];
}

function buildEnv(fixture: Fixture, fakeGitLab: FakeGitLab, includeToken = true): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  return {
    ...env,
    HOME: fixture.homeDir,
    GITPORT_GITLAB_API_BASE: fakeGitLab.apiBase,
    GIT_COMMITTER_NAME: "Gitport Runner",
    GIT_COMMITTER_EMAIL: "gitport@example.com",
    ...(includeToken ? { GITPORT_GITLAB_TOKEN: "e2e-token" } : {}),
  };
}

test.describe("GitLab MR porting", () => {
  test.beforeAll(async () => {
    await buildPackage();
  });

  test("User can port a clean MR into a Draft MR", async () => {
    const fixture = await createFixture(false);
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "gitlab",
          "mr",
          "123",
          "--source-repo",
          fixture.sourceBare,
          "--dest-repo",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Draft MR created");
      expect(fakeGitLab.createdMergeRequests).toHaveLength(1);
      expect(fakeGitLab.createdMergeRequests[0]).toMatchObject({
        draft: true,
        source_branch: "gitport/repo-a-mr-123",
        target_branch: "main",
      });
      await expect(readBranchFile(fixture.destBare, "gitport/repo-a-mr-123", "feature.txt")).resolves.toBe(
        "ported feature\n",
      );
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });

  test("User can auto-resolve conflicts with incoming and review old code in the Draft MR", async () => {
    const fixture = await createFixture(true);
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "gitlab",
          "mr",
          "123",
          "--source-repo",
          fixture.sourceBare,
          "--dest-repo",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--keep-workdir",
          "--json",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as GitportJsonResult;
      expect(parsed.mergeRequestUrl).toContain("/merge_requests/7");
      expect(parsed.conflicts).toHaveLength(1);
      expect(await readBranchFile(fixture.destBare, "gitport/repo-a-mr-123", "app.txt")).toBe(
        "value=incoming\n",
      );
      const created = fakeGitLab.createdMergeRequests[0];
      expect(created?.description).toContain("old-destination");
      expect(created?.description).toContain("value=incoming");
      expect(created?.description).toContain("Auto-resolved conflicts");
      const report = await readFile(join(parsed.runDir, "report.md"), "utf8");
      expect(report).toContain("old-destination");
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });

  test("User can skip patches that already exist in the destination repo", async () => {
    const fixture = await createFixture({ duplicate: true });
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "gitlab",
          "mr",
          "123",
          "--source-repo",
          fixture.sourceBare,
          "--dest-repo",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--json",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as GitportJsonResult;
      expect(parsed.commits[0]?.status).toBe("skipped");
      expect(fakeGitLab.createdMergeRequests[0]?.description).toContain("skipped");
      await expect(readBranchFile(fixture.destBare, "gitport/repo-a-mr-123", "feature.txt")).resolves.toBe(
        "ported feature\n",
      );
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });

  test("User gets a helpful error when token is missing", async () => {
    const fixture = await createFixture(false);
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "gitlab",
          "mr",
          "123",
          "--source-repo",
          fixture.sourceBare,
          "--dest-repo",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
        ],
        buildEnv(fixture, fakeGitLab, false),
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("GitLab token is required");
      expect(fakeGitLab.createdMergeRequests).toHaveLength(0);
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });
});
