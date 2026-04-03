import { describe, it, expect, vi, beforeEach } from "vitest";
import process from "node:process";

// Mock CF module so no real CF CLI calls happen
vi.mock("../cf.js", () => ({
  cfApi: vi.fn().mockResolvedValue(undefined),
  cfAuth: vi.fn().mockResolvedValue(undefined),
  cfOrgs: vi.fn().mockResolvedValue(["org-a", "org-b"]),
  cfTarget: vi.fn().mockResolvedValue({ spaces: ["dev"] }),
  cfTargetSpace: vi.fn().mockResolvedValue(undefined),
  cfApps: vi.fn().mockResolvedValue(["app-1", "app-2"]),
  cfSpaces: vi.fn().mockResolvedValue(["dev", "prod"]),
}));

// Mock cache to avoid touching ~/.config during tests
vi.mock("../cache.js", () => ({
  setCachedOrgs: vi.fn().mockResolvedValue(undefined),
  setCachedSpaces: vi.fn().mockResolvedValue(undefined),
  setCachedApps: vi.fn().mockResolvedValue(undefined),
  getCachedOrgs: vi.fn().mockResolvedValue(null),
  getCachedSpaces: vi.fn().mockResolvedValue(null),
  getCachedApps: vi.fn().mockResolvedValue(null),
}));

import { syncRegion, syncAll } from "../sync.js";
import * as cf from "../cf.js";
import * as cache from "../cache.js";

const EMAIL = "test@example.com";
const PASSWORD = "secret";

describe("syncRegion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls cfApi and cfAuth with correct args for ap11", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    expect(cf.cfApi).toHaveBeenCalledWith("https://api.cf.ap11.hana.ondemand.com");
    expect(cf.cfAuth).toHaveBeenCalledWith(EMAIL, PASSWORD);
  });

  it("fetches orgs and writes them to cache", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    expect(cf.cfOrgs).toHaveBeenCalled();
    expect(cache.setCachedOrgs).toHaveBeenCalledWith("ap11", ["org-a", "org-b"]);
  });

  it("targets each org and fetches spaces", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    expect(cf.cfTarget).toHaveBeenCalledWith("org-a");
    expect(cf.cfTarget).toHaveBeenCalledWith("org-b");
    expect(cf.cfSpaces).toHaveBeenCalled();
  });

  it("writes spaces to cache for each org", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    expect(cache.setCachedSpaces).toHaveBeenCalledWith("ap11", "org-a", ["dev", "prod"]);
    expect(cache.setCachedSpaces).toHaveBeenCalledWith("ap11", "org-b", ["dev", "prod"]);
  });

  it("targets each space and fetches apps", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    // 2 orgs × 2 spaces = 4 cfTargetSpace calls
    expect(cf.cfTargetSpace).toHaveBeenCalledTimes(4);
    expect(cf.cfApps).toHaveBeenCalledTimes(4);
  });

  it("writes apps to cache for each (org, space)", async () => {
    await syncRegion("ap11", EMAIL, PASSWORD);

    expect(cache.setCachedApps).toHaveBeenCalledWith("ap11", "org-a", "dev", ["app-1", "app-2"]);
    expect(cache.setCachedApps).toHaveBeenCalledWith("ap11", "org-a", "prod", ["app-1", "app-2"]);
  });

  it("continues when one org fails (error isolation)", async () => {
    vi.mocked(cf.cfTarget).mockRejectedValueOnce(new Error("CF error"));

    await expect(syncRegion("ap11", EMAIL, PASSWORD)).resolves.toBeUndefined();
    // Second org should still be synced
    expect(cf.cfTarget).toHaveBeenCalledTimes(2);
  });

  it("continues when one space fails (error isolation)", async () => {
    vi.mocked(cf.cfTargetSpace).mockRejectedValueOnce(new Error("CF error"));

    await expect(syncRegion("ap11", EMAIL, PASSWORD)).resolves.toBeUndefined();
  });

  it("throws when entire region auth fails", async () => {
    vi.mocked(cf.cfApi).mockRejectedValueOnce(new Error("unreachable"));

    await expect(syncRegion("ap11", EMAIL, PASSWORD)).rejects.toThrow("Failed to sync region ap11");
  });

  it("exercises spinner.fail path when cfApi fails in interactive mode", async () => {
    vi.mocked(cf.cfApi).mockRejectedValueOnce(new Error("unreachable"));

    await expect(
      syncRegion("ap11", EMAIL, PASSWORD, { interactive: true })
    ).rejects.toThrow("Failed to sync region ap11");
  });
});

describe("syncAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs both ap11 and br10 regions", async () => {
    await syncAll(EMAIL, PASSWORD);

    const apiCalls = vi.mocked(cf.cfApi).mock.calls.map((c) => c[0]);

    expect(apiCalls).toContain("https://api.cf.ap11.hana.ondemand.com");
    expect(apiCalls).toContain("https://api.cf.br10.hana.ondemand.com");
  });

  it("continues when one region fails entirely", async () => {
    vi.mocked(cf.cfApi).mockRejectedValueOnce(new Error("region down"));

    await expect(syncAll(EMAIL, PASSWORD)).resolves.toBeUndefined();
    // Second region should still be attempted
    expect(cf.cfApi).toHaveBeenCalledTimes(2);
  });

  it("accepts verbose option without throwing", async () => {
    await expect(syncAll(EMAIL, PASSWORD, { verbose: true })).resolves.toBeUndefined();
  });

  it("prints verbose failure message when region fails and verbose is set", async () => {
    vi.mocked(cf.cfApi).mockRejectedValueOnce(new Error("region down"));
    const stdoutSpy = vi.spyOn(process.stdout, "write");

    await syncAll(EMAIL, PASSWORD, { verbose: true });

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("[sync] Failed region:"));
    stdoutSpy.mockRestore();
  });

  it("prints sync complete message in verbose non-interactive mode", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write");

    await syncAll(EMAIL, PASSWORD, { verbose: true });

    expect(stdoutSpy).toHaveBeenCalledWith("[sync] Sync complete.\n");
    stdoutSpy.mockRestore();
  });

  it("prints completion message in interactive mode", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write");

    await syncAll(EMAIL, PASSWORD, { interactive: true });

    expect(stdoutSpy).toHaveBeenCalledWith("✔ All regions synced completely.\n");
    stdoutSpy.mockRestore();
  });
});
