import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import { printResolvedTarget, resolveTarget } from "../../src/target.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveTarget", () => {
  it("uses explicit region/org/space with no ambient lookup", async () => {
    const spy = vi.spyOn(cf, "readCurrentCfTarget");
    const target = await resolveTarget({ region: "eu10", org: "my-org", space: "my-space" });
    expect(target).toMatchObject({
      region: "eu10",
      org: "my-org",
      space: "my-space",
      selectorSource: "explicit",
      regionConfirmed: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on an unknown explicit region", async () => {
    await expect(resolveTarget({ region: "not-a-region", org: "o", space: "s" })).rejects.toThrow(/Unknown SAP CF region/);
  });

  it("fills in missing pieces from the ambient cf target and marks the resolution ambient", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue({
      apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
      orgName: "ambient-org",
      spaceName: "ambient-space",
      regionKey: "eu10",
    });
    const target = await resolveTarget({});
    expect(target).toMatchObject({
      region: "eu10",
      org: "ambient-org",
      space: "ambient-space",
      selectorSource: "ambient",
      regionConfirmed: true,
    });
  });

  it("fails clearly when neither explicit flags nor an ambient target are available", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(undefined);
    await expect(resolveTarget({})).rejects.toThrow(/no ambient 'cf target' session was found/);
  });

  it("fails clearly when the ambient region cannot be mapped to a known API endpoint", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue({
      apiEndpoint: "https://api.cf.unknown-host.example.com",
      orgName: "o",
      spaceName: "s",
    });
    await expect(resolveTarget({})).rejects.toThrow(/could not be mapped/);
  });
});

describe("printResolvedTarget", () => {
  it("prints the ambient-with-pin-hint notice to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printResolvedTarget({ apiEndpoint: "x", region: "eu10", org: "o", space: "s", selectorSource: "ambient", regionConfirmed: true });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("resolved from ambient 'cf target'; pass --region/--org/--space to pin"));
  });

  it("prints an explicit notice when the target was fully pinned", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printResolvedTarget({ apiEndpoint: "x", region: "eu10", org: "o", space: "s", selectorSource: "explicit", regionConfirmed: true });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("(explicit)"));
  });

  it("prints the region-unmapped notice when ambient resolution could not confirm a region", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printResolvedTarget({ apiEndpoint: "x", region: "current", org: "o", space: "s", selectorSource: "ambient", regionConfirmed: false });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("region could not be mapped"));
  });
});
