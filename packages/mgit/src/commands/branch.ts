import { printCommandResults } from "../git/display.js";
import { runGitAcrossRepos } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function showBranch(
  namesOrGroups: readonly string[] = [],
  all = false,
): Promise<void> {
  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories matched.\n");
    return;
  }

  const args = all ? ["branch", "-a"] : ["branch"];
  const results = await runGitAcrossRepos(repos, args);
  printCommandResults(results);
}
