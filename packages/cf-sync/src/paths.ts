import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_STRUCTURE_FILENAME = "cf-structure.json";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function cfStructurePath(): string {
  return join(saptoolsDir(), CF_STRUCTURE_FILENAME);
}
