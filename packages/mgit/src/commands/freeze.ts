import { readRepos } from "../config/storage.js";

export async function freeze(): Promise<void> {
  const { repos } = await readRepos();
  const entries = Object.entries(repos).map(([name, path]) => ({
    name,
    url: "",
    path,
  }));

  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
}
