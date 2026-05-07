import chalk from "chalk";

import { printCommandResults } from "../git/display.js";
import { runGitAcrossRepos, runGitInteractive } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function superCommand(
  namesOrGroups: readonly string[],
  gitArgs: readonly string[],
): Promise<void> {
  if (gitArgs.length === 0) {
    throw new Error("No git command provided. Usage: mgit super [repos...] -- <git-args>");
  }

  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories matched.\n");
    return;
  }

  if (repos.length === 1) {
    const repo = repos[0];
    if (repo === undefined) {
      return;
    }
    process.stdout.write(`${chalk.bold.blue(`=== ${repo.name} ===`)}\n`);
    await runGitInteractive(repo.path, gitArgs);
    return;
  }

  const results = await runGitAcrossRepos(repos, gitArgs);
  printCommandResults(results);
}
