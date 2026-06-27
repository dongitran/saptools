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
        application_env_json: { VCAP_APPLICATION: { application_id: "id" } },
        environment_variables: { 
          FOO: "bar",
          destinations: '[{"name":"test","url":"https://test.com"}]',
          invalid_json: '{"missing_quote: true}'
        },
      }),
    );

    const out = await fetchDefaultEnvJson({ appName: "demo" });

    expect(cfAppGuid).toHaveBeenCalledWith("demo", undefined);
    expect(cfCurl).toHaveBeenCalledWith("/v3/apps/guid-123/env", undefined);

    const parsed = JSON.parse(out);
    expect(parsed.VCAP_SERVICES).toBeDefined();
    expect(parsed.VCAP_APPLICATION).toBeDefined();
    expect(parsed.VCAP_APPLICATION.application_id).toBe("id");
    expect(parsed.FOO).toBe("bar");
    expect(parsed.destinations).toEqual([{ name: "test", url: "https://test.com" }]);
    expect(parsed.invalid_json).toBe('{"missing_quote: true}');
  });

  it("throws when no env data found", async () => {
    vi.spyOn(cfModule, "cfAppGuid").mockResolvedValue("g");
    vi.spyOn(cfModule, "cfCurl").mockResolvedValue(JSON.stringify({}));

    await expect(fetchDefaultEnvJson({ appName: "x" })).rejects.toThrow(
      "No environment variables found",
    );
  });
});
