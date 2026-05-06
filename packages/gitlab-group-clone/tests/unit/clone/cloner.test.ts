import { describe, expect, it } from "vitest";

import { buildCloneUrl, resolveLocalPath } from "../../../src/clone/cloner.js";
import type { CloneOptions, GitLabGroup, GitLabProject } from "../../../src/types.js";

function makeProject(overrides: Partial<GitLabProject> = {}): GitLabProject {
  return {
    id: 1,
    name: "my-service",
    path: "my-service",
    pathWithNamespace: "mycompany/backend/my-service",
    httpUrlToRepo: "https://gitlab.com/mycompany/backend/my-service.git",
    sshUrlToRepo: "git@gitlab.com:mycompany/backend/my-service.git",
    visibility: "private",
    archived: false,
    ...overrides,
  };
}

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

function makeCloneOptions(overrides: Partial<CloneOptions> = {}): CloneOptions {
  return {
    destination: "/tmp/clone-dest",
    gitlabUrl: "https://gitlab.com",
    token: "glpat-secret-token",
    concurrency: 5,
    protocol: "https",
    includeArchived: false,
    update: false,
    dryRun: false,
    ...overrides,
  };
}

describe("resolveLocalPath", () => {
  it("strips the root group prefix to produce the relative path", () => {
    const project = makeProject({ pathWithNamespace: "mycompany/backend/my-service" });
    const group = makeGroup({ fullPath: "mycompany" });

    const result = resolveLocalPath(project, group, "/tmp/dest");
    expect(result).toBe("/tmp/dest/backend/my-service");
  });

  it("handles a top-level project (no subgroup)", () => {
    const project = makeProject({ pathWithNamespace: "mycompany/root-project" });
    const group = makeGroup({ fullPath: "mycompany" });

    const result = resolveLocalPath(project, group, "/workspace");
    expect(result).toBe("/workspace/root-project");
  });

  it("handles deeply nested subgroups", () => {
    const project = makeProject({
      pathWithNamespace: "mycompany/tier1/tier2/tier3/deep-service",
    });
    const group = makeGroup({ fullPath: "mycompany" });

    const result = resolveLocalPath(project, group, "/clone");
    expect(result).toBe("/clone/tier1/tier2/tier3/deep-service");
  });

  it("uses the root group itself as the clone target when cloning a subgroup", () => {
    const project = makeProject({ pathWithNamespace: "mycompany/backend/my-service" });
    const group = makeGroup({ fullPath: "mycompany/backend" });

    const result = resolveLocalPath(project, group, "/workspace/backend");
    expect(result).toBe("/workspace/backend/my-service");
  });
});

describe("buildCloneUrl", () => {
  it("builds an HTTPS clone URL with the token embedded", () => {
    const project = makeProject({ pathWithNamespace: "mycompany/backend/my-service" });
    const options = makeCloneOptions({ protocol: "https", token: "glpat-secret" });

    const url = buildCloneUrl(project, options);
    expect(url).toBe("https://oauth2:glpat-secret@gitlab.com/mycompany/backend/my-service.git");
  });

  it("returns the SSH URL when protocol is ssh", () => {
    const project = makeProject({
      sshUrlToRepo: "git@gitlab.com:mycompany/backend/my-service.git",
    });
    const options = makeCloneOptions({ protocol: "ssh" });

    const url = buildCloneUrl(project, options);
    expect(url).toBe("git@gitlab.com:mycompany/backend/my-service.git");
  });

  it("uses the correct host for self-hosted instances", () => {
    const project = makeProject({ pathWithNamespace: "org/project" });
    const options = makeCloneOptions({
      protocol: "https",
      gitlabUrl: "https://gitlab.example.com",
      token: "mytoken",
    });

    const url = buildCloneUrl(project, options);
    expect(url).toBe("https://oauth2:mytoken@gitlab.example.com/org/project.git");
  });

  it("does not expose token when using SSH protocol", () => {
    const project = makeProject({ sshUrlToRepo: "git@gitlab.com:org/project.git" });
    const options = makeCloneOptions({ protocol: "ssh", token: "super-secret" });

    const url = buildCloneUrl(project, options);
    expect(url).not.toContain("super-secret");
  });
});
