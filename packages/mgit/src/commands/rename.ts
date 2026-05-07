import { readGroups, readRepos, writeGroups, writeRepos } from "../config/storage.js";

export async function renameRepo(oldName: string, newName: string): Promise<void> {
  const [repos, groups] = await Promise.all([readRepos(), readGroups()]);

  const oldPath = repos.repos[oldName];
  if (oldPath === undefined) {
    throw new Error(`Repository not tracked: "${oldName}"`);
  }

  if (repos.repos[newName] !== undefined) {
    throw new Error(`Name already in use: "${newName}"`);
  }

  const updatedRepos = Object.fromEntries(
    Object.entries(repos.repos)
      .filter(([k]) => k !== oldName)
      .concat([[newName, oldPath]]),
  );

  const updatedGroups = Object.fromEntries(
    Object.entries(groups.groups).map(([groupName, members]) => [
      groupName,
      members.map((m) => (m === oldName ? newName : m)),
    ]),
  );

  await Promise.all([
    writeRepos({ repos: updatedRepos }),
    writeGroups({ groups: updatedGroups }),
  ]);

  process.stdout.write(`Renamed: ${oldName} → ${newName}\n`);
}
