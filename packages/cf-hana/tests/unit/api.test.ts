import { readDbAppView } from "@saptools/cf-sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connect, query, withConnection } from "../../src/api.js";

import { sampleBinding, sampleDbAppView } from "./fixtures/samples.js";

vi.mock("@saptools/cf-sync", () => ({
  readDbAppView: vi.fn(),
  fetchAppDbBindings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readDbAppView).mockResolvedValue(sampleDbAppView([sampleBinding()]));
  vi.stubEnv("CF_HANA_DRIVER", "fake");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("api", () => {
  it("connect() opens a reusable client", async () => {
    const client = await connect("orders-srv");
    expect(client.info.appName).toBe("orders-srv");
    await client.close();
  });

  it("query() runs a one-shot query and closes the client", async () => {
    const result = await query("orders-srv", "SELECT 1 FROM DUMMY");
    expect(result.rows).toEqual([{ "1": 1 }]);
  });

  it("withConnection() runs work and closes the client afterwards", async () => {
    const schema = await withConnection("orders-srv", (client) =>
      Promise.resolve(client.info.schema),
    );
    expect(schema).toBe("APP_SCHEMA");
  });
});
