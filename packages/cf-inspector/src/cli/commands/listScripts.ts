import process from "node:process";

import { discoverInspectorTargets } from "../../inspector/discovery.js";
import { listScripts } from "../../inspector/runtime.js";
import type { ListScriptsCommandOptions, ListTargetsCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { openTarget, resolveTargetWithCurrentCfTarget, withSession } from "../target.js";

type ScriptUrlFilter = (url: string) => boolean;
type FilterToken = string | { readonly kind: "wildcard"; readonly minChars: 0 | 1 };

export async function handleListScripts(opts: ListScriptsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const filter = compileScriptUrlFilter(opts.filter);
  const scripts = (await withSession(target, (session) => Promise.resolve(listScripts(session))))
    .filter((script) => filter === undefined || filter(script.url));
  if (opts.json) {
    writeJson(scripts);
    return;
  }
  for (const script of scripts) {
    process.stdout.write(`${script.scriptId}\t${script.url}\n`);
  }
}

export async function handleListTargets(opts: ListTargetsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const tunnel = await openTarget(target);
  try {
    const targets = await discoverInspectorTargets(tunnel.host, tunnel.port, 5_000);
    const indexedTargets = targets.map((entry, index) => ({ index, ...entry }));
    if (opts.json) {
      writeJson(indexedTargets);
      return;
    }
    for (const entry of indexedTargets) {
      process.stdout.write(`${entry.index.toString()}\t${entry.type}\t${entry.title}\t${entry.url}\n`);
    }
  } finally {
    await tunnel.dispose();
  }
}

export function compileScriptUrlFilter(pattern: string | undefined): ScriptUrlFilter | undefined {
  if (pattern === undefined || pattern.length === 0) {
    return undefined;
  }
  const alternatives = splitPatternAlternatives(pattern)
    .map((alternative) => parseFilterTokens(alternative))
    .filter((tokens) => tokens.length > 0);
  return (url: string): boolean => alternatives.some((tokens) => matchesFilterTokens(url, tokens));
}

function splitPatternAlternatives(pattern: string): readonly string[] {
  const alternatives: string[] = [];
  let current = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    if (char === "\\" && index + 1 < pattern.length) {
      current += `${char}${pattern[index + 1] ?? ""}`;
      index++;
    } else if (char === "|") {
      alternatives.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  alternatives.push(current);
  return alternatives;
}

function parseFilterTokens(pattern: string): readonly FilterToken[] {
  const tokens: FilterToken[] = [];
  let literal = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const nextChar = pattern[index + 1];
    if (char === "\\" && nextChar !== undefined) {
      literal += nextChar;
      index++;
    } else if (char === "." && (nextChar === "*" || nextChar === "+")) {
      if (literal.length > 0) { tokens.push(literal); }
      literal = "";
      tokens.push({ kind: "wildcard", minChars: nextChar === "+" ? 1 : 0 });
      index++;
    } else {
      literal += char;
    }
  }
  if (literal.length > 0) { tokens.push(literal); }
  return tokens;
}

function matchesFilterTokens(value: string, tokens: readonly FilterToken[]): boolean {
  let position = 0;
  for (const token of tokens) {
    if (typeof token === "string") {
      const nextPosition = value.indexOf(token, position);
      if (nextPosition === -1) { return false; }
      position = nextPosition + token.length;
    } else {
      if (token.minChars === 1 && position >= value.length) { return false; }
      position += token.minChars;
    }
  }
  return true;
}
