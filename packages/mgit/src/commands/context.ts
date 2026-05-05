import { resolve, sep } from "node:path";
import process from "node:process";

import { readContext, readGroups, readRepos, writeContext } from "../config/storage.js";

export async function setContext(groupName: string | null): Promise<void> {
  if (groupName === null || groupName === "") {
    await writeContext({ context: null });
    process.stdout.write("Context cleared. Commands now apply to all repositories.\n");
    return;
  }

  if (groupName === "auto") {
    await setContextAuto();
    return;
  }

  const groups = await readGroups();
  if (groups.groups[groupName] === undefined) {
    throw new Error(`Group not found: "${groupName}"`);
  }

  await writeContext({ context: groupName });
  process.stdout.write(`Context set to group: ${groupName}\n`);
}

async function setContextAuto(): Promise<void> {
  const [groups, ctx, repos] = await Promise.all([readGroups(), readContext(), readRepos()]);
  const cwdResolved = resolve(process.cwd());

  const matchingGroup = Object.entries(groups.groups).find(([, members]) =>
    members.some((name) => {
      const path = repos.repos[name];
      if (path === undefined) {
        return false;
      }
      const r = resolve(path);
      return cwdResolved === r || cwdResolved.startsWith(`${r}${sep}`);
    }),
  );

  if (matchingGroup === undefined) {
    const currentContext = ctx.context;
    if (currentContext === null) {
      process.stdout.write("No matching group found for current directory. Context unchanged.\n");
    } else {
      await writeContext({ context: null });
      process.stdout.write("Context cleared (no matching group found for current directory).\n");
    }
  } else {
    const [name] = matchingGroup;
    await writeContext({ context: name });
    process.stdout.write(`Context auto-set to group: ${name}\n`);
  }
}

export async function showContext(): Promise<void> {
  const ctx = await readContext();
  if (ctx.context === null) {
    process.stdout.write("No active context. Commands apply to all repositories.\n");
  } else {
    process.stdout.write(`Active context: ${ctx.context}\n`);
  }
}
