import ora from "ora";

import { printCommandResults } from "../git/display.js";
import { runGitAcrossRepos } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function pullRepos(namesOrGroups: readonly string[] = []): Promise<void> {
  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories to pull.\n");
    return;
  }

  const spinner = ora(`Pulling ${String(repos.length)} repository(ies)…`).start();

  try {
    const results = await runGitAcrossRepos(repos, ["pull", "--ff-only"]);
    spinner.stop();
    printCommandResults(results);
  } catch (err) {
    spinner.fail("Pull failed");
    throw err;
  }
}
