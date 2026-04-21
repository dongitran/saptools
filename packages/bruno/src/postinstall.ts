import process from "node:process";
import { fileURLToPath } from "node:url";

export function buildInstallHint(): string {
  return (
    "[saptools-bruno] Next step: run `saptools-bruno sync` to cache your CF landscape.\n" +
    "[saptools-bruno] If this was a project install, run it via your package manager, for example `npx saptools-bruno sync`.\n"
  );
}

export function shouldPrintInstallHint(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CI"] !== "true" && env["npm_config_loglevel"] !== "silent";
}

function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }

  return fileURLToPath(metaUrl) === argv1;
}

export function printInstallHint(writeStdout: (message: string) => void = (message) => {
  process.stdout.write(message);
}): void {
  writeStdout(buildInstallHint());
}

if (isDirectExecution(import.meta.url, process.argv[1]) && shouldPrintInstallHint()) {
  printInstallHint();
}
