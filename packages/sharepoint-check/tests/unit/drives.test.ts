import { describe, expect, it } from "vitest";

import {
  createFolder,
  deleteItem,
  getDriveItemByPath,
  listDriveChildren,
  listDriveRoot,
  listDrives,
} from "../../src/drives.js";
import { GraphHttpError } from "../../src/graph.js";
import type { GraphClient, GraphRequestOptions } from "../../src/graph.js";

interface Call {
  readonly path: string;
  readonly options: GraphRequestOptions | undefined;
}

function scriptedClient(
  responses: readonly unknown[],
  calls: Call[],
): GraphClient {
  let index = 0;
  return {
    baseUrl: "http://fake",
    request: async <T>(path: string, options?: GraphRequestOptions): Promise<T> => {
      calls.push({ path, options });
      const current = responses[index];
      index += 1;
      if (current instanceof Error) {
        throw current;
      }
      return current as T;
    },
  };
}

describe("listDrives", () => {
  it("maps /drives response into SharePointDrive[]", async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      [
        {
          value: [
            { id: "d1", name: "Documents", driveType: "documentLibrary", webUrl: "http://x" },
            { id: "d2", name: "Shared" },
          ],
        },
      ],
      calls,
    );
    const drives = await listDrives(client, "site-1");
    expect(calls[0]?.path).toBe("/sites/site-1/drives");
    expect(drives).toHaveLength(2);
    expect(drives[1]?.driveType).toBe("documentLibrary");
  });

  it("returns [] when value is missing", async () => {
    const client = scriptedClient([{}], []);
    const drives = await listDrives(client, "site-1");
    expect(drives).toEqual([]);
  });
});

describe("listDriveChildren / listDriveRoot", () => {
  it("hits the root endpoint when relativePath is empty", async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      [
        {
          value: [{ id: "f1", name: "a", folder: { childCount: 2 } }, { id: "f2", name: "b.txt", size: 10 }],
        },
      ],
      calls,
    );
    const entries = await listDriveChildren(client, "d1", "");
    expect(calls[0]?.path).toBe("/drives/d1/root/children");
    expect(entries[0]?.isFolder).toBe(true);
    expect(entries[0]?.childCount).toBe(2);
    expect(entries[1]?.isFolder).toBe(false);
  });

  it("encodes each path segment", async () => {
    const calls: Call[] = [];
    const client = scriptedClient([{ value: [] }], calls);
    await listDriveChildren(client, "d1", "Apps/a b/c");
    expect(calls[0]?.path).toBe("/drives/d1/root:/Apps/a%20b/c:/children");
  });

  it("follows @odata.nextLink pagination", async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      [
        { value: [{ id: "1", name: "x" }], "@odata.nextLink": "https://api/next" },
        { value: [{ id: "2", name: "y" }] },
      ],
      calls,
    );
    const entries = await listDriveRoot(client, "d1");
    expect(entries.map((e) => e.id)).toEqual(["1", "2"]);
    expect(calls[1]?.path).toBe("https://api/next");
  });
});

describe("getDriveItemByPath", () => {
  it("returns null on 404", async () => {
    const client = scriptedClient([new GraphHttpError(404, "itemNotFound", "missing")], []);
    const result = await getDriveItemByPath(client, "d1", "nope");
    expect(result).toBeNull();
  });

  it("propagates other errors", async () => {
    const client = scriptedClient([new GraphHttpError(500, "serverError", "boom")], []);
    await expect(getDriveItemByPath(client, "d1", "x")).rejects.toThrow(/500/);
  });

  it("returns the item on success", async () => {
    const client = scriptedClient([{ id: "x", name: "y", folder: { childCount: 0 } }], []);
    const item = await getDriveItemByPath(client, "d1", "y");
    expect(item?.name).toBe("y");
  });

  it("queries /root when path is empty", async () => {
    const calls: Call[] = [];
    const client = scriptedClient([{ id: "r", name: "root", folder: { childCount: 5 } }], calls);
    await getDriveItemByPath(client, "d1", "");
    expect(calls[0]?.path).toBe("/drives/d1/root");
  });
});

describe("createFolder / deleteItem", () => {
  it("POSTs a conflictBehavior=fail folder body", async () => {
    const calls: Call[] = [];
    const client = scriptedClient([{ id: "new", name: "probe", folder: { childCount: 0 } }], calls);
    const created = await createFolder(client, "d1", "Apps", "probe");
    expect(calls[0]?.path).toBe("/drives/d1/root:/Apps:/children");
    expect(calls[0]?.options?.method).toBe("POST");
    expect(created.id).toBe("new");
  });

  it("creates at drive root when parent is empty", async () => {
    const calls: Call[] = [];
    const client = scriptedClient([{ id: "new", name: "probe", folder: { childCount: 0 } }], calls);
    await createFolder(client, "d1", "", "probe");
    expect(calls[0]?.path).toBe("/drives/d1/root/children");
  });

  it("sends DELETE for deleteItem", async () => {
    const calls: Call[] = [];
    const client = scriptedClient([undefined], calls);
    await deleteItem(client, "d1", "item-42");
    expect(calls[0]?.path).toBe("/drives/d1/items/item-42");
    expect(calls[0]?.options?.method).toBe("DELETE");
    expect(calls[0]?.options?.expectJson).toBe(false);
  });
});
