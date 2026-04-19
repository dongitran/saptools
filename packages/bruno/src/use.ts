import type { CfInfoDeps } from "./cf-info.js";
import { isValidRegionKey, resolveRef } from "./cf-info.js";
import { writeContext } from "./context.js";
import type { BrunoContext } from "./types.js";

export function parseContextShorthand(shorthand: string): {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
} | undefined {
  const segs = shorthand.split("/").filter((s) => s.length > 0);
  if (segs.length !== 4) {
    return undefined;
  }
  const [region, org, space, app] = segs;
  if (!region || !org || !space || !app) {
    return undefined;
  }
  return { region, org, space, app };
}

export interface UseOptions {
  readonly shorthand: string;
  readonly deps?: CfInfoDeps;
  readonly verify?: boolean;
}

export async function useContext(options: UseOptions): Promise<BrunoContext> {
  const parsed = parseContextShorthand(options.shorthand);
  if (!parsed) {
    throw new Error(
      `Invalid context shorthand: ${options.shorthand}. Expected <region>/<org>/<space>/<app>.`,
    );
  }

  if (!isValidRegionKey(parsed.region)) {
    throw new Error(`Unknown region key: ${parsed.region}`);
  }

  if (options.verify !== false) {
    const resolved = await resolveRef({ ...parsed, region: parsed.region }, options.deps);
    if (!resolved) {
      throw new Error(
        `Could not verify ${options.shorthand} against the cached CF structure. Run \`cf-sync sync\` first.`,
      );
    }
  }

  return await writeContext(parsed);
}
