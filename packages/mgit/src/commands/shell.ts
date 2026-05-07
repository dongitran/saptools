import { printCommandResults } from "../git/display.js";
import { runShellAcrossRepos } from "../git/runner.js";
import { resolveRepos } from "../repos/resolve.js";

export async function shellCommand(
  namesOrGroups: readonly string[],
  command: string,
): Promise<void> {
  if (command.trim().length === 0) {
    throw new Error("No shell command provided. Usage: mgit shell [repos...] -- <command>");
  }

  const repos = await resolveRepos(namesOrGroups);

  if (repos.length === 0) {
    process.stdout.write("No repositories matched.\n");
    return;
  }

  const results = await runShellAcrossRepos(repos, command);
  printCommandResults(results);
}
