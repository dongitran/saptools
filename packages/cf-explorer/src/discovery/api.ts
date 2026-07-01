import { cfApp, type CfRunOptions } from "../cf/client.js";
import { sshStatus, enableSsh, prepareSsh, restartApp } from "../cf/lifecycle.js";
import { normalizeTarget, resolveInstance, resolveInstanceSelector, resolveProcessName } from "../cf/target.js";
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
  const processName = selector.process ?? "web";
  const instance = resolveInstance(selector.instance);
  const script = buildInspectCandidatesScript(options);
  const result = await execute(inputFor(options, processName, instance, script.script));
  const parsed = parseInspectOutput(protocolStdout(result), instance, false, options.includeFiles === true);
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

function effectiveRunLimits(options: DiscoveryOptions): CfRunOptions | undefined {
  const timeoutMs = options.timeoutMs ?? options.runtime?.timeoutMs;
  const maxBytes = options.maxBytes ?? options.runtime?.maxBytes;
  if (timeoutMs === undefined && maxBytes === undefined) {
    return undefined;
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}
