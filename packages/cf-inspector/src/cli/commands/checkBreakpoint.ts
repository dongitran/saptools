import process from "node:process";

import { getPossibleBreakpoints } from "../../inspector/breakpoints.js";
import type { InspectorSession } from "../../inspector/types.js";
import { buildBreakpointUrlRegex, parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import type { BreakLocation, InspectorIsolate } from "../../types.js";
import type { CheckBreakpointCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { resolveTargetWithCurrentCfTarget, withSessions } from "../target.js";

interface ScriptBreakpointCheck {
  readonly isolate: InspectorIsolate;
  readonly scriptId: string;
  readonly url: string;
  readonly locations: readonly BreakLocation[];
}

interface BreakpointCheckResult {
  readonly file: string;
  readonly line: number;
  readonly status: "breakable" | "unbreakable" | "script-not-loaded";
  readonly scripts: readonly ScriptBreakpointCheck[];
}

export async function handleCheckBreakpoint(
  opts: CheckBreakpointCommandOptions,
): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const location = parseBreakpointSpec(opts.bp);
  const remoteRoot = parseRemoteRoot(opts.remoteRoot);
  const urlRegex = buildBreakpointUrlRegex({ file: location.file, remoteRoot });
  const matcher = new RegExp(urlRegex, "u");
  const result = await withSessions(target, async (group): Promise<BreakpointCheckResult> => {
    const checks = (await Promise.all(group.list().map(async (session) =>
      await checkSession(session, matcher, location.line))))
      .flat();
    const status = checks.length === 0
      ? "script-not-loaded"
      : (checks.some((check) => check.locations.length > 0) ? "breakable" : "unbreakable");
    return { file: location.file, line: location.line, status, scripts: checks };
  });
  if (opts.json) {
    writeJson(result);
    return;
  }
  writeHumanCheck(result);
}

async function checkSession(
  session: InspectorSession,
  matcher: RegExp,
  requestedLine: number,
): Promise<readonly ScriptBreakpointCheck[]> {
  const zeroBasedLine = requestedLine - 1;
  const scripts = [...session.scripts.values()].filter((script) => matcher.test(script.url));
  return await Promise.all(scripts.map(async (script): Promise<ScriptBreakpointCheck> => {
    const locations = await getPossibleBreakpoints(session, {
      start: { scriptId: script.scriptId, lineNumber: zeroBasedLine, columnNumber: 0 },
      end: { scriptId: script.scriptId, lineNumber: zeroBasedLine + 1, columnNumber: 0 },
    });
    return {
      isolate: session.isolate ?? { kind: "main" },
      scriptId: script.scriptId,
      url: script.url,
      locations: locations.filter((candidate) => candidate.lineNumber === zeroBasedLine),
    };
  }));
}

function writeHumanCheck(result: BreakpointCheckResult): void {
  if (result.status === "script-not-loaded") {
    process.stdout.write(
      `${result.file}:${result.line.toString()} does not match any loaded script. ` +
        "Run list-scripts and check --remote-root/path mapping, or trigger lazy module loading first.\n",
    );
    return;
  }
  if (result.status === "unbreakable") {
    process.stdout.write(
      `${result.file}:${result.line.toString()} matches a loaded script, but this exact line has no breakable location. Try a neighboring executable line.\n`,
    );
    return;
  }
  process.stdout.write(`${result.file}:${result.line.toString()} is breakable:\n`);
  for (const script of result.scripts) {
    for (const location of script.locations) {
      const isolate = script.isolate.kind === "main" ? "main" : `worker ${script.isolate.workerId}`;
      process.stdout.write(
        `  ${isolate}\t${script.url}\tline ${(location.lineNumber + 1).toString()}:` +
          `${((location.columnNumber ?? 0) + 1).toString()}\n`,
      );
    }
  }
}

export const internalsForTesting = { checkSession };
