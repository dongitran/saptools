import { describe, expect, it } from "vitest";

import { runWriteTest } from "../../src/diagnostics/write-test.js";
import { GraphHttpError } from "../../src/graph/client.js";
import type { GraphClient, GraphRequestOptions } from "../../src/graph/client.js";

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function writeClient(responses: readonly unknown[], calls: Call[]): GraphClient {
  let idx = 0;
  return {
    baseUrl: "http://fake",
    request: async <T>(path: string, options?: GraphRequestOptions): Promise<T> => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body });
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

  it("normalizes root paths before creating the probe", async () => {
    const calls: Call[] = [];
    const c = writeClient(
      [{ id: "probe-id", name: "probe", folder: { childCount: 0 } }, undefined],
      calls,
    );
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "/Apps/" });
    expect(result.probePath).toMatch(/^Apps\/sharepoint-check-probe-/);
    expect(calls[0]?.path).toBe("/drives/d1/root:/Apps:/children");
  });

  it("honors a custom probe prefix", async () => {
    const calls: Call[] = [];
    const c = writeClient(
      [{ id: "probe-id", name: "probe", folder: { childCount: 0 } }, undefined],
      calls,
    );
    const result = await runWriteTest(c, {
      driveId: "d1",
      rootPath: "Apps",
      probePrefix: "custom-probe-",
    });
    expect(result.probePath).toMatch(/^Apps\/custom-probe-/);
    expect(calls[0]?.body).toMatchObject({ name: expect.stringMatching(/^custom-probe-/) });
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

  it("reports plain Error messages from create failures", async () => {
    const c = writeClient([new Error("plain create failure")], []);
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "Apps" });
    expect(result.created).toBe(false);
    expect(result.error).toBe("plain create failure");
  });

  it("reports plain Error messages from delete failures", async () => {
    const c = writeClient(
      [{ id: "probe-id", name: "probe", folder: { childCount: 0 } }, new Error("plain delete failure")],
      [],
    );
    const result = await runWriteTest(c, { driveId: "d1", rootPath: "Apps" });
    expect(result.created).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.error).toBe("plain delete failure");
  });
});
