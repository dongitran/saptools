import { readGroups, readRepos, writeGroups, writeRepos } from "../config/storage.js";

export async function removeRepo(name: string): Promise<void> {
  const [repos, groups] = await Promise.all([readRepos(), readGroups()]);

  if (repos.repos[name] === undefined) {
    throw new Error(`Repository not tracked: "${name}"`);
  }

  const path = repos.repos[name];
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
}
