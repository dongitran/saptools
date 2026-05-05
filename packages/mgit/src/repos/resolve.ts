import { readContext, readGroups, readRepos } from "../config/storage.js";
import type { Repo } from "../types.js";

export async function resolveRepos(namesOrGroups: readonly string[] = []): Promise<Repo[]> {
  const [reposConfig, groupsConfig, ctxConfig] = await Promise.all([
    readRepos(),
    readGroups(),
    readContext(),
  ]);

  const { repos } = reposConfig;
  const { groups } = groupsConfig;

  if (namesOrGroups.length === 0) {
    const activeGroup = ctxConfig.context;
    if (activeGroup === null) {
      return Object.entries(repos).map(([name, path]) => ({ name, path }));
    }
    const members = groups[activeGroup];
    if (members === undefined) {
      throw new Error(`Active context group not found: ${activeGroup}`);
    }
    return members.flatMap((n) => {
      const path = repos[n];
      return path === undefined ? [] : [{ name: n, path }];
    });
  }

  const result: Repo[] = [];
  const seen = new Set<string>();

  for (const arg of namesOrGroups) {
    const groupMembers = groups[arg];

    if (groupMembers !== undefined) {
      for (const n of groupMembers) {
        if (seen.has(n)) {
          continue;
        }
        const path = repos[n];
        if (path !== undefined) {
          result.push({ name: n, path });
          seen.add(n);
        }
      }
      continue;
    }

    const repoPath = repos[arg];
    if (repoPath !== undefined) {
      if (!seen.has(arg)) {
        result.push({ name: arg, path: repoPath });
        seen.add(arg);
      }
      continue;
    }

    throw new Error(`Unknown repository or group: "${arg}"`);
  }

  return result;
}
