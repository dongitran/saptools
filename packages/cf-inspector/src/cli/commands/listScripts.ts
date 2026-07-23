import process from "node:process";

import { discoverInspectorTargets } from "../../inspector/discovery.js";
import type { InspectorTarget } from "../../inspector/discovery.js";
import { listScripts } from "../../inspector/runtime.js";
import { discoverNodeWorkerTargets } from "../../inspector/session.js";
import type { InspectorSession, InspectorWorkerTarget } from "../../inspector/types.js";
import type { InspectorIsolate, ListedScriptInfo } from "../../types.js";
import type {
  ListScriptsCommandOptions,
  ListTargetsCommandOptions,
  Target,
} from "../commandTypes.js";
import { writeJson } from "../output.js";
import { openTarget, resolveTargetWithCurrentCfTarget, withSessions } from "../target.js";
import { warnOnImplicitInspectorSelection } from "../warnings.js";

type ScriptUrlFilter = (url: string) => boolean;
type FilterToken = string | { readonly kind: "wildcard"; readonly minChars: 0 | 1 };

export async function handleListScripts(opts: ListScriptsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const filter = compileScriptUrlFilter(opts.filter);
  const scripts = (await withSessions(target, (group) => {
    const sessions = group.list();
    warnOnListScriptsSelection(target, {
      targetCount: group.targetCount,
      targetIndex: group.targetIndex,
      ...(sessions[0]?.workerTargets === undefined
        ? {}
        : { workerTargets: sessions[0].workerTargets }),
    });
    return Promise.resolve(collectListedScripts(sessions));
  }))
    .filter((script) => filter === undefined || filter(script.url));
  if (opts.json) {
    writeJson(scripts);
    return;
  }
  for (const script of scripts) {
    process.stdout.write(
      `${script.scriptId}\t${script.url}\t${formatIsolate(script.isolate)}\n`,
    );
  }
}

export function warnOnListScriptsSelection(
  target: Target,
  selection: Pick<InspectorSession, "targetCount" | "targetIndex" | "workerTargets">,
): void {
  const autoAttach = target.targetIndex === undefined &&
    target.workerIndex === undefined &&
    target.workerId === undefined &&
    target.mainOnly !== true;
  const isolateWasExplicit = autoAttach ||
    target.workerIndex !== undefined ||
    target.workerId !== undefined ||
    target.mainOnly === true;
  warnOnImplicitInspectorSelection(
    selection,
    target.targetIndex !== undefined,
    isolateWasExplicit,
  );
}

function collectListedScripts(sessions: readonly InspectorSession[]): readonly ListedScriptInfo[] {
  return sessions.flatMap((session) => listScripts(session).map((script) => ({
    ...script,
    isolate: session.isolate ?? { kind: "main" },
  })));
}

function formatIsolate(isolate: InspectorIsolate): string {
  return isolate.kind === "worker" ? `worker:${isolate.workerId}` : "main";
}

export async function handleListTargets(opts: ListTargetsCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const tunnel = await openTarget(target);
  try {
    const targets = await discoverInspectorTargets(tunnel.host, tunnel.port, 5_000);
    const indexedTargets = await buildListedTargets(targets);
    const workerCount = indexedTargets.reduce((count, targetEntry) => {
      return count + targetEntry.workers.length;
    }, 0);
    writeTargetCountSummary(indexedTargets.length, workerCount);
    warnOnMissingWorkers(indexedTargets.length, workerCount, indexedTargets);
    if (opts.json) {
      writeJson(indexedTargets);
      return;
    }
    writeHumanTargets(indexedTargets);
  } finally {
    await tunnel.dispose();
  }
}

interface ListedWorkerTarget {
  readonly index: number;
  readonly workerId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
}

interface ListedInspectorTarget extends InspectorTarget {
  readonly index: number;
  readonly likelyWorker: boolean;
  readonly workerDiscoverySupported: boolean;
  readonly workers: readonly ListedWorkerTarget[];
}

async function buildListedTargets(
  targets: readonly InspectorTarget[],
): Promise<readonly ListedInspectorTarget[]> {
  return await Promise.all(targets.map(async (target, index) => {
    try {
      const workerResult = await discoverNodeWorkerTargets(target);
      return buildListedTarget(target, index, workerResult.supported, workerResult.workers);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[cf-inspector] warning: worker discovery failed for raw target ${index.toString()}: ${message}\n`,
      );
      return buildListedTarget(target, index, false, []);
    }
  }));
}

function buildListedTarget(
  target: InspectorTarget,
  index: number,
  workerDiscoverySupported: boolean,
  workers: readonly InspectorWorkerTarget[],
): ListedInspectorTarget {
  return {
    index,
    ...target,
    likelyWorker: looksLikeWorkerTarget(target),
    workerDiscoverySupported,
    workers: workers.map((worker, workerIndex) => ({
      index: workerIndex,
      workerId: worker.workerId,
      type: worker.type,
      title: worker.title,
      url: worker.url,
    })),
  };
}

function looksLikeWorkerTarget(target: InspectorTarget): boolean {
  return `${target.type} ${target.title} ${target.url}`.toLowerCase().includes("worker");
}

function writeTargetCountSummary(targetCount: number, workerCount: number): void {
  process.stderr.write(
    `[cf-inspector] ${targetCount.toString()} raw inspector ` +
      `${targetCount === 1 ? "target" : "targets"}; ${workerCount.toString()} ` +
      `${workerCount === 1 ? "worker" : "workers"}.\n`,
  );
}

function warnOnMissingWorkers(
  targetCount: number,
  workerCount: number,
  targets: readonly ListedInspectorTarget[],
): void {
  if (targetCount !== 1 || workerCount !== 0) {
    return;
  }
  const supported = targets[0]?.workerDiscoverySupported === true;
  const supportHint = supported
    ? "NodeWorker discovery is available, but no live worker attached."
    : "This runtime did not expose NodeWorker discovery.";
  process.stderr.write(
    `[cf-inspector] warning: only the main inspector target is reachable. ${supportHint} ` +
      "If worker code is expected, ensure the worker is alive and rerun list-targets. " +
      "A worker on a separate inspector port is not carried by a single Cloud Foundry tunnel.\n",
  );
}

function writeHumanTargets(targets: readonly ListedInspectorTarget[]): void {
  for (const target of targets) {
    const workerLabel = target.likelyWorker ? "\tlikely-worker" : "";
    process.stdout.write(
      `${target.index.toString()}\ttarget\t${target.type}\t${target.title}\t${target.url}${workerLabel}\n`,
    );
    for (const worker of target.workers) {
      process.stdout.write(
        `  ${worker.index.toString()}\tworker\t${worker.type}\t${worker.title}\t${worker.url}\n`,
      );
    }
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
