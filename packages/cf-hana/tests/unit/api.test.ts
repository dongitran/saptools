import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDbAppView } from "@saptools/cf-sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connect, query, withConnection } from "../../src/api.js";

import { sampleBinding, sampleDbAppView } from "./fixtures/samples.js";

vi.mock("@saptools/cf-sync", () => ({
  readDbAppView: vi.fn(),
  fetchAppDbBindings: vi.fn(),
}));

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cf-hana-api-"));
  vi.mocked(readDbAppView).mockResolvedValue(sampleDbAppView([sampleBinding()]));
  vi.stubEnv("HOME", tempHome);
  vi.stubEnv("USERPROFILE", tempHome);
  vi.stubEnv("CF_HANA_DRIVER", "fake");
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("api", () => {
  it("connect() opens a reusable client", async () => {
    const client = await connect("app-demo");
    expect(client.info.appName).toBe("app-demo");
    await client.close();
  });

  it("query() runs a one-shot query and closes the client", async () => {
    const result = await query("app-demo", "SELECT 1 FROM DUMMY");
    expect(result.rows).toEqual([{ "1": 1 }]);
  });

  it("withConnection() runs work and closes the client afterwards", async () => {
    const schema = await withConnection("app-demo", (client) =>
      Promise.resolve(client.info.schema),
    );
    expect(schema).toBe("APP_SCHEMA");
  });
});
