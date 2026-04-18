import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const XSUAA_FILENAME = "xsuaa-data.json";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function xsuaaDataPath(): string {
  return join(saptoolsDir(), XSUAA_FILENAME);
}
