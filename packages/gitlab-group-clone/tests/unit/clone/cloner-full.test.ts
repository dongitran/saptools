import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloneGroupTree } from "../../../src/clone/cloner.js";
import { gitClone, gitPull, isGitRepo } from "../../../src/clone/git.js";
import type { CloneOptions, GitLabGroup, GitLabProject, GroupTree } from "../../../src/types.js";

vi.mock("../../../src/clone/git.js", () => ({
  isGitRepo: vi.fn(),
  gitClone: vi.fn(),
  gitPull: vi.fn(),
  buildHttpsCloneUrl: vi.fn(
    (_gitlabUrl: string, pathWithNamespace: string, token: string) =>
      `https://oauth2:${token}@gitlab.com/${pathWithNamespace}.git`,
  ),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

function makeGroup(overrides: Partial<GitLabGroup> = {}): GitLabGroup {
  return {
    id: 1,
    name: "mycompany",
    path: "mycompany",
    fullPath: "mycompany",
    description: "",
    visibility: "private",
    ...overrides,
  };
}

function makeProject(overrides: Partial<GitLabProject> = {}): GitLabProject {
  return {
    id: 1,
    name: "service-a",
    path: "service-a",
    pathWithNamespace: "mycompany/service-a",
    httpUrlToRepo: "https://gitlab.com/mycompany/service-a.git",
    sshUrlToRepo: "git@gitlab.com:mycompany/service-a.git",
    visibility: "private",
    archived: false,
    ...overrides,
  };
}

function makeTree(
  group: GitLabGroup,
  projects: GitLabProject[],
  subgroups: GroupTree[] = [],
): GroupTree {
  return { group, projects, subgroups };
}

function makeOptions(overrides: Partial<CloneOptions> = {}): CloneOptions {
  return {
    destination: "/workspace",
    gitlabUrl: "https://gitlab.com",
    token: "glpat-secret",
    concurrency: 2,
    protocol: "https",
    includeArchived: false,
    update: false,
    dryRun: false,
    ...overrides,
  };
}

describe("cloneGroupTree", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clones all projects and returns a summary", async () => {
    const tree = makeTree(makeGroup(), [makeProject({ id: 1 }), makeProject({ id: 2, path: "svc-b", pathWithNamespace: "mycompany/svc-b" })]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    const summary = await cloneGroupTree(tree, makeOptions());

    expect(summary.total).toBe(2);
    expect(summary.cloned).toBe(2);
    expect(summary.failed).toBe(0);
    expect(gitClone).toHaveBeenCalledTimes(2);
  });

  it("skips existing repos when update is false", async () => {
    const tree = makeTree(makeGroup(), [makeProject()]);

    vi.mocked(isGitRepo).mockReturnValue(true);

    const summary = await cloneGroupTree(tree, makeOptions({ update: false }));

    expect(summary.skipped).toBe(1);
    expect(summary.cloned).toBe(0);
    expect(gitClone).not.toHaveBeenCalled();
  });

  it("pulls existing repos when update is true", async () => {
    const tree = makeTree(makeGroup(), [makeProject()]);

    vi.mocked(isGitRepo).mockReturnValue(true);
    vi.mocked(gitPull).mockResolvedValue({ success: true });

    const summary = await cloneGroupTree(tree, makeOptions({ update: true }));

    expect(summary.updated).toBe(1);
    expect(gitPull).toHaveBeenCalledTimes(1);
  });

  it("reports failed clones", async () => {
    const tree = makeTree(makeGroup(), [makeProject()]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: false, error: "clone failed" });

    const summary = await cloneGroupTree(tree, makeOptions());

    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.status).toBe("failed");
    expect(summary.results[0]!.error).toBe("clone failed");
  });

  it("reports failed pulls", async () => {
    const tree = makeTree(makeGroup(), [makeProject()]);

    vi.mocked(isGitRepo).mockReturnValue(true);
    vi.mocked(gitPull).mockResolvedValue({ success: false, error: "merge conflict" });

    const summary = await cloneGroupTree(tree, makeOptions({ update: true }));

    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.error).toBe("merge conflict");
  });

  it("marks all repos as skipped in dry-run mode", async () => {
    const tree = makeTree(makeGroup(), [makeProject({ id: 1 }), makeProject({ id: 2, path: "p2", pathWithNamespace: "mycompany/p2" })]);

    const summary = await cloneGroupTree(tree, makeOptions({ dryRun: true }));

    expect(summary.skipped).toBe(2);
    expect(summary.cloned).toBe(0);
    expect(gitClone).not.toHaveBeenCalled();
    expect(isGitRepo).not.toHaveBeenCalled();
  });

  it("clones projects in nested subgroups with correct paths", async () => {
    const subGroup = makeGroup({ id: 2, path: "backend", fullPath: "mycompany/backend" });
    const subProject = makeProject({
      id: 10,
      name: "api",
      path: "api",
      pathWithNamespace: "mycompany/backend/api",
    });
    const sub = makeTree(subGroup, [subProject]);
    const tree = makeTree(makeGroup(), [], [sub]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    const summary = await cloneGroupTree(tree, makeOptions());

    expect(summary.cloned).toBe(1);
    const result = summary.results[0]!;
    expect(result.localPath).toBe("/workspace/backend/api");
  });

  it("excludes archived repos by default", async () => {
    const tree = makeTree(makeGroup(), [
      makeProject({ id: 1, archived: false }),
      makeProject({ id: 2, path: "old", pathWithNamespace: "mycompany/old", archived: true }),
    ]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    const summary = await cloneGroupTree(tree, makeOptions({ includeArchived: false }));
    expect(summary.total).toBe(1);
  });

  it("includes archived repos when includeArchived is true", async () => {
    const tree = makeTree(makeGroup(), [
      makeProject({ id: 1, archived: false }),
      makeProject({ id: 2, path: "old", pathWithNamespace: "mycompany/old", archived: true }),
    ]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    const summary = await cloneGroupTree(tree, makeOptions({ includeArchived: true }));
    expect(summary.total).toBe(2);
  });

  it("calls onProgress for each completed project", async () => {
    const tree = makeTree(makeGroup(), [
      makeProject({ id: 1 }),
      makeProject({ id: 2, path: "p2", pathWithNamespace: "mycompany/p2" }),
    ]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    const progress: { done: number; total: number }[] = [];

    await cloneGroupTree(tree, makeOptions({ concurrency: 1 }), (_result, done, total) => {
      progress.push({ done, total });
    });

    expect(progress).toHaveLength(2);
    expect(progress[1]!.done).toBe(2);
    expect(progress[0]!.total).toBe(2);
  });

  it("uses SSH URL when protocol is ssh", async () => {
    const tree = makeTree(makeGroup(), [
      makeProject({ sshUrlToRepo: "git@gitlab.com:mycompany/service-a.git" }),
    ]);

    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(gitClone).mockResolvedValue({ success: true });

    await cloneGroupTree(tree, makeOptions({ protocol: "ssh" }));

    const [cloneArgs] = vi.mocked(gitClone).mock.calls;
    expect(cloneArgs![0].url).toBe("git@gitlab.com:mycompany/service-a.git");
  });
});
