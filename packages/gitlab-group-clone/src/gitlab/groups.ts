import type {
  GitLabApiGroup,
  GitLabApiProject,
  GitLabClientOptions,
  GitLabGroup,
  GitLabProject,
  GroupTree,
} from "../types.js";

import { getGroup, listGroupProjects, listSubgroups } from "./api.js";

function toGroup(api: GitLabApiGroup): GitLabGroup {
  return {
    id: api.id,
    name: api.name,
    path: api.path,
    fullPath: api.full_path,
    description: api.description,
    visibility: api.visibility,
  };
}

function toProject(api: GitLabApiProject): GitLabProject {
  return {
    id: api.id,
    name: api.name,
    path: api.path,
    pathWithNamespace: api.path_with_namespace,
    httpUrlToRepo: api.http_url_to_repo,
    sshUrlToRepo: api.ssh_url_to_repo,
    visibility: api.visibility,
    archived: api.archived,
  };
}

async function buildTree(
  options: GitLabClientOptions,
  apiGroup: GitLabApiGroup,
): Promise<GroupTree> {
  const [apiProjects, apiSubgroups] = await Promise.all([
    listGroupProjects(options, apiGroup.id),
    listSubgroups(options, apiGroup.id),
  ]);

  const subgroupTrees = await Promise.all(
    apiSubgroups.map((sub) => buildTree(options, sub)),
  );

  return {
    group: toGroup(apiGroup),
    projects: apiProjects.map(toProject),
    subgroups: subgroupTrees,
  };
}

export async function fetchGroupTree(
  options: GitLabClientOptions,
  groupPath: string,
): Promise<GroupTree> {
  const apiGroup = await getGroup(options, groupPath);
  return await buildTree(options, apiGroup);
}

export function flattenGroupTree(
  tree: GroupTree,
  includeArchived: boolean,
): GitLabProject[] {
  const projects = includeArchived
    ? tree.projects
    : tree.projects.filter((p) => !p.archived);

  return [
    ...projects,
    ...tree.subgroups.flatMap((sub) => flattenGroupTree(sub, includeArchived)),
  ];
}

export function countProjects(tree: GroupTree, includeArchived: boolean): number {
  return flattenGroupTree(tree, includeArchived).length;
}
