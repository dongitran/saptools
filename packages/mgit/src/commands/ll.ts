import { formatRepoTable } from "../git/display.js";
import { getGitStatus } from "../git/status.js";
import { resolveRepos } from "../repos/resolve.js";
import type { RepoStatus } from "../types.js";

export async function listLong(namesOrGroups: readonly string[] = []): Promise<void> {
  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write('No repositories tracked. Use "mgit add <path>" to add one.\n');
    return;
  }

  const settled = await Promise.allSettled(
    repos.map(async ({ name, path }) => {
      const status = await getGitStatus(path);
      return { name, path, status, error: null } satisfies RepoStatus;
    }),
  );

  const statuses: RepoStatus[] = settled.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    const repo = repos[i];
    const reason: unknown = r.reason;
    return {
      name: repo?.name ?? `repo-${String(i)}`,
      path: repo?.path ?? "",
      status: null,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  });

  process.stdout.write(`${formatRepoTable(statuses)}\n`);
}
