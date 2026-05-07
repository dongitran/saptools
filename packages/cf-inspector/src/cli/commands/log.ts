import process from "node:process";

import { validateExpression } from "../../inspector/runtime.js";
import { streamLogpoint } from "../../logpoint/stream.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { CfInspectorError } from "../../types.js";
import type { LogCommandOptions } from "../commandTypes.js";
import { writeLogEvent } from "../output.js";
import { withTerminationSignal } from "../signals.js";
import { parsePositiveInt, resolveTarget, withSession } from "../target.js";
import { warnOnUnboundBreakpoints } from "../warnings.js";

export async function handleLog(opts: LogCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const location = parseBreakpointSpec(opts.at);
  const remoteRoot = parseRemoteRoot(opts.remoteRoot);
  const durationSec = parsePositiveInt(opts.duration, "--duration");
  const maxEvents = parsePositiveInt(opts.maxEvents, "--max-events");
  const hitCount = parsePositiveInt(opts.hitCount, "--hit-count");
  const expression = opts.expr.trim();
  if (expression.length === 0) {
    throw new CfInspectorError("INVALID_EXPRESSION", "--expr must not be empty");
  }
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;

  await withTerminationSignal(async (signal) => {
    await withSession(target, async (session) => {
      await validateExpression(session, expression);
      if (condition !== undefined) {
        await validateExpression(session, condition);
      }
      const result = await streamLogpoint(session, {
        location,
        expression,
        remoteRoot,
        ...(durationSec === undefined ? {} : { durationMs: durationSec * 1000 }),
        ...(maxEvents === undefined ? {} : { maxEvents }),
        ...(hitCount === undefined ? {} : { hitCount }),
        ...(condition === undefined ? {} : { condition }),
        signal,
        onEvent: (event) => {
          writeLogEvent(event, opts.json);
        },
        onBreakpointSet: (handle) => {
          warnOnUnboundBreakpoints([handle]);
        },
      });
      writeLogSummary(result.stoppedReason, result.emitted, opts.json);
    });
  });
}

function writeLogSummary(stoppedReason: string, emitted: number, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ stopped: stoppedReason, emitted })}\n`);
    return;
  }
  process.stderr.write(
    `Stopped (${stoppedReason}); emitted ${emitted.toString()} log ${emitted === 1 ? "entry" : "entries"}.\n`,
  );
}
