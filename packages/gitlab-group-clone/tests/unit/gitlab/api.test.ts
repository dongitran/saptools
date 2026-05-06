import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getGroup, listGroupProjects, listSubgroups } from "../../../src/gitlab/api.js";
import type { GitLabApiGroup, GitLabApiProject } from "../../../src/types.js";

function makeApiGroup(overrides: Partial<GitLabApiGroup> = {}): GitLabApiGroup {
  return {
    id: 1,
    name: "test-group",
    path: "test-group",
    full_path: "test-group",
    description: "",
    visibility: "private",
    ...overrides,
  };
}

function makeApiProject(overrides: Partial<GitLabApiProject> = {}): GitLabApiProject {
  return {
    id: 1,
    name: "my-project",
    path: "my-project",
    path_with_namespace: "test-group/my-project",
    http_url_to_repo: "https://gitlab.com/test-group/my-project.git",
    ssh_url_to_repo: "git@gitlab.com:test-group/my-project.git",
    visibility: "private",
    archived: false,
    namespace: {
      id: 1,
      name: "test-group",
      path: "test-group",
      full_path: "test-group",
      kind: "group",
    },
    ...overrides,
  };
}

function mockResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string; nextPage?: string } = {},
): Response {
  const { ok = true, status = 200, statusText = "OK", nextPage = "" } = opts;
  const headers = new Headers({ "x-next-page": nextPage });
  return {
    ok,
    status,
    statusText,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("getGroup", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns group data on success", async () => {
    const apiGroup = makeApiGroup();
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(apiGroup));

    const result = await getGroup({ gitlabUrl: "https://gitlab.com", token: "tok" }, "test-group");
    expect(result.id).toBe(1);
    expect(result.full_path).toBe("test-group");
  });

  it("includes Bearer token in the request", async () => {
    const apiGroup = makeApiGroup();
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(apiGroup));

    await getGroup({ gitlabUrl: "https://gitlab.com", token: "my-token" }, "test-group");

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });

  it("URL-encodes group paths that contain slashes", async () => {
    const apiGroup = makeApiGroup({ full_path: "org/sub/group" });
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(apiGroup));

    await getGroup({ gitlabUrl: "https://gitlab.com", token: "tok" }, "org/sub/group");

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect((url as string)).toContain("org%2Fsub%2Fgroup");
  });

  it("throws an auth error on 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({}, { ok: false, status: 401, statusText: "Unauthorized" }),
    );

    await expect(
      getGroup({ gitlabUrl: "https://gitlab.com", token: "bad" }, "test"),
    ).rejects.toThrow("authentication failed");
  });

  it("throws a not-found error on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({}, { ok: false, status: 404, statusText: "Not Found" }),
    );

    await expect(
      getGroup({ gitlabUrl: "https://gitlab.com", token: "tok" }, "missing"),
    ).rejects.toThrow("not found");
  });

  it("throws a generic error for other HTTP failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" }),
    );

    await expect(
      getGroup({ gitlabUrl: "https://gitlab.com", token: "tok" }, "group"),
    ).rejects.toThrow("500");
  });
});

describe("listGroupProjects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns projects from a single page", async () => {
    const projects = [makeApiProject({ id: 1 }), makeApiProject({ id: 2, path: "p2" })];
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(projects));

    const result = await listGroupProjects({ gitlabUrl: "https://gitlab.com", token: "tok" }, 1);
    expect(result).toHaveLength(2);
  });

  it("collects results across multiple pages", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse([makeApiProject({ id: 1 })], { nextPage: "2" }))
      .mockResolvedValueOnce(mockResponse([makeApiProject({ id: 2, path: "p2" })], { nextPage: "" }));

    const result = await listGroupProjects({ gitlabUrl: "https://gitlab.com", token: "tok" }, 1);
    expect(result).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("throws on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({}, { ok: false, status: 403, statusText: "Forbidden" }),
    );

    await expect(
      listGroupProjects({ gitlabUrl: "https://gitlab.com", token: "tok" }, 1),
    ).rejects.toThrow("403");
  });
});

describe("listSubgroups", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns subgroups", async () => {
    const subs = [makeApiGroup({ id: 10, path: "sub1" }), makeApiGroup({ id: 11, path: "sub2" })];
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(subs));

    const result = await listSubgroups({ gitlabUrl: "https://gitlab.com", token: "tok" }, 1);
    expect(result).toHaveLength(2);
  });
});
