import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { CompileOutcome, CompileResult, SapPackage } from "./types.js";
import { isRecord } from "./validation.js";

const FAILURE_NAME_LIMIT = 5;
const FAILURE_REASON_LIMIT = 2_000;
// Each compile is its own child process (two pipe descriptors plus a process-table entry); an
// unbounded spawn made descriptor exhaustion reachable on large workspaces. A cap near core count
// costs nothing for CPU-bound compilation and was independently verified not to change output
// content (serial and concurrent runs produced hash-identical caches).
const MAX_CONCURRENT_COMPILES = Math.max(1, availableParallelism());

function workerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "compile-worker.js");
}

export function parseCompileResult(raw: string, packageName: string): CompileResult {
  const payloads = raw.trim().split("\n").filter((line) => line.trim().length > 0).reverse();
  if (payloads.length === 0) {
    throw new Error(`Compile worker for ${packageName} returned no JSON payload`);
  }
  let foundJson = false;
  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    foundJson = true;
    if (!isRecord(parsed) || parsed["packageName"] !== packageName || !isRecord(parsed["definitions"])) {
      continue;
    }
    const via = parsed["via"] ?? "cds";
    if (via !== "cds" && via !== "fallback") {
      continue;
    }
    return { packageName, definitions: parsed["definitions"] as CompileResult["definitions"], via };
  }
  throw new Error(`Compile worker for ${packageName} returned ${foundJson ? "an invalid payload" : "malformed JSON"}`);
}

// A non-zero exit or a termination signal (OOM killer, an external timeout, an unrelated teardown
// hook) can still follow a complete, valid payload already flushed to stdout -- so this always
// tries to parse stdout first, regardless of how the process ended, and only falls back to an
// exit-code/signal-based error when no usable result actually exists. Kept separate from the
// spawn/event-listener plumbing so this decision is directly unit-testable with synthetic inputs.
export function resolveCompileOutcome(
  packageName: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): CompileResult {
  try {
    return parseCompileResult(stdout, packageName);
  } catch (parseError) {
    if (code === 0) {
      throw parseError instanceof Error ? parseError : new Error(String(parseError));
    }
  }
  const trimmedStderr = stderr.trim();
  const stderrDetail = trimmedStderr.length > 0 ? trimmedStderr : "(no stderr output)";
  const exitDetail = signal === null
    ? (code === null ? "unknown exit condition" : `exit code ${code.toString()}`)
    : `terminated by signal ${signal}`;
  throw new Error(`Compilation failed for ${packageName}: ${stderrDetail} (${exitDetail})`);
}

export async function compilePackage(targetPackage: SapPackage, allowFallback: boolean): Promise<CompileResult> {
  return await new Promise<CompileResult>((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerPath(),
      targetPackage.directory,
      targetPackage.name,
      allowFallback ? "1" : "0",
    ], {
      cwd: targetPackage.directory,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    // Registered before touching child.stdout/stderr: if spawn cannot allocate stdio pipes
    // (e.g. descriptor exhaustion), those streams are undefined and accessing them would throw
    // synchronously with this listener never attached, escalating to an uncaught process exit.
    child.on("error", (error) => {
      reject(error);
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // TypeScript infers non-null Readable here from the literal stdio tuple above, but that does
    // not hold if spawn itself fails to allocate the pipes -- the very case this is guarding.
    const stdout = child.stdout as Readable | undefined;
    const stderrStream = child.stderr as Readable | undefined;
    stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrStream?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("close", (code, signal) => {
      try {
        resolve(resolveCompileOutcome(
          targetPackage.name,
          code,
          signal,
          Buffer.concat(stdoutChunks).toString("utf8"),
          Buffer.concat(stderrChunks).toString("utf8"),
        ));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function compileWithConcurrencyLimit(
  packages: readonly SapPackage[],
  allowFallback: boolean,
  limit: number,
): Promise<PromiseSettledResult<CompileResult>[]> {
  // Every index from 0 to packages.length - 1 is claimed by exactly one worker below (the read
  // of nextIndex and its increment happen with no `await` between them, so two workers can never
  // claim the same index), so by the time every worker finishes, results has no gaps.
  const results: PromiseSettledResult<CompileResult>[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (let index = nextIndex; index < packages.length; index = nextIndex) {
      nextIndex += 1;
      const targetPackage = packages[index];
      if (targetPackage === undefined) {
        continue;
      }
      try {
        const value = await compilePackage(targetPackage, allowFallback);
        results[index] = { status: "fulfilled", value };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(limit, packages.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    await worker();
  }));
  return results;
}

export async function compilePackages(
  packages: readonly SapPackage[],
  allowFallback: boolean,
  strict: boolean,
): Promise<CompileOutcome> {
  const settled = await compileWithConcurrencyLimit(packages, allowFallback, MAX_CONCURRENT_COMPILES);
  const compiled: CompileResult[] = [];
  const skipped: CompileOutcome["skipped"][number][] = [];
  for (const [index, result] of settled.entries()) {
    const targetPackage = packages[index];
    if (targetPackage === undefined) {
      throw new Error("Compilation outcome did not match its package");
    }
    if (result.status === "fulfilled") {
      compiled.push(result.value);
      continue;
    }
    const reason: unknown = result.reason;
    skipped.push({
      package: targetPackage.name,
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  }
  if (strict && skipped.length > 0) {
    const names = skipped.slice(0, FAILURE_NAME_LIMIT).map((skip) => skip.package).join(", ");
    const remaining = skipped.length - FAILURE_NAME_LIMIT;
    const suffix = remaining > 0 ? `, ... (+${remaining.toString()} more)` : "";
    const firstReason = skipped[0]?.reason ?? "Unknown compilation failure";
    const boundedReason = firstReason.length > FAILURE_REASON_LIMIT
      ? `${firstReason.slice(0, FAILURE_REASON_LIMIT)}...`
      : firstReason;
    throw new Error(
      `Strict mode: ${skipped.length.toString()} package(s) failed to compile: ${names}${suffix}. First failure: ${boundedReason}`,
    );
  }
  return { compiled, skipped };
}
