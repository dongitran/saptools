import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import * as cfModule from "../../src/cf.js";
import { fetchDefaultEnvJson } from "../../src/default-env.js";

describe("fetchDefaultEnvJson", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches guid then curls v3 env and builds merged payload", async () => {
    const cfAppGuid = vi.spyOn(cfModule, "cfAppGuid").mockResolvedValue("guid-123");
    const cfCurl = vi.spyOn(cfModule, "cfCurl").mockResolvedValue(
      JSON.stringify({
        system_env_json: { VCAP_SERVICES: { hana: [{}] } },
        environment_variables: { FOO: "bar" },
      }),
    );

    const out = await fetchDefaultEnvJson({ appName: "demo" });

    expect(cfAppGuid).toHaveBeenCalledWith("demo", undefined);
    expect(cfCurl).toHaveBeenCalledWith("/v3/apps/guid-123/env", undefined);

    const parsed = JSON.parse(out);
    expect(parsed.VCAP_SERVICES).toBeDefined();
    expect(parsed.FOO).toBe("bar");
  });

  it("throws when no env data found", async () => {
    vi.spyOn(cfModule, "cfAppGuid").mockResolvedValue("g");
    vi.spyOn(cfModule, "cfCurl").mockResolvedValue(JSON.stringify({}));

    await expect(fetchDefaultEnvJson({ appName: "x" })).rejects.toThrow(
      "No environment variables found",
    );
  });
});
