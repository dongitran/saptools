import { randomBytes } from "node:crypto";

import type { GraphClient } from "../graph/client.js";
import { GraphHttpError } from "../graph/client.js";
import { createFolder, deleteItem } from "../graph/drives.js";
import type { WriteTestResult } from "../types.js";

const MISSING_CREATED_ID_ERROR = "Write probe folder was created but Graph did not return an item id";

export interface WriteTestOptions {
  readonly driveId: string;
  readonly rootPath?: string;
  readonly probePrefix?: string;
}

function buildProbeName(prefix: string): string {
  const stamp = Date.now().toString(36);
  const suffix = randomBytes(6).toString("hex");
  return `${prefix}${stamp}-${suffix}`;
}

function joinPath(parent: string, child: string): string {
  if (parent.length === 0) {
    return child;
  }
  return `${parent}/${child}`;
}

export async function runWriteTest(
  client: GraphClient,
  options: WriteTestOptions,
): Promise<WriteTestResult> {
  const rootPath = (options.rootPath ?? "").replace(/^\/+|\/+$/g, "");
  const prefix = options.probePrefix ?? "sharepoint-check-probe-";
  const folderName = buildProbeName(prefix);
  const probePath = joinPath(rootPath, folderName);

  let createdId: string | undefined;
  try {
    const created = await createFolder(client, options.driveId, rootPath, folderName);
    createdId = created.id;
    if (createdId.length === 0) {
      return {
        created: true,
        deleted: false,
        probePath,
        error: MISSING_CREATED_ID_ERROR,
      };
    }
  } catch (err) {
    const message = err instanceof GraphHttpError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      created: false,
      deleted: false,
      probePath,
      error: message,
    };
  }

  try {
    await deleteItem(client, options.driveId, createdId);
    return {
      created: true,
      deleted: true,
      probePath,
      itemId: createdId,
    };
  } catch (err) {
    const message = err instanceof GraphHttpError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      created: true,
      deleted: false,
      probePath,
      itemId: createdId,
      error: message,
    };
  }
}
