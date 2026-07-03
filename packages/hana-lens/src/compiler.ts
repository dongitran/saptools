import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CompileResult, SapPackage } from "./types.js";
import { isRecord } from "./validation.js";

function workerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "compile-worker.js");
}

export function parseCompileResult(raw: string, packageName: string): CompileResult {
  const payload = raw.trim().split("\n").findLast((line) => line.trim().length > 0);
  if (payload === undefined) {
    throw new Error(`Compile worker for ${packageName} returned no JSON payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Compile worker for ${packageName} returned malformed JSON`, { cause: error });
  }
  if (!isRecord(parsed) || parsed["packageName"] !== packageName || !isRecord(parsed["definitions"])) {
    throw new Error(`Compile worker for ${packageName} returned an invalid payload`);
  }
  return { packageName, definitions: parsed["definitions"] as CompileResult["definitions"] };
}

export async function compilePackage(targetPackage: SapPackage): Promise<CompileResult> {
  return await new Promise<CompileResult>((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath(), targetPackage.directory, targetPackage.name], {
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

export async function compilePackages(packages: readonly SapPackage[]): Promise<readonly CompileResult[]> {
  return await Promise.all(packages.map(async (targetPackage) => await compilePackage(targetPackage)));
}
