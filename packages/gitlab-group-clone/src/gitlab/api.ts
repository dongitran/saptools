import type { GitLabApiGroup, GitLabApiProject, GitLabClientOptions } from "../types.js";

class GitLabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

async function fetchPaged<T>(url: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const separator = url.includes("?") ? "&" : "?";
    const pageUrl = `${url}${separator}per_page=100&page=${page.toString()}`;

    const response = await fetch(pageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new GitLabApiError(
        `GitLab API error ${response.status.toString()}: ${response.statusText} (${pageUrl})`,
        response.status,
      );
    }

    const data = (await response.json()) as T[];
    results.push(...data);

    const nextPage = response.headers.get("x-next-page");
    hasMore = Boolean(nextPage);
    if (nextPage) {
      page = parseInt(nextPage, 10);
    }
  }

  return results;
}

export async function getGroup(
  options: GitLabClientOptions,
  groupPath: string,
): Promise<GitLabApiGroup> {
  const encoded = encodeURIComponent(groupPath);
  const url = `${options.gitlabUrl}/api/v4/groups/${encoded}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "GitLab authentication failed: check your GITLAB_TOKEN",
      );
    }
    if (response.status === 404) {
      throw new Error(`GitLab group not found: "${groupPath}"`);
    }
    throw new GitLabApiError(
      `Failed to fetch group "${groupPath}": ${response.status.toString()} ${response.statusText}`,
      response.status,
    );
  }

  return (await response.json()) as GitLabApiGroup;
}

export async function listGroupProjects(
  options: GitLabClientOptions,
  groupId: number,
): Promise<GitLabApiProject[]> {
  const url = `${options.gitlabUrl}/api/v4/groups/${groupId.toString()}/projects`;
  return await fetchPaged<GitLabApiProject>(url, options.token);
}

export async function listSubgroups(
  options: GitLabClientOptions,
  groupId: number,
): Promise<GitLabApiGroup[]> {
  const url = `${options.gitlabUrl}/api/v4/groups/${groupId.toString()}/subgroups`;
  return await fetchPaged<GitLabApiGroup>(url, options.token);
}
