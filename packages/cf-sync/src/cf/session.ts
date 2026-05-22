import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CfExecContext } from "./index.js";

const CF_SESSION_PREFIX = "saptools-cf-session-";

/**
 * Run `work` with an isolated, ephemeral `CF_HOME` so concurrent CF logins never
 * share the user's real `~/.cf` config or each other's session. The temporary
 * directory is always removed afterwards, even when `work` throws.
 */
export async function withCfSession<T>(
  work: (context: CfExecContext) => Promise<T>,
): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), CF_SESSION_PREFIX));
  const context: CfExecContext = {
    env: { CF_HOME: cfHome },
  };

  try {
    return await work(context);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}
