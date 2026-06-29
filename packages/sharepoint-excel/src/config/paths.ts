import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { ENV_HOME } from "../types.js";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const PACKAGE_DIR_NAME = "sharepoint-excel";
export const PROFILES_FILENAME = "profiles.json";
export const FILE_SECRETS_FILENAME = "secrets.json";

export function packageDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_HOME];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), SAPTOOLS_DIR_NAME, PACKAGE_DIR_NAME);
}

export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(packageDataDir(env), PROFILES_FILENAME);
}

export function fileSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(packageDataDir(env), FILE_SECRETS_FILENAME);
}
