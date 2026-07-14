import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connect, query, withConnection } from "../../src/api.js";
import * as cf from "../../src/cf.js";
import type { CurrentCfTarget } from "../../src/cf.js";

const sampleTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  orgName: "example-org",
  spaceName: "space-demo",
  regionKey: "eu10",
};

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cf-hana-api-"));
  vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(sampleTarget as CurrentCfTarget);
  vi.spyOn(cf, "cfEnvDirect").mockResolvedValue(`VCAP_SERVICES:
{"hana":[{"name":"hana-primary","credentials":{"host":"hana.example.internal","port":"443","user":"DB_USER","password":"db-password","schema":"APP_SCHEMA","hdi_user":"HDI_USER","hdi_password":"HDI_PASSWORD","url":"","database_id":"DB-1","certificate":"test-certificate"}}]}
VCAP_APPLICATION:{"application_name":"app-demo","cf_api":"https://api.cf.eu10.hana.ondemand.com","organization_name":"example-org","space_name":"space-demo"}`);
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
