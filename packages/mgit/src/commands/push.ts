import { printCommandResults } from "../git/display.js";
import { runGitAcrossRepos } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function pushRepos(
  namesOrGroups: readonly string[],
  extraArgs: readonly string[] = [],
): Promise<void> {
  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories matched.\n");
    return;
  }

  const results = await runGitAcrossRepos(repos, ["push", ...extraArgs]);
  printCommandResults(results);
}
