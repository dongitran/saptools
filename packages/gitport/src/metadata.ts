import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import { latestRunPath } from "./paths.js";
import type { RunMetadata } from "./types.js";

export interface MetadataOptions {
  readonly workRoot?: string | undefined;
}

export interface WriteRunMetadataOptions extends MetadataOptions {
  readonly metadata: RunMetadata;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function parseRunMetadata(value: unknown): RunMetadata {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.MetadataFailed, "Run metadata is not an object");
  }
  const runId = value["runId"];
  const runDir = value["runDir"];
  const destDir = value["destDir"];
  const status = value["status"];
  const sourceRepo = value["sourceRepo"];
  const destRepo = value["destRepo"];
  const sourceMergeRequestIid = value["sourceMergeRequestIid"];
  const baseBranch = value["baseBranch"];
  const portBranch = value["portBranch"];
  if (
    typeof runId !== "string" ||
    typeof runDir !== "string" ||
    typeof destDir !== "string" ||
    typeof status !== "string" ||
    typeof sourceRepo !== "string" ||
    typeof destRepo !== "string" ||
    typeof sourceMergeRequestIid !== "number" ||
    typeof baseBranch !== "string" ||
    typeof portBranch !== "string"
  ) {
    throw new GitportError(GITPORT_ERROR_CODE.MetadataFailed, "Run metadata is missing fields");
  }

  return {
    runId,
    runDir,
    destDir,
    status: status as RunMetadata["status"],
    sourceRepo,
    destRepo,
    sourceMergeRequestIid,
    baseBranch,
    portBranch,
    ...(typeof value["mergeRequestUrl"] === "string"
      ? { mergeRequestUrl: value["mergeRequestUrl"] }
      : {}),
    ...(typeof value["mergeRequestIid"] === "number"
      ? { mergeRequestIid: value["mergeRequestIid"] }
      : {}),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function writeRunMetadata(options: WriteRunMetadataOptions): Promise<void> {
  const metadataPath = `${options.metadata.runDir}/metadata.json`;
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(options.metadata, null, 2)}\n`, "utf8");
  const latestPath = latestRunPath(options.workRoot);
  await mkdir(dirname(latestPath), { recursive: true });
  await writeFile(latestPath, `${JSON.stringify({ metadataPath }, null, 2)}\n`, "utf8");
}

export async function readLatestRunMetadata(
  options: MetadataOptions = {},
): Promise<RunMetadata | undefined> {
  try {
    const latest = await readJson(latestRunPath(options.workRoot));
    if (!isRecord(latest) || typeof latest["metadataPath"] !== "string") {
      throw new GitportError(GITPORT_ERROR_CODE.MetadataFailed, "Latest run pointer is invalid");
    }
    return parseRunMetadata(await readJson(latest["metadataPath"]));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
