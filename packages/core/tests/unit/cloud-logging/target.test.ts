import { describe, expect, it, vi } from "vitest";

import { resolveTarget, printResolvedTarget } from "../../../src/cloud-logging/target.js";
import type { CfExecContext, CloudLoggingCfExecutor, CurrentCfTarget } from "../../../src/cloud-logging/types.js";

function fakeExecutor(overrides: Partial<CloudLoggingCfExecutor> = {}): CloudLoggingCfExecutor {
  const readCurrentCfTargetMock = vi.fn(async () => undefined);
  return {
    ambientContext: {},
    cfCurl: vi.fn(async () => ""),
    cfServiceGuid: vi.fn(async () => ""),
    cfSpaceGuid: vi.fn(async () => ""),
    isCfAuthFailure: vi.fn(() => false),
    withCfSession: vi.fn(
      async <T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T> =>
        // eslint-disable-next-line @typescript-eslint/return-await
        work({}),
    ),
    cfApi: vi.fn(async () => undefined),
    cfAuth: vi.fn(async () => undefined),
    cfTargetSpace: vi.fn(async () => undefined),
    readCurrentCfTarget: readCurrentCfTargetMock,
    getApiEndpointForRegion: vi.fn(() => undefined),
    ...overrides,
  } as CloudLoggingCfExecutor;
}

describe("resolveTarget", () => {
  it("returns an explicit target unresolved-from-ambient when region/org/space are all given", async () => {
    const executor = fakeExecutor({ getApiEndpointForRegion: vi.fn(() => "https://api.cf.br10.hana.ondemand.com") });

    const target = await resolveTarget({ region: "br10", org: "my-org", space: "my-space" }, executor);

    expect(target).toEqual({
      apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
      region: "br10",
      org: "my-org",
      space: "my-space",
      selectorSource: "explicit",
      regionConfirmed: true,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(executor.readCurrentCfTarget).not.toHaveBeenCalled();
  });

  it("throws on an unknown region", async () => {
    const executor = fakeExecutor({ getApiEndpointForRegion: vi.fn(() => undefined) });

    await expect(resolveTarget({ region: "nowhere", org: "o", space: "s" }, executor)).rejects.toThrow(
      /Unknown SAP CF region "nowhere"/,
    );
  });

  it("falls back to the ambient 'cf target' session for missing pieces", async () => {
    const current: CurrentCfTarget = {
      apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
      regionKey: "br10",
      orgName: "ambient-org",
      spaceName: "ambient-space",
    };
    const executor = fakeExecutor({ readCurrentCfTarget: vi.fn(async () => current) });

    const target = await resolveTarget({}, executor);

    expect(target).toEqual({
      apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
      region: "br10",
      org: "ambient-org",
      space: "ambient-space",
      selectorSource: "ambient",
      regionConfirmed: true,
    });
  });

  it("throws with the missing flags named when nothing is ambient and flags are absent", async () => {
    const executor = fakeExecutor();

    await expect(resolveTarget({ org: "only-org" }, executor)).rejects.toThrow(
      /missing: --region, --space.*no ambient/s,
    );
  });

  it("throws when the ambient endpoint cannot be mapped to a known region and no explicit --region was passed", async () => {
    const current: CurrentCfTarget = {
      apiEndpoint: "https://api.cf.unknown-region.hana.ondemand.com",
      orgName: "o",
      spaceName: "s",
    };
    const executor = fakeExecutor({ readCurrentCfTarget: vi.fn(async () => current) });

    await expect(resolveTarget({}, executor)).rejects.toThrow(/could not be mapped/);
  });
});

describe("printResolvedTarget", () => {
  it("writes an (explicit) notice to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printResolvedTarget(
      { apiEndpoint: "e", region: "br10", org: "o", space: "s", selectorSource: "explicit", regionConfirmed: true },
      "cf-log-search",
    );
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^cf-log-search: target br10\/o\/s \(explicit\)\n$/));
    spy.mockRestore();
  });

  it("writes an ambient notice with the pin hint when the region could not be confirmed", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printResolvedTarget(
      { apiEndpoint: "e", region: "br10", org: "o", space: "s", selectorSource: "ambient", regionConfirmed: false },
      "cf-log-search",
    );
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/region could not be.*mapped/));
    spy.mockRestore();
  });
});
