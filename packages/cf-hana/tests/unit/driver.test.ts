import { afterEach, describe, expect, it, vi } from "vitest";

import { createDriver } from "../../src/driver/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createDriver", () => {
  it("creates the hdb driver by name", () => {
    expect(createDriver("hdb").name).toBe("hdb");
  });

  it("creates the fake driver by name", () => {
    expect(createDriver("fake").name).toBe("fake");
  });

  it("defaults to the hdb driver", () => {
    expect(createDriver().name).toBe("hdb");
  });

  it("honors the CF_HANA_DRIVER environment override", () => {
    vi.stubEnv("CF_HANA_DRIVER", "fake");
    expect(createDriver().name).toBe("fake");
  });

  it("throws for an unknown driver name", () => {
    expect(() => createDriver("bogus")).toThrow(/Unknown HANA driver/);
  });
});
