import { describe, expect, it } from "vitest";

import { countProjects, flattenGroupTree } from "../../../src/gitlab/groups.js";
import type { GitLabGroup, GitLabProject, GroupTree } from "../../../src/types.js";

function makeGroup(overrides: Partial<GitLabGroup> = {}): GitLabGroup {
  return {
    id: 1,
    name: "test-group",
    path: "test-group",
    fullPath: "test-group",
    description: "",
    visibility: "private",
    ...overrides,
  };
}

function makeProject(overrides: Partial<GitLabProject> = {}): GitLabProject {
  return {
    id: 1,
    name: "project-a",
    path: "project-a",
    pathWithNamespace: "test-group/project-a",
    httpUrlToRepo: "https://gitlab.com/test-group/project-a.git",
    sshUrlToRepo: "git@gitlab.com:test-group/project-a.git",
    visibility: "private",
    archived: false,
    ...overrides,
  };
}

function makeTree(overrides: Partial<GroupTree> = {}): GroupTree {
  return {
    group: makeGroup(),
    projects: [],
    subgroups: [],
    ...overrides,
  };
}

describe("flattenGroupTree", () => {
  it("returns projects from a single group", () => {
    const tree = makeTree({
      projects: [makeProject({ id: 1 }), makeProject({ id: 2, path: "project-b" })],
    });

    const result = flattenGroupTree(tree, false);
    expect(result).toHaveLength(2);
  });

  it("returns projects from nested subgroups", () => {
    const subgroup = makeTree({
      group: makeGroup({ id: 2, path: "frontend", fullPath: "test-group/frontend" }),
      projects: [
        makeProject({
          id: 10,
          name: "ui",
          path: "ui",
          pathWithNamespace: "test-group/frontend/ui",
        }),
      ],
    });

    const tree = makeTree({
      projects: [makeProject({ id: 1 })],
      subgroups: [subgroup],
    });

    const result = flattenGroupTree(tree, false);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.path)).toContain("ui");
  });

  it("excludes archived projects when includeArchived is false", () => {
    const tree = makeTree({
      projects: [
        makeProject({ id: 1, archived: false }),
        makeProject({ id: 2, path: "old-project", archived: true }),
      ],
    });

    const result = flattenGroupTree(tree, false);
    expect(result).toHaveLength(1);
    expect(result[0]!.archived).toBe(false);
  });

  it("includes archived projects when includeArchived is true", () => {
    const tree = makeTree({
      projects: [
        makeProject({ id: 1, archived: false }),
        makeProject({ id: 2, path: "old-project", archived: true }),
      ],
    });

    const result = flattenGroupTree(tree, true);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for a group with no projects", () => {
    const tree = makeTree();
    expect(flattenGroupTree(tree, false)).toHaveLength(0);
  });

  it("traverses multiple levels of nesting", () => {
    const deepGroup = makeTree({
      group: makeGroup({ id: 3, fullPath: "root/mid/deep" }),
      projects: [
        makeProject({
          id: 100,
          name: "deep-project",
          path: "deep-project",
          pathWithNamespace: "root/mid/deep/deep-project",
        }),
      ],
    });

    const midGroup = makeTree({
      group: makeGroup({ id: 2, fullPath: "root/mid" }),
      projects: [],
      subgroups: [deepGroup],
    });

    const root = makeTree({
      group: makeGroup({ id: 1, fullPath: "root" }),
      projects: [makeProject({ id: 1 })],
      subgroups: [midGroup],
    });

    const result = flattenGroupTree(root, false);
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.name === "deep-project")).toBeDefined();
  });
});

describe("countProjects", () => {
  it("counts only non-archived projects by default", () => {
    const tree = makeTree({
      projects: [
        makeProject({ id: 1, archived: false }),
        makeProject({ id: 2, path: "archived", archived: true }),
      ],
    });

    expect(countProjects(tree, false)).toBe(1);
    expect(countProjects(tree, true)).toBe(2);
  });

  it("counts recursively across subgroups", () => {
    const sub = makeTree({
      group: makeGroup({ id: 2, fullPath: "root/sub" }),
      projects: [makeProject({ id: 10 }), makeProject({ id: 11, path: "p2" })],
    });

    const root = makeTree({
      group: makeGroup({ id: 1, fullPath: "root" }),
      projects: [makeProject({ id: 1 })],
      subgroups: [sub],
    });

    expect(countProjects(root, false)).toBe(3);
  });
});
