import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import type { AppHanaEntry } from "./types.js";

export const OUTPUT_FILENAME = "hana-credentials.json";

export interface WriteCredentialsOptions {
  readonly outputPath?: string;
  readonly cwd?: string;
}

export async function writeCredentials(
  entries: readonly AppHanaEntry[],
  options: WriteCredentialsOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = options.outputPath
    ? resolve(cwd, options.outputPath)
    : resolve(cwd, OUTPUT_FILENAME);
  const content = `${JSON.stringify(entries, null, 2)}\n`;
  await writeFile(filePath, content, "utf-8");
  return filePath;
}
