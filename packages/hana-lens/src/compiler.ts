import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CompileOutcome, CompileResult, SapPackage } from "./types.js";
import { isRecord } from "./validation.js";

const FAILURE_NAME_LIMIT = 5;
const FAILURE_REASON_LIMIT = 2_000;

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
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`Compilation failed for ${targetPackage.name}: ${stderr}`));
        return;
      }
      try {
        resolve(parseCompileResult(Buffer.concat(stdoutChunks).toString("utf8"), targetPackage.name));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function compilePackages(
  packages: readonly SapPackage[],
  allowFallback: boolean,
  strict: boolean,
): Promise<CompileOutcome> {
  const settled = await Promise.allSettled(
    packages.map(async (targetPackage) => await compilePackage(targetPackage, allowFallback)),
  );
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
