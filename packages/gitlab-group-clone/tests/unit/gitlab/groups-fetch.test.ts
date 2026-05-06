import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGroup, listGroupProjects, listSubgroups } from "../../../src/gitlab/api.js";
import { fetchGroupTree } from "../../../src/gitlab/groups.js";
import type { GitLabApiGroup, GitLabApiProject } from "../../../src/types.js";

vi.mock("../../../src/gitlab/api.js", () => ({
  getGroup: vi.fn(),
  listGroupProjects: vi.fn(),
  listSubgroups: vi.fn(),
}));

function makeApiGroup(overrides: Partial<GitLabApiGroup> = {}): GitLabApiGroup {
  return {
    id: 1,
    name: "mycompany",
    path: "mycompany",
    full_path: "mycompany",
    description: "",
    visibility: "private",
    ...overrides,
  };
}

function makeApiProject(overrides: Partial<GitLabApiProject> = {}): GitLabApiProject {
  return {
    id: 1,
    name: "project-a",
    path: "project-a",
    path_with_namespace: "mycompany/project-a",
    http_url_to_repo: "https://gitlab.com/mycompany/project-a.git",
    ssh_url_to_repo: "git@gitlab.com:mycompany/project-a.git",
    visibility: "private",
    archived: false,
    namespace: {
      id: 1,
      name: "mycompany",
      path: "mycompany",
      full_path: "mycompany",
      kind: "group",
    },
    ...overrides,
  };
}

describe("fetchGroupTree", () => {
  const clientOptions = { gitlabUrl: "https://gitlab.com", token: "tok" };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a tree with the root group, projects, and subgroups", async () => {
    const rootGroup = makeApiGroup();
    const subGroup = makeApiGroup({ id: 2, path: "frontend", full_path: "mycompany/frontend" });
    const rootProject = makeApiProject({ id: 10 });
    const subProject = makeApiProject({
      id: 11,
      name: "ui-app",
      path: "ui-app",
      path_with_namespace: "mycompany/frontend/ui-app",
    });

    vi.mocked(getGroup).mockResolvedValueOnce(rootGroup);
    vi.mocked(listGroupProjects)
      .mockResolvedValueOnce([rootProject])
      .mockResolvedValueOnce([subProject]);
    vi.mocked(listSubgroups)
      .mockResolvedValueOnce([subGroup])
      .mockResolvedValueOnce([]);

    const tree = await fetchGroupTree(clientOptions, "mycompany");

    expect(tree.group.fullPath).toBe("mycompany");
    expect(tree.projects).toHaveLength(1);
    expect(tree.subgroups).toHaveLength(1);
    expect(tree.subgroups[0]!.group.path).toBe("frontend");
    expect(tree.subgroups[0]!.projects).toHaveLength(1);
    expect(tree.subgroups[0]!.projects[0]!.path).toBe("ui-app");
  });

  it("maps snake_case API fields to camelCase", async () => {
    vi.mocked(getGroup).mockResolvedValueOnce(makeApiGroup());
    vi.mocked(listGroupProjects).mockResolvedValueOnce([
      makeApiProject({ http_url_to_repo: "https://gitlab.com/mycompany/project-a.git" }),
    ]);
    vi.mocked(listSubgroups).mockResolvedValueOnce([]);

    const tree = await fetchGroupTree(clientOptions, "mycompany");

    expect(tree.projects[0]!.httpUrlToRepo).toBe("https://gitlab.com/mycompany/project-a.git");
    expect(tree.projects[0]!.pathWithNamespace).toBe("mycompany/project-a");
  });

  it("propagates API errors", async () => {
    vi.mocked(getGroup).mockRejectedValueOnce(new Error("GitLab group not found: \"missing\""));

    await expect(fetchGroupTree(clientOptions, "missing")).rejects.toThrow("not found");
  });

  it("handles a group with no projects and no subgroups", async () => {
    vi.mocked(getGroup).mockResolvedValueOnce(makeApiGroup());
    vi.mocked(listGroupProjects).mockResolvedValueOnce([]);
    vi.mocked(listSubgroups).mockResolvedValueOnce([]);

    const tree = await fetchGroupTree(clientOptions, "mycompany");
    expect(tree.projects).toHaveLength(0);
    expect(tree.subgroups).toHaveLength(0);
  });
});
