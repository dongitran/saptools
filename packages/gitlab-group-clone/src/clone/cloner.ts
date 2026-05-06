import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { flattenGroupTree } from "../gitlab/groups.js";
import type {
  CloneOptions,
  CloneResult,
  CloneSummary,
  GitLabGroup,
  GitLabProject,
  GroupTree,
} from "../types.js";
import { runWithConcurrency } from "../utils.js";

import { buildHttpsCloneUrl, gitClone, gitPull, isGitRepo } from "./git.js";

export function resolveLocalPath(
  project: GitLabProject,
  rootGroup: GitLabGroup,
  destination: string,
): string {
  const relativePath = project.pathWithNamespace.slice(rootGroup.fullPath.length + 1);
  return join(destination, relativePath);
}

export function buildCloneUrl(project: GitLabProject, options: CloneOptions): string {
  return options.protocol === "ssh"
    ? project.sshUrlToRepo
    : buildHttpsCloneUrl(options.gitlabUrl, project.pathWithNamespace, options.token);
}

interface CloneOneOptions {
  project: GitLabProject;
  localPath: string;
  cloneUrl: string;
  token: string;
  update: boolean;
  dryRun: boolean;
}

async function cloneOne(opts: CloneOneOptions): Promise<CloneResult> {
  const { project, localPath, cloneUrl, token, update, dryRun } = opts;

  if (dryRun) {
    return { project, localPath, status: "skipped" };
  }

  if (isGitRepo(localPath)) {
    if (!update) {
      return { project, localPath, status: "skipped" };
    }
    const pullResult = await gitPull(localPath, token);
    return pullResult.success
      ? { project, localPath, status: "updated" }
      : {
          project,
          localPath,
          status: "failed",
          ...(pullResult.error !== undefined && { error: pullResult.error }),
        };
  }

  await mkdir(dirname(localPath), { recursive: true });

  const cloneResult = await gitClone({ url: cloneUrl, destination: localPath, token });
  return cloneResult.success
    ? { project, localPath, status: "cloned" }
    : {
        project,
        localPath,
        status: "failed",
        ...(cloneResult.error !== undefined && { error: cloneResult.error }),
      };
}

export type ProgressCallback = (result: CloneResult, done: number, total: number) => void;

export async function cloneGroupTree(
  tree: GroupTree,
  options: CloneOptions,
  onProgress?: ProgressCallback,
): Promise<CloneSummary> {
  const projects = flattenGroupTree(tree, options.includeArchived);
  const results: CloneResult[] = [];
  let done = 0;

  await runWithConcurrency(projects, options.concurrency, async (project) => {
    const localPath = resolveLocalPath(project, tree.group, options.destination);
    const cloneUrl = buildCloneUrl(project, options);

    const result = await cloneOne({
      project,
      localPath,
      cloneUrl,
      token: options.token,
      update: options.update,
      dryRun: options.dryRun,
    });

    results.push(result);
    done++;
    onProgress?.(result, done, projects.length);
  });

  return {
    total: results.length,
    cloned: results.filter((r) => r.status === "cloned").length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
