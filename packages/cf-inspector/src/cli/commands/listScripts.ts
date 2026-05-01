import process from "node:process";

import { listScripts } from "../../inspector/runtime.js";
import type { ListScriptsCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { resolveTarget, withSession } from "../target.js";

export async function handleListScripts(opts: ListScriptsCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const scripts = await withSession(target, (session) => Promise.resolve(listScripts(session)));
  if (opts.json) {
    writeJson(scripts);
    return;
  }
  for (const script of scripts) {
    process.stdout.write(`${script.scriptId}\t${script.url}\n`);
  }
}
