import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { readRepos, writeRepos } from "../config/storage.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

interface CloneEntry {
  readonly name: string;
  readonly url: string;
  readonly path: string;
}

export async function cloneFromConfig(configFile: string): Promise<void> {
  const absConfig = resolve(configFile);
  const raw = await readFile(absConfig, "utf8");
  const entries = JSON.parse(raw) as CloneEntry[];

  if (!Array.isArray(entries)) {
    throw new Error("Config file must be a JSON array of { name, url, path } objects");
  }

  const repos = await readRepos();
  const updatedRepos = { ...repos.repos };

  for (const entry of entries) {
    if (
      typeof entry.name !== "string" ||
      typeof entry.url !== "string" ||
      typeof entry.path !== "string"
    ) {
      throw new Error(`Invalid entry: ${JSON.stringify(entry)}`);
    }

    const absPath = resolve(entry.path);
    process.stdout.write(`Cloning ${entry.name} from ${entry.url} → ${absPath}\n`);

    await mkdir(dirname(absPath), { recursive: true });
    await execFileAsync("git", ["clone", entry.url, absPath], { maxBuffer: MAX_BUFFER });

    updatedRepos[entry.name] = absPath;
    await writeRepos({ repos: updatedRepos });
    process.stdout.write(`  ✓ ${entry.name}\n`);
  }

  process.stdout.write(`\nCloned and registered ${String(entries.length)} repository(ies).\n`);
}
