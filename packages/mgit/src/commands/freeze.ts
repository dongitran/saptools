import { readRepos } from "../config/storage.js";
import { runGit } from "../git/runner.js";

export async function freeze(): Promise<void> {
  const { repos } = await readRepos();

  const entries = await Promise.all(
    Object.entries(repos).map(async ([name, path]) => {
      let url = "";
      try {
        const { stdout } = await runGit(path, ["remote", "get-url", "origin"]);
        url = stdout.trim();
      } catch {
        // no remote configured or not a valid git repo
      }
      return { name, url, path };
    }),
  );

  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
}
