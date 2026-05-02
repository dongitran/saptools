import { describe, expect, it } from "vitest";

import { walkFolderTree } from "../../src/diagnostics/tree.js";
import type { GraphClient, GraphRequestOptions } from "../../src/graph/client.js";

interface Node {
  readonly name: string;
  readonly isFolder: boolean;
  readonly size?: number;
  readonly children?: readonly Node[];
}

function treeClient(structure: Readonly<Record<string, readonly Node[]>>): GraphClient {
  return {
    baseUrl: "http://fake",
    request: async <T>(path: string, _options?: GraphRequestOptions): Promise<T> => {
      const rootMatch = /^\/drives\/[^/]+\/root\/children$/.exec(path);
      if (rootMatch) {
        return { value: (structure[""] ?? []).map(mapNode) } as T;
      }
      const nestedMatch = /^\/drives\/[^/]+\/root:\/(.+):\/children$/.exec(path);
      if (!nestedMatch) {
        throw new Error(`Unexpected path ${path}`);
      }
      const decoded = decodeURIComponent(nestedMatch[1] ?? "");
      return { value: (structure[decoded] ?? []).map(mapNode) } as T;
    },
  };

  function mapNode(node: Node): unknown {
    return node.isFolder
      ? {
          id: node.name,
          name: node.name,
          size: node.size ?? 0,
          folder: { childCount: (node.children ?? []).length },
        }
      : { id: node.name, name: node.name, size: node.size ?? 0, file: { mimeType: "text/plain" } };
  }
}

describe("walkFolderTree", () => {
  it("counts files and folders at each level", async () => {
    const client = treeClient({
      "": [
        { name: "Apps", isFolder: true, children: [] },
        { name: "readme.md", isFolder: false, size: 10 },
      ],
      Apps: [
        { name: "sample-app", isFolder: true, children: [] },
        { name: "demo-app", isFolder: true, children: [] },
        { name: "notes.txt", isFolder: false, size: 5 },
      ],
      "Apps/sample-app": [{ name: "a.txt", isFolder: false, size: 3 }],
      "Apps/demo-app": [],
    });

    const tree = await walkFolderTree(client, { driveId: "d1", rootPath: "", limits: { maxDepth: 3 } });
    expect(tree.fileCount).toBe(1);
    expect(tree.folderCount).toBe(1);
    const apps = tree.children[0];
    expect(apps?.name).toBe("Apps");
    expect(apps?.folderCount).toBe(2);
    expect(apps?.fileCount).toBe(1);
    const sample = apps?.children.find((c) => c.name === "sample-app");
    expect(sample?.fileCount).toBe(1);
  });

  it("respects maxDepth (returns stub leaves for deeper folders)", async () => {
    const client = treeClient({
      root: [{ name: "deep", isFolder: true, children: [] }],
      "root/deep": [{ name: "more", isFolder: true, children: [] }],
      "root/deep/more": [{ name: "file.txt", isFolder: false, size: 1 }],
    });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "root",
      limits: { maxDepth: 1 },
    });
    const deep = tree.children[0];
    expect(deep?.children[0]?.name).toBe("more");
    expect(deep?.children[0]?.children).toHaveLength(0);
  });

  it("normalizes the root path and uses the final segment as the root name", async () => {
    const client = treeClient({
      "Apps/alpha": [{ name: "readme.md", isFolder: false, size: 1 }],
    });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "/Apps/alpha/",
    });
    expect(tree.name).toBe("alpha");
    expect(tree.path).toBe("Apps/alpha");
    expect(tree.fileCount).toBe(1);
  });

  it("clamps maxEntriesPerFolder to the requested window", async () => {
    const many: Node[] = Array.from({ length: 10 }, (_, i) => ({
      name: `file-${i.toString()}.txt`,
      isFolder: false,
      size: 1,
    }));
    const client = treeClient({ "": many });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "",
      limits: { maxEntriesPerFolder: 3 },
    });
    expect(tree.fileCount).toBe(3);
  });

  it("stops descending once maxTotalEntries budget is exhausted", async () => {
    const children = Array.from({ length: 20 }, (_, i) => ({
      name: `entry-${i.toString()}`,
      isFolder: false as const,
      size: 1,
    }));
    const client = treeClient({ "": children });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "",
      limits: { maxTotalEntries: 5 },
    });
    expect(tree.fileCount).toBe(5);
  });

  it("clamps invalid limits to a safe minimum", async () => {
    const client = treeClient({
      "": [
        { name: "folder-a", isFolder: true, children: [{ name: "nested.txt", isFolder: false }] },
        { name: "folder-b", isFolder: true, children: [] },
      ],
      "folder-a": [{ name: "nested.txt", isFolder: false, size: 1 }],
    });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "",
      limits: { maxDepth: -5, maxEntriesPerFolder: 0, maxTotalEntries: 0 },
    });
    expect(tree.folderCount).toBe(1);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.children).toHaveLength(0);
  });

  it("adds folder entry sizes to parent totals", async () => {
    const client = treeClient({
      "": [{ name: "archive", isFolder: true, size: 99, children: [] }],
    });
    const tree = await walkFolderTree(client, {
      driveId: "d1",
      rootPath: "",
      limits: { maxDepth: 0 },
    });
    expect(tree.totalSize).toBe(99);
  });
});
