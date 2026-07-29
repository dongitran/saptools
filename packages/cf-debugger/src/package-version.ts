import { readFileSync } from "node:fs";

import { CfDebuggerError } from "./types.js";

export function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new CfDebuggerError("PACKAGE_METADATA_INVALID", "Package metadata is not an object.");
  }
  const version: unknown = Reflect.get(parsed, "version");
  if (typeof version !== "string" || version.length === 0) {
    throw new CfDebuggerError("PACKAGE_METADATA_INVALID", "Package metadata has no version.");
  }
  return version;
}
