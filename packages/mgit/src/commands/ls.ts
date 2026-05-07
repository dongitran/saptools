import { readContext, readGroups, readRepos } from "../config/storage.js";

export async function listRepos(groupFilter?: string): Promise<void> {
  const [repos, groups, ctx] = await Promise.all([readRepos(), readGroups(), readContext()]);

  const activeGroup = groupFilter ?? ctx.context;
  let names = Object.keys(repos.repos);

  if (activeGroup !== null) {
    const members = groups.groups[activeGroup];
    if (members === undefined) {
      throw new Error(`Group not found: "${activeGroup}"`);
    }
    const memberSet = new Set(members);
    names = names.filter((n) => memberSet.has(n));
  }

  if (names.length === 0) {
    process.stdout.write("No repositories tracked.\n");
    return;
  }

  process.stdout.write(`${names.join("\n")}\n`);
}
