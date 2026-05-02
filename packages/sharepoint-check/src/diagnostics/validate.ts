import type { GraphClient } from "../graph/client.js";
import { getDriveItemByPath } from "../graph/drives.js";
import type { ValidateExpectation, ValidateResult, ValidateResultEntry } from "../types.js";

function joinPath(parent: string, child: string): string {
  const normalizedParent = parent.replace(/^\/+|\/+$/g, "");
  const normalizedChild = child.replace(/^\/+|\/+$/g, "");
  if (normalizedParent.length === 0) {
    return normalizedChild;
  }
  if (normalizedChild.length === 0) {
    return normalizedParent;
  }
  return `${normalizedParent}/${normalizedChild}`;
}

async function probe(
  client: GraphClient,
  driveId: string,
  path: string,
): Promise<ValidateResultEntry> {
  const item = await getDriveItemByPath(client, driveId, path);
  return {
    path,
    exists: item !== null,
    isFolder: item?.isFolder ?? false,
  };
}

export async function validateLayout(
  client: GraphClient,
  driveId: string,
  expectation: ValidateExpectation,
): Promise<ValidateResult> {
  const rootPath = expectation.rootPath.replace(/^\/+|\/+$/g, "");
  const root = await probe(client, driveId, rootPath);

  const subdirectories: ValidateResultEntry[] = [];
  for (const sub of expectation.subdirectories) {
    const fullPath = joinPath(rootPath, sub);
    subdirectories.push(await probe(client, driveId, fullPath));
  }

  const allPresent =
    root.exists &&
    root.isFolder &&
    subdirectories.every((entry) => entry.exists && entry.isFolder);

  return {
    root,
    subdirectories,
    allPresent,
  };
}
