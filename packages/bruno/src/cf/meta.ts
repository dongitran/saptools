import { readFile, writeFile } from "node:fs/promises";

import { parseBruEnvFile } from "../bruno/parser.js";
import { upsertVars } from "../bruno/writer.js";
import { CF_META_KEYS } from "../types.js";
import type { CfAppRef, CfMetaKey } from "../types.js";

export interface CfMeta {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export function readCfMetaFromVars(vars: ReadonlyMap<string, string>): CfMeta | undefined {
  const region = vars.get("__cf_region");
  const org = vars.get("__cf_org");
  const space = vars.get("__cf_space");
  const app = vars.get("__cf_app");
  if (!region || !org || !space || !app) {
    return undefined;
  }
  return { region, org, space, app };
}

export function buildCfMetaUpdates(ref: CfAppRef, baseUrl?: string): Map<string, string> {
  const updates = new Map<string, string>();
  const pairs: readonly [CfMetaKey, string][] = [
    ["__cf_region", ref.region],
    ["__cf_org", ref.org],
    ["__cf_space", ref.space],
    ["__cf_app", ref.app],
  ];
  for (const [k, v] of pairs) {
    updates.set(k, v);
  }
  if (baseUrl !== undefined) {
    updates.set("baseUrl", baseUrl);
  }
  return updates;
}

export function hasCfMeta(vars: ReadonlyMap<string, string>): boolean {
  return CF_META_KEYS.every((k) => {
    const v = vars.get(k);
    return v !== undefined && v.length > 0;
  });
}

export async function readCfMetaFromFile(path: string): Promise<CfMeta | undefined> {
  const raw = await readFile(path, "utf8");
  const parsed = parseBruEnvFile(raw);
  return readCfMetaFromVars(parsed.vars.entries);
}

export async function writeCfMetaToFile(
  path: string,
  ref: CfAppRef,
  baseUrl?: string,
): Promise<boolean> {
  const raw = await readFile(path, "utf8");
  const updates = buildCfMetaUpdates(ref, baseUrl);
  const { content, changed } = upsertVars(raw, updates);
  if (changed) {
    await writeFile(path, content, "utf8");
  }
  return changed;
}
