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

function buildBaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  return env;
}

function buildEnv(fixture: Fixture, fakeGitLab: FakeGitLab, includeToken = true): NodeJS.ProcessEnv {
  return {
    ...buildBaseEnv(),
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
          "--source-mr-url",
          `${fixture.sourceMergeRequestRef}/diffs`,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--title",
          "JIR-112 carry feature",
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
        title: "Draft: JIR-112 carry feature",
        assignee_ids: [42],
      });
      expect(fakeGitLab.createdMergeRequests[0]?.description).toContain(
        "Source MR: !123 Source MR ([MR Link](http://127.0.0.1/repo-a/-/merge_requests/123))",
      );
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("Draft MR created by Gitport");
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("Source repo");
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("Destination repo");
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("Base branch");
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("Ported commits");
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
          "--source-mr-url",
          fixture.sourceMergeRequestRef,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--keep-workdir",
          "--json",
          "--title",
          "JIR-112 resolve conflict",
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
      expect(created?.description).not.toContain("Review this Draft MR before marking it ready");
      const report = await readFile(join(parsed.runDir, "report.md"), "utf8");
      expect(report).toContain("old-destination");
      expect(report).not.toContain("Ported commits");
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
          "--source-mr-url",
          fixture.sourceMergeRequestRef,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--json",
          "--title",
          "JIR-112 skip duplicates",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as GitportJsonResult;
      expect(parsed.commits[0]?.status).toBe("skipped");
      expect(fakeGitLab.createdMergeRequests[0]?.description).not.toContain("skipped");
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
          "--source-mr-url",
          fixture.sourceMergeRequestRef,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--title",
          "JIR-112 missing token",
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

  test("User gets a helpful error when source MR URL is missing", async () => {
    const result = await runCli(
      [
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("required option '--source-mr-url <url>'");
  });

  test("User gets a helpful error when destination repo URL is missing", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("required option '--destination-repo-url <url>'");
  });

  test("User gets a helpful error when source MR URL is not a merge request URL", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Source repo must be a GitLab merge request URL");
  });

  test("User gets a helpful error when port branch is missing", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("required option '--port-branch <name>'");
  });

  test("User gets a helpful error when title is missing", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("required option '--title <title>'");
  });

  test("User gets a helpful error when the port branch name is invalid", async () => {
    const fixture = await createFixture(false);
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "--source-mr-url",
          fixture.sourceMergeRequestRef,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "-bad",
          "--title",
          "JIR-112 invalid branch",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Port branch is not a valid branch name");
      expect(fakeGitLab.createdMergeRequests).toHaveLength(0);
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });

  test("User gets a helpful error when the destination port branch already exists", async () => {
    const fixture = await createFixture({ existingPortBranch: "gitport/repo-a-mr-123" });
    const fakeGitLab = await startFakeGitLab(fixture);
    try {
      const result = await runCli(
        [
          "--source-mr-url",
          fixture.sourceMergeRequestRef,
          "--destination-repo-url",
          fixture.destBare,
          "--base-branch",
          "main",
          "--port-branch",
          "gitport/repo-a-mr-123",
          "--title",
          "JIR-112 existing branch",
        ],
        buildEnv(fixture, fakeGitLab),
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Port branch already exists in destination");
      expect(fakeGitLab.createdMergeRequests).toHaveLength(0);
    } finally {
      await fakeGitLab.stop();
      await cleanupFixture(fixture);
    }
  });

  test("User cannot use the removed yes flag", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
        "--yes",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--yes'");
  });

  test("User cannot pass repo credentials in the source MR URL", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "https://oauth2:secret@gitlab.example.com/repo-a/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("must not include embedded credentials");
    expect(result.stderr).not.toContain("secret");
  });

  test("User cannot use the removed source MR flag", async () => {
    const result = await runCli(
      [
        "--source-mr",
        "123",
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--source-mr'");
  });

  test("User cannot use the old source repo flag", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--source-repo",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--source-repo'");
  });

  test("User cannot use the old destination repo flag", async () => {
    const result = await runCli(
      [
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--dest-repo",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--dest-repo'");
  });

  test("User cannot use the old nested GitLab MR command", async () => {
    const result = await runCli(
      [
        "gitlab",
        "mr",
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("too many arguments");
  });

  test("User cannot use the removed continue command", async () => {
    const result = await runCli(
      [
        "continue",
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("too many arguments");
  });

  test("User cannot use the removed abort command", async () => {
    const result = await runCli(
      [
        "abort",
        "--source-mr-url",
        "/tmp/repo-a.git/-/merge_requests/123",
        "--destination-repo-url",
        "/tmp/repo-b.git",
        "--base-branch",
        "main",
        "--port-branch",
        "gitport/repo-a-mr-123",
        "--title",
        "JIR-112",
      ],
      buildBaseEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("too many arguments");
  });
});
