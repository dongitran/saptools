import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { ContextConfig, GroupsConfig, ReposConfig } from "../types.js";

import { CONFIG_DIR, CONTEXT_FILE, GROUPS_FILE, REPOS_FILE } from "./paths.js";

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
  return JSON.parse(raw) as T;
}

export async function readRepos(): Promise<ReposConfig> {
  return await readJsonFile(REPOS_FILE, { repos: {} });
}

export async function writeRepos(config: ReposConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(REPOS_FILE, JSON.stringify(config, null, 2), "utf8");
}

export async function readGroups(): Promise<GroupsConfig> {
  return await readJsonFile(GROUPS_FILE, { groups: {} });
}

export async function writeGroups(config: GroupsConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(GROUPS_FILE, JSON.stringify(config, null, 2), "utf8");
}

export async function readContext(): Promise<ContextConfig> {
  return await readJsonFile(CONTEXT_FILE, { context: null });
}

export async function writeContext(config: ContextConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONTEXT_FILE, JSON.stringify(config, null, 2), "utf8");
}
