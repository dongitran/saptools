import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CfExecContext } from "./cf.js";
import { cfEnv } from "./cf.js";
import { parseDefaultEnv } from "./parse-vcap.js";
import { openCfSession } from "./session.js";
import type { DefaultEnv, GenEnvOptions } from "./types.js";

export interface GenEnvResult {
  readonly outPath: string;
  readonly payload: DefaultEnv;
}

export async function genEnv(
  options: GenEnvOptions,
  context?: CfExecContext,
): Promise<GenEnvResult> {
  const session = await openCfSession(options.target, context);
  try {
    const raw = await cfEnv(options.target.app, session.context);
    const payload: DefaultEnv = parseDefaultEnv(raw);

    const outResolved = resolve(options.outPath);
    await mkdir(dirname(outResolved), { recursive: true });
    await writeFile(outResolved, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(outResolved, 0o600);

    return { outPath: outResolved, payload };
  } finally {
    await session.dispose();
  }
}
