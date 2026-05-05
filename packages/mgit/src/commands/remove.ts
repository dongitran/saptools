import { readContext, readGroups, readRepos, writeGroups, writeRepos } from "../config/storage.js";

export async function removeRepo(name: string): Promise<void> {
  const [repos, groups, ctx] = await Promise.all([readRepos(), readGroups(), readContext()]);

  const path = repos.repos[name];
  if (path === undefined) {
    throw new Error(`Repository not tracked: "${name}"`);
  }

  const updatedRepos = Object.fromEntries(Object.entries(repos.repos).filter(([k]) => k !== name));

  const updatedGroups = Object.fromEntries(
    Object.entries(groups.groups).map(([groupName, members]) => [
      groupName,
      members.filter((m) => m !== name),
    ]),
  );

  await Promise.all([
    writeRepos({ repos: updatedRepos }),
    writeGroups({ groups: updatedGroups }),
  ]);

  process.stdout.write(`Removed: ${name} (${path})\n`);

  const activeGroup = ctx.context;
  if (activeGroup !== null) {
    const remaining = updatedGroups[activeGroup];
    if (remaining?.length === 0) {
      process.stdout.write(`Warning: active context group "${activeGroup}" is now empty.\n`);
    }
  }
}
