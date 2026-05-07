import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const xdgConfigHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");

export const CONFIG_DIR = process.env["MGIT_CONFIG_HOME"] ?? join(xdgConfigHome, "mgit");

export const REPOS_FILE = join(CONFIG_DIR, "repos.json");
export const GROUPS_FILE = join(CONFIG_DIR, "groups.json");
export const CONTEXT_FILE = join(CONFIG_DIR, "context.json");
