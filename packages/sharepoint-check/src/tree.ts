import { listDriveChildren } from "./drives.js";
import type { GraphClient } from "./graph.js";
import { DEFAULT_TREE_LIMITS } from "./types.js";
import type { DriveItemSummary, FolderTreeNode, TreeWalkLimits } from "./types.js";

export interface WalkFolderTreeOptions {
  readonly driveId: string;
  readonly rootPath?: string;
  readonly limits?: Partial<TreeWalkLimits>;
}

function joinPath(parent: string, child: string): string {
  if (parent.length === 0) {
    return child;
  }
  return `${parent}/${child}`;
}

function resolveLimits(provided?: Partial<TreeWalkLimits>): TreeWalkLimits {
  const maxDepth = provided?.maxDepth ?? DEFAULT_TREE_LIMITS.maxDepth;
  const maxEntriesPerFolder = provided?.maxEntriesPerFolder ?? DEFAULT_TREE_LIMITS.maxEntriesPerFolder;
  const maxTotalEntries = provided?.maxTotalEntries ?? DEFAULT_TREE_LIMITS.maxTotalEntries;

  return {
    maxDepth: Math.max(0, Math.floor(maxDepth)),
    maxEntriesPerFolder: Math.max(1, Math.floor(maxEntriesPerFolder)),
    maxTotalEntries: Math.max(1, Math.floor(maxTotalEntries)),
  };
}

interface WalkBudget {
  remaining: number;
}

async function walkFolder(
  client: GraphClient,
  driveId: string,
  path: string,
  name: string,
  depth: number,
  limits: TreeWalkLimits,
  budget: WalkBudget,
): Promise<FolderTreeNode> {
  const rawEntries = await listDriveChildren(client, driveId, path);
  const entries: readonly DriveItemSummary[] = rawEntries.slice(0, limits.maxEntriesPerFolder);

  let fileCount = 0;
  let folderCount = 0;
  let totalSize = 0;
  const children: FolderTreeNode[] = [];

  for (const entry of entries) {
    if (budget.remaining <= 0) {
      break;
    }
    budget.remaining -= 1;
    totalSize += entry.size;
    if (entry.isFolder) {
      folderCount += 1;
      if (depth < limits.maxDepth && budget.remaining > 0) {
        const child = await walkFolder(
          client,
          driveId,
          joinPath(path, entry.name),
          entry.name,
          depth + 1,
          limits,
          budget,
        );
        children.push(child);
      } else {
        children.push({
          name: entry.name,
          path: joinPath(path, entry.name),
          fileCount: 0,
          folderCount: 0,
          totalSize: entry.size,
          children: [],
        });
      }
    } else {
      fileCount += 1;
    }
  }

  return {
    name,
    path,
    fileCount,
    folderCount,
    totalSize,
    children,
  };
}

export async function walkFolderTree(
  client: GraphClient,
  options: WalkFolderTreeOptions,
): Promise<FolderTreeNode> {
  const limits = resolveLimits(options.limits);
  const rootPath = (options.rootPath ?? "").replace(/^\/+|\/+$/g, "");
  const name = rootPath.length === 0 ? "/" : (rootPath.split("/").pop() ?? rootPath);
  const budget: WalkBudget = { remaining: limits.maxTotalEntries };
  return await walkFolder(client, options.driveId, rootPath, name, 0, limits, budget);
}
