import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppHanaEntry } from "./types.js";

export const OUTPUT_FILENAME = "hana-credentials.json";

// Write extracted credentials to a JSON array in the current working directory
export async function writeCredentials(entries: AppHanaEntry[], outputPath?: string): Promise<string> {
  const filePath = resolve(outputPath ?? OUTPUT_FILENAME);
  const content = JSON.stringify(entries, null, 2);

  await writeFile(filePath, content, "utf-8");

  return filePath;
}
