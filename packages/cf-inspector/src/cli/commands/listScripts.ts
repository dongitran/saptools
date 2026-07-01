import process from "node:process";

import { discoverInspectorTargets } from "../../inspector/discovery.js";
import { listScripts } from "../../inspector/runtime.js";
import { CfInspectorError } from "../../types.js";
import type { ListScriptsCommandOptions, ListTargetsCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { openTarget, resolveTargetWithCurrentCfTarget, withSession } from "../target.js";

export async function handleListScripts(opts: ListScriptsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const regex = compileFilter(opts.filter);
  const scripts = (await withSession(target, (session) => Promise.resolve(listScripts(session))))
    .filter((script) => regex === undefined || regex.test(script.url));
  if (opts.json) {
    writeJson(scripts);
    return;
  }
  for (const script of scripts) {
    process.stdout.write(`${script.scriptId}\t${script.url}\n`);
  }
}

export async function handleListTargets(opts: ListTargetsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const tunnel = await openTarget(target);
  try {
    const targets = await discoverInspectorTargets(tunnel.host, tunnel.port, 5_000);
    const indexedTargets = targets.map((entry, index) => ({ index, ...entry }));
    if (opts.json) {
      writeJson(indexedTargets);
      return;
    }
    for (const entry of indexedTargets) {
      process.stdout.write(`${entry.index.toString()}\t${entry.type}\t${entry.title}\t${entry.url}\n`);
    }
  } finally {
    await tunnel.dispose();
  }
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileFilter(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern.length === 0) {
    return undefined;
  }
  try {
    return new RegExp(escapeRegExpLiteral(pattern));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CfInspectorError("INVALID_ARGUMENT", `Invalid --filter regular expression: ${detail}`);
  }
}
