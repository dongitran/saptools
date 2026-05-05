import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { ContextConfig, GroupsConfig, ReposConfig } from "../types.js";

import { CONFIG_DIR, CONTEXT_FILE, GROUPS_FILE, REPOS_FILE } from "./paths.js";

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function readRepos(): Promise<ReposConfig> {
  try {
    const raw = await readFile(REPOS_FILE, "utf8");
    return JSON.parse(raw) as ReposConfig;
  } catch {
    return { repos: {} };
  }
}

export async function writeRepos(config: ReposConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(REPOS_FILE, JSON.stringify(config, null, 2), "utf8");
}

export async function readGroups(): Promise<GroupsConfig> {
  try {
    const raw = await readFile(GROUPS_FILE, "utf8");
    return JSON.parse(raw) as GroupsConfig;
  } catch {
    return { groups: {} };
  }
}

export async function writeGroups(config: GroupsConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(GROUPS_FILE, JSON.stringify(config, null, 2), "utf8");
}

export async function readContext(): Promise<ContextConfig> {
  try {
    const raw = await readFile(CONTEXT_FILE, "utf8");
    return JSON.parse(raw) as ContextConfig;
  } catch {
    return { context: null };
  }
}

export async function writeContext(config: ContextConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONTEXT_FILE, JSON.stringify(config, null, 2), "utf8");
}
