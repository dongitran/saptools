import { isAbsolute, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { TraceDataError } from "./errors.js";

export interface RuntimeScript {
  readonly scriptId: string;
  readonly url: string;
}

function decodedPath(value: string): string | undefined {
  try {
    if (value.startsWith("file://")) {
      return normalize(fileURLToPath(value));
    }
    return isAbsolute(value) ? normalize(value) : undefined;
  } catch {
    return undefined;
  }
}

function uniqueMatch(matches: readonly RuntimeScript[]): RuntimeScript {
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0];
  }
  const code = matches.length === 0 ? "SCRIPT_NOT_FOUND" : "AMBIGUOUS_SCRIPT";
  const message = code === "SCRIPT_NOT_FOUND" ? "Runtime script was not found." : "Runtime script is ambiguous.";
  throw new TraceDataError(code, message, matches.map(({ url }) => ({ url })));
}

function suffixMatches(file: string, scripts: readonly RuntimeScript[], appRoots: readonly string[]): readonly RuntimeScript[] {
  const suffix = file.replaceAll("\\", "/").replace(/^\.\//u, "");
  return scripts.filter((script) => {
    const path = decodedPath(script.url);
    return path !== undefined && isAppOwnedScript(script.url, appRoots) && path.replaceAll("\\", "/").endsWith(`/${suffix}`);
  });
}

export function resolveRuntimeScript(
  file: string,
  scripts: readonly RuntimeScript[],
  appRoots: readonly string[] = [],
): RuntimeScript {
  const traceable = scripts.filter((script) => isTraceableScript(script.url, appRoots));
  const exactUrl = traceable.filter((script) => script.url === file);
  if (exactUrl.length > 0) {
    return uniqueMatch(exactUrl);
  }
  const path = decodedPath(file);
  if (path !== undefined) {
    return uniqueMatch(traceable.filter((script) => decodedPath(script.url) === path));
  }
  return uniqueMatch(suffixMatches(file, traceable, appRoots));
}

function isTraceableScript(url: string, appRoots: readonly string[]): boolean {
  if (url.length === 0 || url.startsWith("node:") || url.startsWith("internal/") || url.includes("/node_modules/")) {
    return false;
  }
  const path = decodedPath(url);
  if (path === undefined) {
    return false;
  }
  if (appRoots.length === 0) {
    return true;
  }
  return appRoots.some((root) => {
    const fromRoot = relative(normalize(root), path);
    return fromRoot.length === 0 || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
  });
}

export function isAppOwnedScript(url: string, appRoots: readonly string[]): boolean {
  return appRoots.length > 0 && isTraceableScript(url, appRoots);
}
