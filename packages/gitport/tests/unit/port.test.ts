import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { maskGitportError, portGitLabMergeRequest } from "../../src/port.js";

const execFileAsync = promisify(execFile);

interface PortFixture {
  readonly root: string;
  readonly workRoot: string;
  readonly sourceBare: string;
  readonly destBare: string;
  readonly commits: readonly string[];
}

interface PortFixtureOptions {
  readonly conflict?: boolean | undefined;
}

interface CreatedMergeRequestBody {
  readonly source_branch: string;
  readonly target_branch: string;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
  readonly assignee_ids: readonly number[];
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function gitNoCwd(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function configureGit(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.email", "author@example.com"]);
  await git(cwd, ["config", "user.name", "Source Author"]);
}

async function createFixture(options: PortFixtureOptions = {}): Promise<PortFixture> {
  const root = await mkdtemp(join(tmpdir(), "gitport-port-unit-"));
  const workRoot = join(root, "work");
  const seed = join(root, "seed");
  await gitNoCwd(["init", "-b", "main", seed]);
  await configureGit(seed);
  await writeFile(join(seed, "app.txt"), "value=base\n", "utf8");
  await git(seed, ["add", "app.txt"]);
  await git(seed, ["commit", "-m", "base"]);

  const sourceBare = join(root, "repo-a.git");
  const destBare = join(root, "repo-b.git");
  await gitNoCwd(["clone", "--bare", seed, sourceBare]);
  await gitNoCwd(["clone", "--bare", seed, destBare]);

  const sourceWork = join(root, "source-work");
  await gitNoCwd(["clone", sourceBare, sourceWork]);
  await configureGit(sourceWork);
  await git(sourceWork, ["checkout", "-b", "feature/gitport"]);
  if (options.conflict === true) {
    await writeFile(join(sourceWork, "app.txt"), "value=incoming\n", "utf8");
    await git(sourceWork, ["commit", "-am", "conflict source change"]);
  } else {
    await writeFile(join(sourceWork, "feature.txt"), "one\n", "utf8");
    await git(sourceWork, ["add", "feature.txt"]);
    await git(sourceWork, ["commit", "-m", "first source change"]);
    await writeFile(join(sourceWork, "feature.txt"), "one\ntwo\n", "utf8");
    await git(sourceWork, ["commit", "-am", "second source change"]);
  }
  await git(sourceWork, ["push", "origin", "feature/gitport"]);
  const commits = (await git(sourceWork, ["rev-list", "--reverse", "main..feature/gitport"]))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  const fixture = { root, workRoot, sourceBare, destBare, commits };
  if (options.conflict === true) {
    await createDestinationConflict(fixture);
  }
  return fixture;
}

async function createDestinationConflict(fixture: PortFixture): Promise<void> {
  const work = join(fixture.root, "dest-conflict-work");
  await gitNoCwd(["clone", fixture.destBare, work]);
  await configureGit(work);
  await writeFile(join(work, "app.txt"), "value=old-destination\n", "utf8");
  await git(work, ["commit", "-am", "destination customization"]);
  await git(work, ["push", "origin", "main"]);
}

async function createDuplicateDestination(fixture: PortFixture): Promise<void> {
  const work = join(fixture.root, "dest-duplicate-work");
  await gitNoCwd(["clone", fixture.destBare, work]);
  await configureGit(work);
  await writeFile(join(work, "feature.txt"), "one\n", "utf8");
  await git(work, ["add", "feature.txt"]);
  await git(work, ["commit", "-m", "duplicate first source change"]);
  await writeFile(join(work, "feature.txt"), "one\ntwo\n", "utf8");
  await git(work, ["commit", "-am", "duplicate second source change"]);
  await git(work, ["push", "origin", "main"]);
}

async function createDestinationBranch(fixture: PortFixture, branch: string): Promise<void> {
  const work = join(fixture.root, "dest-work");
  await gitNoCwd(["clone", fixture.destBare, work]);
  await configureGit(work);
  await git(work, ["checkout", "-b", branch]);
  await writeFile(join(work, "existing.txt"), "existing\n", "utf8");
  await git(work, ["add", "existing.txt"]);
  await git(work, ["commit", "-m", "existing port branch"]);
  await git(work, ["push", "origin", branch]);
}

async function readBranchFile(
  bareRepo: string,
  branch: string,
  path: string,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", bareRepo, "show", `${branch}:${path}`]);
  return stdout;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function fetchUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) {
    return new URL(input);
  }
  return new URL(input.url);
}

function createFakeFetch(
  fixture: PortFixture,
): { readonly fetchFn: typeof fetch; readonly createdBodies: readonly CreatedMergeRequestBody[] } {
  const createdBodies: CreatedMergeRequestBody[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = fetchUrl(input);
    if (url.pathname === "/api/v4/user") {
      return jsonResponse({ id: 42, username: "gitport-bot" });
    }
    if (url.pathname === "/api/v4/projects/repo-a/merge_requests/123") {
      return jsonResponse({
        iid: 123,
        title: "Source MR",
        source_branch: "feature/gitport",
        web_url: "http://gitlab.test/repo-a/-/merge_requests/123",
      });
    }
    if (url.pathname === "/api/v4/projects/repo-a/merge_requests/123/commits") {
      return jsonResponse(
        [...fixture.commits]
          .reverse()
          .map((sha, index) => ({
            id: sha,
            title: fixture.commits.length === 1
              ? "conflict source change"
              : index === 0 ? "second source change" : "first source change",
            message: "source change\n",
          })),
        { headers: { "x-next-page": "" } },
      );
    }
    if (url.pathname === "/api/v4/projects/repo-b/merge_requests") {
      if (typeof init?.body !== "string") {
        throw new Error("Expected GitLab create MR body");
      }
      createdBodies.push(JSON.parse(init.body) as CreatedMergeRequestBody);
      return jsonResponse({
        iid: 7,
        web_url: "http://gitlab.test/repo-b/-/merge_requests/7",
        draft: true,
      });
    }
    return jsonResponse({ message: `Unhandled ${url.pathname}` }, { status: 404 });
  };
  return { fetchFn, createdBodies };
}

describe("portGitLabMergeRequest", () => {
  it("ports GitLab MR commits in source-history order and writes token-free metadata", async () => {
    const fixture = await createFixture();
    const fakeGitLab = createFakeFetch(fixture);
    try {
      const result = await portGitLabMergeRequest({
        sourceRepo: fixture.sourceBare,
        destRepo: fixture.destBare,
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112 carry feature",
        token: "super-token",
        gitlabApiBase: "http://gitlab.test/api/v4",
        workRoot: fixture.workRoot,
        runId: "run-1",
        keepWorkdir: true,
        fetchFn: fakeGitLab.fetchFn,
      });

      expect(result.commits.map((commit) => commit.title)).toEqual([
        "first source change",
        "second source change",
      ]);
      await expect(
        readBranchFile(fixture.destBare, "gitport/repo-a-mr-123", "feature.txt"),
      ).resolves.toBe("one\ntwo\n");
      expect(fakeGitLab.createdBodies[0]).toMatchObject({
        source_branch: "gitport/repo-a-mr-123",
        target_branch: "main",
        title: "Draft: JIR-112 carry feature",
        draft: true,
        assignee_ids: [42],
      });
      const metadata = await readFile(join(result.runDir, "metadata.json"), "utf8");
      expect(metadata).not.toContain("super-token");
      expect(metadata).not.toContain("oauth2:");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("removes the run directory after success unless keepWorkdir is enabled", async () => {
    const fixture = await createFixture();
    const fakeGitLab = createFakeFetch(fixture);
    try {
      const result = await portGitLabMergeRequest({
        sourceRepo: fixture.sourceBare,
        destRepo: fixture.destBare,
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112 carry feature",
        token: "super-token",
        gitlabApiBase: "http://gitlab.test/api/v4",
        workRoot: fixture.workRoot,
        runId: "run-1",
        fetchFn: fakeGitLab.fetchFn,
      });

      await expect(readFile(join(result.runDir, "metadata.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips patch-equivalent commits that already exist in the destination", async () => {
    const fixture = await createFixture();
    const fakeGitLab = createFakeFetch(fixture);
    try {
      await createDuplicateDestination(fixture);

      const result = await portGitLabMergeRequest({
        sourceRepo: fixture.sourceBare,
        destRepo: fixture.destBare,
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112 skip duplicates",
        token: "super-token",
        gitlabApiBase: "http://gitlab.test/api/v4",
        workRoot: fixture.workRoot,
        runId: "run-1",
        fetchFn: fakeGitLab.fetchFn,
      });

      expect(result.commits.map((commit) => commit.status)).toEqual(["skipped", "skipped"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("auto-resolves cherry-pick conflicts with incoming and reports the old destination code", async () => {
    const fixture = await createFixture({ conflict: true });
    const fakeGitLab = createFakeFetch(fixture);
    try {
      const result = await portGitLabMergeRequest({
        sourceRepo: fixture.sourceBare,
        destRepo: fixture.destBare,
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112 resolve conflict",
        token: "super-token",
        gitlabApiBase: "http://gitlab.test/api/v4",
        workRoot: fixture.workRoot,
        runId: "run-1",
        keepWorkdir: true,
        fetchFn: fakeGitLab.fetchFn,
      });

      expect(result.commits[0]?.status).toBe("incoming-resolved");
      expect(result.conflicts[0]?.files[0]?.oursExcerpt).toContain("old-destination");
      await expect(
        readBranchFile(fixture.destBare, "gitport/repo-a-mr-123", "app.txt"),
      ).resolves.toBe("value=incoming\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects destination port branches that already exist", async () => {
    const fixture = await createFixture();
    const fakeGitLab = createFakeFetch(fixture);
    try {
      await createDestinationBranch(fixture, "gitport/repo-a-mr-123");

      await expect(
        portGitLabMergeRequest({
          sourceRepo: fixture.sourceBare,
          destRepo: fixture.destBare,
          sourceMergeRequestIid: 123,
          baseBranch: "main",
          portBranch: "gitport/repo-a-mr-123",
          title: "JIR-112 carry feature",
          token: "super-token",
          gitlabApiBase: "http://gitlab.test/api/v4",
          workRoot: fixture.workRoot,
          runId: "run-1",
          fetchFn: fakeGitLab.fetchFn,
        }),
      ).rejects.toThrow(/Port branch already exists in destination/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires a token before GitLab or Git operations run", async () => {
    await expect(
      portGitLabMergeRequest({
        sourceRepo: "/tmp/repo-a.git",
        destRepo: "/tmp/repo-b.git",
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112",
        env: { GITPORT_GITLAB_TOKEN: "" },
        gitlabApiBase: "http://gitlab.test/api/v4",
      }),
    ).rejects.toThrow(/GitLab token is required/);
  });

  it("requires an API base when it cannot be inferred from the source repo", async () => {
    await expect(
      portGitLabMergeRequest({
        sourceRepo: "/tmp/repo-a.git",
        destRepo: "/tmp/repo-b.git",
        sourceMergeRequestIid: 123,
        baseBranch: "main",
        portBranch: "gitport/repo-a-mr-123",
        title: "JIR-112",
        token: "super-token",
        env: { GITPORT_GITLAB_API_BASE: "" },
      }),
    ).rejects.toThrow(/GitLab API base cannot be inferred/);
  });

  it("masks non-Error failures with the same redaction path", () => {
    expect(maskGitportError("failed super-token", ["super-token"])).toBe("failed [REDACTED]");
  });
});
