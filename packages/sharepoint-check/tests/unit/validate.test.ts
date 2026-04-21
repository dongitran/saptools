import { describe, expect, it } from "vitest";

import { GraphHttpError } from "../../src/graph.js";
import type { GraphClient } from "../../src/graph.js";
import { validateLayout } from "../../src/validate.js";

function client(mapping: Readonly<Record<string, unknown>>): GraphClient {
  return {
    baseUrl: "http://fake",
    request: async <T>(path: string): Promise<T> => {
      const match = /^\/drives\/[^/]+\/root(?::\/(.+))?$/.exec(path);
      if (!match) {
        throw new Error(`unexpected path ${path}`);
      }
      const key = match[1] === undefined ? "" : decodeURIComponent(match[1]);
      if (!(key in mapping)) {
        throw new GraphHttpError(404, "itemNotFound", "missing");
      }
      return mapping[key] as T;
    },
  };
}

describe("validateLayout", () => {
  it("marks all present when root + subdirs exist as folders", async () => {
    const c = client({
      Apps: { id: "a", name: "Apps", folder: { childCount: 2 } },
      "Apps/sample": { id: "b", name: "sample", folder: { childCount: 0 } },
      "Apps/demo": { id: "c", name: "demo", folder: { childCount: 0 } },
    });
    const result = await validateLayout(c, "d1", {
      rootPath: "Apps",
      subdirectories: ["sample", "demo"],
    });
    expect(result.allPresent).toBe(true);
    expect(result.subdirectories).toHaveLength(2);
  });

  it("flags missing subdirectories as exists=false", async () => {
    const c = client({
      Apps: { id: "a", name: "Apps", folder: { childCount: 0 } },
    });
    const result = await validateLayout(c, "d1", {
      rootPath: "Apps",
      subdirectories: ["ghost"],
    });
    expect(result.allPresent).toBe(false);
    expect(result.subdirectories[0]?.exists).toBe(false);
    expect(result.subdirectories[0]?.path).toBe("Apps/ghost");
  });

  it("flags when root is a file rather than a folder", async () => {
    const c = client({
      docs: { id: "a", name: "docs", size: 10, file: { mimeType: "text/plain" } },
    });
    const result = await validateLayout(c, "d1", { rootPath: "docs", subdirectories: [] });
    expect(result.root.exists).toBe(true);
    expect(result.root.isFolder).toBe(false);
    expect(result.allPresent).toBe(false);
  });
});
