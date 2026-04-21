import { describe, expect, it } from "vitest";

import { GraphHttpError } from "../../src/graph.js";
import type { GraphClient, GraphRequestOptions } from "../../src/graph.js";
import { runWriteTest } from "../../src/write-test.js";

interface Call {
  readonly path: string;
  readonly method: string;
}

function writeClient(responses: readonly unknown[], calls: Call[]): GraphClient {
  let idx = 0;
  return {
    baseUrl: "http://fake",
    request: async <T>(path: string, options?: GraphRequestOptions): Promise<T> => {
      calls.push({ path, method: options?.method ?? "GET" });
      const current = responses[idx];
      idx += 1;
      if (current instanceof Error) {
        throw current;
      }
      return current as T;
    },
  };
}

describe("runWriteTest", () => {
  it("creates then deletes a probe folder on success", async () => {
    const calls: Call[] = [];
    const c = writeClient(
      [{ id: "probe-id", name: "probe", folder: { childCount: 0 } }, undefined],
      calls,
    );
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "Apps" });
    expect(result.created).toBe(true);
    expect(result.deleted).toBe(true);
    expect(result.itemId).toBe("probe-id");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.method).toBe("DELETE");
  });

  it("reports created=false when folder creation fails", async () => {
    const c = writeClient([new GraphHttpError(403, "accessDenied", "no write")], []);
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "Apps" });
    expect(result.created).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.error).toContain("accessDenied");
  });

  it("reports deleted=false when cleanup fails (leaving the probe behind)", async () => {
    const c = writeClient(
      [
        { id: "probe-id", name: "probe", folder: { childCount: 0 } },
        new GraphHttpError(500, "internalError", "boom"),
      ],
      [],
    );
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "Apps" });
    expect(result.created).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.itemId).toBe("probe-id");
    expect(result.error).toContain("500");
  });
});
