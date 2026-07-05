#!/usr/bin/env node
import {
  applyVariables,
  discoverRepositories,
  extractPlaceholders,
  linkWorkspace,
  normalizePath,
  parseCdsFile,
  parseDecorators,
  parseHandlerRegistrations,
  parseOutboundCalls,
  parsePackageJson,
  parseServiceBindings,
  redactText,
  redactValue,
  stripQuotes,
  substituteVariables,
  trace
} from "./chunk-CWJYVIG2.js";

// src/parsers/generated-constants-parser.ts
import fs from "fs/promises";
import path from "path";
function lineOf(text, idx) {
  return text.slice(0, idx).split("\n").length;
}
async function parseGeneratedConstants(repoPath, filePath) {
  const text = await fs.readFile(path.join(repoPath, filePath), "utf8");
  return [
    ...text.matchAll(
      /(?:export\s+)?(?:const|static\s+readonly)\s+(\w+)\s*=\s*(['"])([^'"]+)\2/g
    )
  ].map((m) => ({
    name: m[1] ?? "constant",
    value: stripQuotes(m[3] ?? ""),
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(text, m.index ?? 0)
  }));
}
export {
  applyVariables,
  discoverRepositories,
  extractPlaceholders,
  linkWorkspace,
  parseCdsFile,
  parseDecorators,
  parseGeneratedConstants,
  parseHandlerRegistrations,
  parseOutboundCalls,
  parsePackageJson,
  parseServiceBindings,
  redactText,
  redactValue,
  substituteVariables,
  trace
};
//# sourceMappingURL=index.js.map