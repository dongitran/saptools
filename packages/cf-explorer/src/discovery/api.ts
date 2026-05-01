import { cfApp, type CfCommandContext, type CfRunOptions } from "../cf/client.js";
import { sshStatus, enableSsh, prepareSsh, restartApp } from "../cf/lifecycle.js";
import { normalizeTarget, resolveInstance, resolveInstanceSelector, resolveProcessName } from "../cf/target.js";
import { CfExplorerError, toExplorerError } from "../core/errors.js";
import type {
  CreateExplorerOptions,
  DiscoveryOptions,
  Explorer,
  ExplorerMeta,
  ExplorerRuntimeOptions,
  ExplorerTarget,
  FindOptions,
  FindResult,
  GrepOptions,
  GrepResult,
  InspectCandidatesOptions,
  InspectCandidatesResult,
  InstanceInfo,
  InstanceResult,
  InstancesResult,
  LsOptions,
  LsResult,
  RootsResult,
  ViewOptions,
  ViewResult,
} from "../core/types.js";

import {
  buildFindScript,
  buildGrepScript,
  buildInspectCandidatesScript,
  buildLsScript,
  buildRootsScript,
  buildViewScript,
} from "./commands.js";
import {
  parseCfAppInstances,
  parseFindOutput,
  parseGrepOutput,
  parseInspectOutput,
  parseLsOutput,
  parseRootsOutput,
  parseViewOutput,
} from "./parsers.js";
import {
  executeRemoteScript,
  executeRemoteScriptWithContext,
  withPreparedCfSession,
  type RemoteExecutionResult,
} from "./runner.js";

interface ExecuteInput {
  readonly target: ExplorerTarget;
  readonly processName: string;
  readonly instance: number;
  readonly script: string;
  readonly runtime?: ExplorerRuntimeOptions;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

interface InstanceWorkResult<T> {
  readonly value: T;
  readonly truncated: boolean;
}

export async function listInstances(options: DiscoveryOptions): Promise<InstancesResult> {
  const startedAt = Date.now();
  const target = normalizeTarget(options.target);
  const processName = resolveProcessName(options.process);
  const stdout = await withPreparedCfSession(target, options.runtime, async (context) => {
    return await cfApp(target, context, effectiveRunLimits(options));
  });
  return {
    meta: buildMeta(target, processName, undefined, Date.now() - startedAt, false),
    instances: parseCfAppInstances(stdout),
  };
}

export async function roots(options: DiscoveryOptions): Promise<RootsResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    return await rootsAllInstances(options);
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildRootsScript(options.maxFiles);
  const result = await execute(inputFor(options, processName, instance, script.script));
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    roots: parseRootsOutput(protocolStdout(result)),
  };
}

export async function findRemote(options: FindOptions): Promise<FindResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    return await findAllInstances(options);
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildFindScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    matches: parseFindOutput(protocolStdout(result), instance),
  };
}

export async function lsRemote(options: LsOptions): Promise<LsResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    return await lsAllInstances(options);
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildLsScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    path: options.path,
    entries: parseLsOutput(protocolStdout(result), instance),
  };
}

export async function grepRemote(options: GrepOptions): Promise<GrepResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    return await grepAllInstances(options);
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildGrepScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    matches: parseGrepOutput(protocolStdout(result), instance, options.preview === true),
  };
}

export async function viewRemote(options: ViewOptions): Promise<ViewResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    throw new CfExplorerError("UNSAFE_INPUT", "view supports one instance. Use --instance instead.");
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildViewScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  const lines = parseViewOutput(protocolStdout(result));
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    file: options.file,
    startLine: lines[0]?.line ?? options.line,
    endLine: lines.at(-1)?.line ?? options.line,
    lines,
  };
}

export async function inspectCandidates(
  options: InspectCandidatesOptions,
): Promise<InspectCandidatesResult> {
  const selector = resolveInstanceSelector(options);
  if (selector.allInstances === true) {
    return await inspectAllInstances(options);
  }
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildInspectCandidatesScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  const parsed = parseInspectOutput(protocolStdout(result), instance, false);
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, instance, result.durationMs, result.truncated),
    ...parsed,
  };
}

export async function createExplorer(options: CreateExplorerOptions): Promise<Explorer> {
  await Promise.resolve();
  const { target, process: processName, ...runtime } = options;
  const normalizedTarget = normalizeTarget(target);
  const defaultProcess = resolveProcessName(processName);
  return {
    roots: async (input = {}) => await roots({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    instances: async (input = {}) => await listInstances({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    ls: async (input) => await lsRemote({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    find: async (input) => await findRemote({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    grep: async (input) => await grepRemote({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    view: async (input) => await viewRemote({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    inspectCandidates: async (input) => await inspectCandidates({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    sshStatus: async (input = {}) => await sshStatus({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    enableSsh: async (input) => await enableSsh({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    restartApp: async (input) => await restartApp({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    prepareSsh: async (input) => await prepareSsh({ ...input, process: input.process ?? defaultProcess, target: normalizedTarget, runtime }),
    dispose: () => Promise.resolve(),
  };
}

async function rootsAllInstances(options: DiscoveryOptions): Promise<RootsResult> {
  const processName = resolveProcessName(options.process);
  const results = await runAcrossInstances(options, async (instance, context) => {
    const output = await executeWithContext(options, processName, instance, buildRootsScript(options.maxFiles).script, context);
    return { value: { roots: parseRootsOutput(protocolStdout(output)) }, truncated: output.truncated };
  });
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, undefined, sumDurations(results), hasTruncated(results)),
    roots: unique(results.flatMap((result) => result.result?.roots ?? [])),
    instances: results,
  };
}

async function findAllInstances(options: FindOptions): Promise<FindResult> {
  const processName = resolveProcessName(options.process);
  const results = await runAcrossInstances(options, async (instance, context) => {
    const output = await executeWithContext(options, processName, instance, buildFindScript(options).script, context);
    return { value: { matches: parseFindOutput(protocolStdout(output), instance) }, truncated: output.truncated };
  });
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, undefined, sumDurations(results), hasTruncated(results)),
    matches: results.flatMap((result) => result.result?.matches ?? []),
    instances: results,
  };
}

async function lsAllInstances(options: LsOptions): Promise<LsResult> {
  const processName = resolveProcessName(options.process);
  const results = await runAcrossInstances(options, async (instance, context) => {
    const output = await executeWithContext(options, processName, instance, buildLsScript(options).script, context);
    return {
      value: { path: options.path, entries: parseLsOutput(protocolStdout(output), instance) },
      truncated: output.truncated,
    };
  });
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, undefined, sumDurations(results), hasTruncated(results)),
    path: options.path,
    entries: results.flatMap((result) => result.result?.entries ?? []),
    instances: results,
  };
}

async function grepAllInstances(options: GrepOptions): Promise<GrepResult> {
  const processName = resolveProcessName(options.process);
  const results = await runAcrossInstances(options, async (instance, context) => {
    const output = await executeWithContext(options, processName, instance, buildGrepScript(options).script, context);
    return {
      value: { matches: parseGrepOutput(protocolStdout(output), instance, options.preview === true) },
      truncated: output.truncated,
    };
  });
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, undefined, sumDurations(results), hasTruncated(results)),
    matches: results.flatMap((result) => result.result?.matches ?? []),
    instances: results,
  };
}

async function inspectAllInstances(options: InspectCandidatesOptions): Promise<InspectCandidatesResult> {
  const processName = resolveProcessName(options.process);
  const results = await runAcrossInstances(options, async (instance, context) => {
    const output = await executeWithContext(options, processName, instance, buildInspectCandidatesScript(options).script, context);
    return { value: parseInspectOutput(protocolStdout(output), instance, false), truncated: output.truncated };
  });
  return {
    meta: buildMeta(normalizeTarget(options.target), processName, undefined, sumDurations(results), hasTruncated(results)),
    roots: unique(results.flatMap((result) => result.result?.roots ?? [])),
    files: results.flatMap((result) => result.result?.files ?? []),
    contentMatches: results.flatMap((result) => result.result?.contentMatches ?? []),
    suggestedBreakpoints: results.flatMap((result) => result.result?.suggestedBreakpoints ?? []),
    instances: results,
  };
}

async function runAcrossInstances<T>(
  options: DiscoveryOptions,
  work: (instance: number, context: CfCommandContext) => Promise<InstanceWorkResult<T>>,
): Promise<readonly InstanceResult<T>[]> {
  const instances = await listInstances({ ...options, allInstances: false });
  const running = instances.instances.filter((instance) => instance.state.toLowerCase() === "running");
  if (running.length === 0) {
    throw new CfExplorerError(
      "INSTANCE_NOT_FOUND",
      "No running instances were found for the target app.",
    );
  }
  // Share one prepared CF session across parallel SSH calls so we authenticate
  // once instead of once per instance.
  return await withPreparedCfSession(
    normalizeTarget(options.target),
    options.runtime,
    async (context) => {
      return await Promise.all(running.map(async (item) => await runInstance(item, async (instance) => await work(instance, context))));
    },
  );
}

async function runInstance<T>(
  item: InstanceInfo,
  work: (instance: number) => Promise<InstanceWorkResult<T>>,
): Promise<InstanceResult<T>> {
  const startedAt = Date.now();
  try {
    const result = await work(item.index);
    return {
      instance: item.index,
      ok: true,
      durationMs: Date.now() - startedAt,
      truncated: result.truncated,
      result: result.value,
    };
  } catch (error: unknown) {
    const explorerError = toExplorerError(error);
    return {
      instance: item.index,
      ok: false,
      durationMs: Date.now() - startedAt,
      truncated: false,
      error: { code: explorerError.code, message: explorerError.message },
    };
  }
}

async function execute(input: ExecuteInput): Promise<RemoteExecutionResult> {
  return await executeRemoteScript(input);
}

function protocolStdout(result: RemoteExecutionResult): string {
  if (!result.truncated || result.stdout.endsWith("\n") || result.stdout.endsWith("\r")) {
    return result.stdout;
  }
  const lastLineBreak = Math.max(result.stdout.lastIndexOf("\n"), result.stdout.lastIndexOf("\r"));
  return lastLineBreak < 0 ? "" : result.stdout.slice(0, lastLineBreak + 1);
}

async function executeWithContext(
  options: DiscoveryOptions,
  processName: string,
  instance: number,
  script: string,
  context: CfCommandContext,
): Promise<RemoteExecutionResult> {
  return await executeRemoteScriptWithContext(
    inputFor(options, processName, instance, script),
    context,
  );
}

function inputFor(
  options: DiscoveryOptions,
  processName: string,
  instance: number,
  script: string,
): ExecuteInput {
  return {
    target: normalizeTarget(options.target),
    processName,
    instance,
    script,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };
}

function buildMeta(
  target: ExplorerTarget,
  processName: string,
  instance: number | undefined,
  durationMs: number,
  truncated: boolean,
): ExplorerMeta {
  return {
    target,
    process: processName,
    ...(instance === undefined ? {} : { instance }),
    durationMs,
    truncated,
  };
}

function sumDurations(results: readonly InstanceResult<unknown>[]): number {
  return results.reduce((total, result) => total + result.durationMs, 0);
}

function hasTruncated(results: readonly InstanceResult<unknown>[]): boolean {
  return results.some((result) => result.truncated);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function effectiveRunLimits(options: DiscoveryOptions): CfRunOptions {
  const timeoutMs = options.timeoutMs ?? options.runtime?.timeoutMs;
  const maxBytes = options.maxBytes ?? options.runtime?.maxBytes;
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}
