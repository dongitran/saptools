import { homedir } from "node:os";
import { join } from "node:path";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_TAIL_STORE_FILENAME = "cf-tail-store.json";
const CF_TAIL_STORE_LOCK_FILENAME = "cf-tail-store.lock";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function cfTailStorePath(): string {
  return join(saptoolsDir(), CF_TAIL_STORE_FILENAME);
}

export function cfTailStoreLockPath(): string {
  return join(saptoolsDir(), CF_TAIL_STORE_LOCK_FILENAME);
}
