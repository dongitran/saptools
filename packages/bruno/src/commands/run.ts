import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AppRef } from "@saptools/cf-xsuaa";
import { getTokenCached as getTokenCachedApi } from "@saptools/cf-xsuaa";

import { upsertVars } from "../bruno/writer.js";
import { readCfMetaFromFile } from "../cf/meta.js";
import type { ShorthandRef } from "../collection/folder-scan.js";
import { parseShorthandPath, scanCollection } from "../collection/folder-scan.js";
import {
  ENVIRONMENTS_DIR,
  orgFolderName,
  regionFolderName,
  spaceFolderName,
} from "../collection/paths.js";

export type GetTokenCachedFn = (ref: AppRef) => Promise<string>;

export interface RunSpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnBruFn = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<RunSpawnResult>;

export interface RunOptions {
  readonly root: string;
  readonly target: string;
  readonly environment?: string;
  readonly extraArgs?: readonly string[];
  readonly getTokenCached?: GetTokenCachedFn;
  readonly spawnBru?: SpawnBruFn;
  readonly log?: (msg: string) => void;
}

export interface RunPlan {
  readonly filePath: string;
  readonly environment: string;
  readonly envFile: string;
  readonly meta: { readonly region: string; readonly org: string; readonly space: string; readonly app: string };
  readonly token: string;
  readonly bruArgs: readonly string[];
  readonly cwd: string;
}

export interface RunResult extends RunPlan {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const require = createRequire(import.meta.url);

export interface BruRuntime {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

export interface ResolveBruRuntimeDeps {
  readonly findOnPath?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly resolvePackageJsonPath?: () => string;
}

function pathEntries(env: NodeJS.ProcessEnv): readonly string[] {
  const value = env["PATH"] ?? process.env["PATH"] ?? "";
  return value.split(delimiter).filter((entry) => entry.length > 0);
}

function pathCandidates(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== "win32" || command.includes(".")) {
    return [command];
  }
  const pathExt =
    env["PATHEXT"]?.split(";").filter((entry) => entry.length > 0) ?? [".COM", ".EXE", ".BAT", ".CMD"];
  return [command, ...pathExt.map((ext) => `${command}${ext}`)];
}

async function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = pathCandidates(command, env);
  for (const entry of pathEntries(env)) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (await exists(fullPath)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bruBinRelativePath(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bin = value["bin"];
  if (typeof bin === "string") {
    return bin;
  }
  if (!isRecord(bin)) {
    return undefined;
  }
  const bru = bin["bru"];
  return typeof bru === "string" ? bru : undefined;
}

function defaultResolvePackageJsonPath(): string {
  return require.resolve("@usebruno/cli/package.json");
}

async function defaultReadTextFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function resolveBundledBruBinPath(
  deps: ResolveBruRuntimeDeps,
): Promise<string | undefined> {
  try {
    const packageJsonPath = (deps.resolvePackageJsonPath ?? defaultResolvePackageJsonPath)();
    const raw = await (deps.readTextFile ?? defaultReadTextFile)(packageJsonPath);
    const binPath = bruBinRelativePath(JSON.parse(raw) as unknown);
    if (!binPath) {
      return undefined;
    }
    return resolve(dirname(packageJsonPath), binPath);
  } catch {
    return undefined;
  }
}

export async function resolveBruRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveBruRuntimeDeps = {},
): Promise<BruRuntime> {
  const onPath = await (deps.findOnPath ?? findCommandOnPath)("bru", env);
  if (onPath) {
    return { command: onPath, argsPrefix: [] };
  }
  const bundledBin = await resolveBundledBruBinPath(deps);
  if (bundledBin) {
    return { command: process.execPath, argsPrefix: [bundledBin] };
  }
  throw new Error(
    "Unable to find Bruno CLI. Install @usebruno/cli or ensure `bru` is available on PATH.",
  );
}

async function defaultSpawnBru(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunSpawnResult> {
  const runtime = await resolveBruRuntime(env);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runtime.command, [...runtime.argsPrefix, ...args], { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveTarget(
  root: string,
  target: string,
): Promise<{ readonly filePath: string; readonly shorthand: ShorthandRef | undefined }> {
  const direct = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (await exists(direct)) {
    return { filePath: direct, shorthand: undefined };
  }

  const shorthand = parseShorthandPath(target);
  if (!shorthand) {
    throw new Error(`Target not found: ${target}`);
  }

  const { region, org, space, app, filePath } = shorthand;
  const appDir = join(
    root,
    regionFolderName(region),
    orgFolderName(org),
    spaceFolderName(space),
    app,
  );

  if (!filePath) {
    return { filePath: appDir, shorthand };
  }

  const candidate = join(appDir, filePath);
  if (await exists(candidate)) {
    return { filePath: candidate, shorthand };
  }

  const withExt = candidate.endsWith(".bru") ? candidate : `${candidate}.bru`;
  if (await exists(withExt)) {
    return { filePath: withExt, shorthand };
  }

  throw new Error(`File not found: ${candidate}`);
}

async function chooseEnvironmentFile(
  appDir: string,
  environment: string | undefined,
): Promise<{ readonly envFile: string; readonly environment: string }> {
  if (environment) {
    const envFile = join(appDir, ENVIRONMENTS_DIR, `${environment}.bru`);
    if (!(await exists(envFile))) {
      throw new Error(`Environment file not found: ${envFile}`);
    }
    return { envFile, environment };
  }

  const collection = await scanCollection(resolve(appDir, "..", "..", "..", ".."));
  for (const region of collection.regions) {
    for (const org of region.orgs) {
      for (const space of org.spaces) {
        for (const app of space.apps) {
          if (app.path === appDir && app.environments.length > 0) {
            const first = app.environments[0];
            if (first) {
              return { envFile: first.path, environment: first.name };
            }
          }
        }
      }
    }
  }
  throw new Error(`No environment files found under ${appDir}/${ENVIRONMENTS_DIR}`);
}

function findAppDirFromFile(filePath: string, root: string): string {
  const rel = relative(root, filePath).split(sep);
  if (rel.length < 4) {
    throw new Error(`File is not inside a CF-structured bruno collection: ${filePath}`);
  }
  const [regionDir, orgDir, spaceDir, appDir] = rel;
  if (!regionDir || !orgDir || !spaceDir || !appDir) {
    throw new Error(`File is not inside a CF-structured bruno collection: ${filePath}`);
  }
  return join(root, regionDir, orgDir, spaceDir, appDir);
}

async function persistAccessToken(envFile: string, token: string): Promise<void> {
  const raw = await readFile(envFile, "utf8");
  const { content, changed } = upsertVars(raw, new Map([["accessToken", token]]));
  if (changed) {
    await writeFile(envFile, content, "utf8");
  }
}

export async function buildRunPlan(options: RunOptions): Promise<RunPlan> {
  const { filePath } = await resolveTarget(options.root, options.target);
  const stats = await stat(filePath);

  let appDir: string;
  let requestFile: string | undefined;

  if (stats.isDirectory()) {
    appDir = filePath;
    requestFile = undefined;
  } else {
    appDir = findAppDirFromFile(filePath, options.root);
    requestFile = filePath;
  }

  const { envFile, environment } = await chooseEnvironmentFile(appDir, options.environment);

  const meta = await readCfMetaFromFile(envFile);
  if (!meta) {
    throw new Error(
      `Missing __cf_region/__cf_org/__cf_space/__cf_app in ${envFile}. Run \`saptools-bruno setup-app\` first.`,
    );
  }

  const getToken = options.getTokenCached ?? getTokenCachedApi;
  const token = await getToken(meta);
  await persistAccessToken(envFile, token);

  const bruArgs: string[] = ["run"];
  if (requestFile) {
    bruArgs.push(relative(appDir, requestFile) || ".");
  }
  bruArgs.push("--env", environment, "--env-var", `accessToken=${token}`);
  if (options.extraArgs) {
    bruArgs.push(...options.extraArgs);
  }

  return {
    filePath,
    environment,
    envFile,
    meta,
    token,
    bruArgs,
    cwd: appDir,
  };
}

export async function runBruno(options: RunOptions): Promise<RunResult> {
  const plan = await buildRunPlan(options);
  const spawnFn = options.spawnBru ?? defaultSpawnBru;
  const env: NodeJS.ProcessEnv = { ...process.env, SAPTOOLS_ACCESS_TOKEN: plan.token };
  options.log?.(`▶ bru ${plan.bruArgs.join(" ")}  (cwd=${plan.cwd})`);
  const result = await spawnFn(plan.bruArgs, env, plan.cwd);
  return { ...plan, ...result };
}
