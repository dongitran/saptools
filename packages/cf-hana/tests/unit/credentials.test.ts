import { fetchAppDbBindings, readDbAppView } from "@saptools/cf-sync";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppBindings, selectBinding, toConnectionTarget } from "../../src/credentials.js";
import { CredentialsNotFoundError } from "../../src/errors.js";

import { sampleBinding, sampleCredentials, sampleDbAppView } from "./fixtures/samples.js";

vi.mock("@saptools/cf-sync", () => ({
  readDbAppView: vi.fn(),
  fetchAppDbBindings: vi.fn(),
}));

const mockReadDbAppView = vi.mocked(readDbAppView);
const mockFetchAppDbBindings = vi.mocked(fetchAppDbBindings);

const FETCHED = {
  selector: "eu10/acme/dev/orders-srv",
  regionKey: "eu10",
  orgName: "acme",
  spaceName: "dev",
  appName: "orders-srv",
} as const;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveAppBindings", () => {
  it("returns cached bindings on a cache hit", async () => {
    mockReadDbAppView.mockResolvedValue(sampleDbAppView([sampleBinding()]));
    const resolved = await resolveAppBindings("orders-srv", {});
    expect(resolved.source).toBe("cache");
    expect(resolved.bindings).toHaveLength(1);
    expect(mockFetchAppDbBindings).not.toHaveBeenCalled();
  });

  it("falls back to a live fetch on a cache miss", async () => {
    mockReadDbAppView.mockResolvedValue(undefined);
    mockFetchAppDbBindings.mockResolvedValue({ ...FETCHED, bindings: [sampleBinding()] });
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "secret");
    const resolved = await resolveAppBindings("orders-srv", {});
    expect(resolved.source).toBe("fresh");
    expect(mockFetchAppDbBindings).toHaveBeenCalledOnce();
  });

  it("throws when there is no cache and no SAP credentials", async () => {
    mockReadDbAppView.mockResolvedValue(undefined);
    vi.stubEnv("SAP_EMAIL", " ");
    vi.stubEnv("SAP_PASSWORD", " ");
    await expect(resolveAppBindings("orders-srv", {})).rejects.toBeInstanceOf(
      CredentialsNotFoundError,
    );
  });

  it("bypasses the cache when refresh is requested", async () => {
    mockFetchAppDbBindings.mockResolvedValue({ ...FETCHED, bindings: [sampleBinding()] });
    const resolved = await resolveAppBindings("orders-srv", {
      refresh: true,
      email: "user@example.com",
      password: "secret",
    });
    expect(resolved.source).toBe("fresh");
    expect(mockReadDbAppView).not.toHaveBeenCalled();
  });

  it("throws when the fetched app has no HANA binding", async () => {
    mockReadDbAppView.mockResolvedValue(undefined);
    mockFetchAppDbBindings.mockResolvedValue({ ...FETCHED, bindings: [] });
    await expect(
      resolveAppBindings("orders-srv", { email: "user@example.com", password: "secret" }),
    ).rejects.toBeInstanceOf(CredentialsNotFoundError);
  });
});

describe("selectBinding", () => {
  it("returns the only binding when there is exactly one", () => {
    const binding = sampleBinding();
    expect(selectBinding([binding], {})).toBe(binding);
  });

  it("throws when multiple bindings are ambiguous", () => {
    expect(() =>
      selectBinding([sampleBinding({ name: "a" }), sampleBinding({ name: "b" })], {}),
    ).toThrow(/multiple HANA bindings/);
  });

  it("selects a binding by name", () => {
    const target = sampleBinding({ name: "wanted" });
    expect(
      selectBinding([sampleBinding({ name: "other" }), target], { bindingName: "wanted" }),
    ).toBe(target);
  });

  it("throws when a named binding is missing", () => {
    expect(() => selectBinding([sampleBinding()], { bindingName: "missing" })).toThrow(
      /No HANA binding named/,
    );
  });

  it("selects a binding by index", () => {
    const target = sampleBinding({ name: "second" });
    expect(
      selectBinding([sampleBinding({ name: "first" }), target], { bindingIndex: 1 }),
    ).toBe(target);
  });

  it("throws when a binding index is out of range", () => {
    expect(() => selectBinding([sampleBinding()], { bindingIndex: 9 })).toThrow(
      /No HANA binding at index/,
    );
  });

  it("throws when there are no bindings", () => {
    expect(() => selectBinding([], {})).toThrow(CredentialsNotFoundError);
  });
});

describe("toConnectionTarget", () => {
  it("maps the runtime user by default", () => {
    expect(toConnectionTarget(sampleBinding(), "runtime")).toMatchObject({
      user: "DB_USER",
      password: "db-password",
      port: 443,
      schema: "APP_SCHEMA",
    });
  });

  it("maps the HDI user for the hdi role", () => {
    expect(toConnectionTarget(sampleBinding(), "hdi")).toMatchObject({
      user: "HDI_USER",
      password: "HDI_PASSWORD",
    });
  });

  it("rejects an invalid port", () => {
    const binding = sampleBinding({ credentials: sampleCredentials({ port: "not-a-port" }) });
    expect(() => toConnectionTarget(binding, "runtime")).toThrow(/Invalid HANA port/);
  });
});
