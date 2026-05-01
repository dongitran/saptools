import process from "node:process";

import { evaluateGlobal } from "../../inspector.js";
import type { EvalCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { resolveTarget, withSession } from "../target.js";

export async function handleEval(opts: EvalCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const result = await withSession(target, async (session) => {
    return await evaluateGlobal(session, opts.expr);
  });
  if (opts.json) {
    writeJson(result);
    if (result.exceptionDetails !== undefined) {
      process.exitCode = 1;
    }
    return;
  }
  writeHumanEvalResult(result);
}

function writeHumanEvalResult(result: Awaited<ReturnType<typeof evaluateGlobal>>): void {
  if (result.exceptionDetails !== undefined) {
    const detail =
      typeof result.exceptionDetails.exception?.description === "string"
        ? result.exceptionDetails.exception.description
        : (typeof result.exceptionDetails.text === "string" ? result.exceptionDetails.text : "evaluation failed");
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
    return;
  }
  const inner = result.result;
  if (inner === undefined) {
    process.stdout.write("\n");
    return;
  }
  if (typeof inner.value === "string") {
    process.stdout.write(`${inner.value}\n`);
    return;
  }
  if (typeof inner.description === "string") {
    process.stdout.write(`${inner.description}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(inner.value)}\n`);
}
