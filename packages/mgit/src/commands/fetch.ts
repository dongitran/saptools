import ora from "ora";

import { printCommandResults } from "../git/display.js";
import { runGitAcrossRepos } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function fetchRepos(namesOrGroups: readonly string[] = []): Promise<void> {
  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories to fetch.\n");
    return;
  }

  const spinner = ora(`Fetching ${String(repos.length)} repository(ies)…`).start();

  try {
    const results = await runGitAcrossRepos(repos, ["fetch", "--all", "--prune"]);
    spinner.stop();
    printCommandResults(results);
  } catch (err) {
    spinner.fail("Fetch failed");
    throw err;
  }
}
