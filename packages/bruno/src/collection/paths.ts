import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const BRUNO_CONTEXT_FILENAME = "bruno-context.json";

export const REGION_FOLDER_PREFIX = "region__";
export const ORG_FOLDER_PREFIX = "org__";
export const SPACE_FOLDER_PREFIX = "space__";
export const ENVIRONMENTS_DIR = "environments";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function brunoContextPath(): string {
  return join(saptoolsDir(), BRUNO_CONTEXT_FILENAME);
}

export function regionFolderName(key: string): string {
  return `${REGION_FOLDER_PREFIX}${key}`;
}

export function orgFolderName(name: string): string {
  return `${ORG_FOLDER_PREFIX}${name}`;
}

export function spaceFolderName(name: string): string {
  return `${SPACE_FOLDER_PREFIX}${name}`;
}

export function parsePrefixedName(
  dirName: string,
  prefix: string,
): string | undefined {
  if (!dirName.startsWith(prefix)) {
    return undefined;
  }
  return dirName.slice(prefix.length);
}
