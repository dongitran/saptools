import process from "node:process";

import type { OutputFlags } from "./options.js";

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeRaw(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function shouldUseColor(flags: OutputFlags): boolean {
  if (flags.noColor === true) {
    return false;
  }
  const noColorEnv = process.env["NO_COLOR"];
  if (noColorEnv !== undefined && noColorEnv !== "") {
    return false;
  }
  const forceColorEnv = process.env["FORCE_COLOR"];
  if (forceColorEnv !== undefined && forceColorEnv !== "" && forceColorEnv !== "0") {
    return true;
  }
  return process.stdout.isTTY;
}

export function bindTerminationSignals(stop: () => Promise<void>): () => void {
  const onSigint = (): void => {
    void stop();
  };
  const onSigterm = (): void => {
    void stop();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

export function suppressBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException): void => {
      if (error.code === "EPIPE") {
        process.exit(0);
      }
      throw error;
    });
  }
}

export function printAppErrors(
  errors: readonly { readonly appName: string; readonly error: string }[],
): void {
  for (const error of errors) {
    process.stderr.write(`[${error.appName}] error: ${error.error}\n`);
  }
}
