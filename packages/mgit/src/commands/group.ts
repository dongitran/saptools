import { readGroups, readRepos, writeGroups } from "../config/storage.js";

export async function groupAdd(groupName: string, repoNames: readonly string[]): Promise<void> {
  const [repos, groups] = await Promise.all([readRepos(), readGroups()]);

  const unknownRepos = repoNames.filter((n) => repos.repos[n] === undefined);
  if (unknownRepos.length > 0) {
    throw new Error(`Unknown repositories: ${unknownRepos.join(", ")}`);
  }

  const isNew = groups.groups[groupName] === undefined;
  const existing = groups.groups[groupName] ?? [];
  const merged = [...new Set([...existing, ...repoNames])];

  await writeGroups({ groups: { ...groups.groups, [groupName]: merged } });
  const action = isNew ? "created" : "updated";
  process.stdout.write(`Group "${groupName}" ${action} with: ${repoNames.join(", ")}\n`);
}

export async function groupRemove(groupName: string): Promise<void> {
  const groups = await readGroups();

  if (groups.groups[groupName] === undefined) {
    throw new Error(`Group not found: "${groupName}"`);
  }

  const updatedGroups = Object.fromEntries(
    Object.entries(groups.groups).filter(([k]) => k !== groupName),
  );

  await writeGroups({ groups: updatedGroups });
  process.stdout.write(`Removed group: ${groupName}\n`);
}

export async function groupList(): Promise<void> {
  const [repos, groups] = await Promise.all([readRepos(), readGroups()]);
  const groupEntries = Object.entries(groups.groups);

  if (groupEntries.length === 0) {
    process.stdout.write('No groups defined. Use "mgit group add <repos...> -n <name>".\n');
    return;
  }

  const nameWidth = Math.max(5, ...groupEntries.map(([name]) => name.length));

  for (const [name, members] of groupEntries) {
    const validMembers = members.filter((m) => repos.repos[m] !== undefined);
    const missingCount = members.length - validMembers.length;
    const missingNote = missingCount > 0 ? ` (${String(missingCount)} missing)` : "";
    process.stdout.write(`${name.padEnd(nameWidth)}  ${validMembers.join(", ")}${missingNote}\n`);
  }
}
