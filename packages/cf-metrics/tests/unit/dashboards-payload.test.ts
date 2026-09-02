import { describe, expect, it } from "vitest";

import { extractDashboardsCredential } from "../../src/dashboards-payload.js";

describe("extractDashboardsCredential", () => {
  it("extracts a valid credential", () => {
    const credential = extractDashboardsCredential(
      { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" },
      "service-key:mykey",
    );
    expect(credential).toEqual({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "service-key:mykey",
    });
  });

  /**
   * CLI v8's `cf service-key` wraps the fields in a `credentials` object
   * (`{"credentials": {...}}`), where v7 printed them flat. The minting path
   * reads that output directly, so a freshly minted key must be readable in
   * both shapes.
   */
  it("also reads the fields nested under `credentials`, as CLI v8's cf service-key prints them", () => {
    const credential = extractDashboardsCredential(
      { credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } },
      "minted:cf-metrics-ab12cd34",
    );
    expect(credential).toEqual({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "minted:cf-metrics-ab12cd34",
    });
  });

  it("prefers the top-level fields when both shapes are somehow present", () => {
    const credential = extractDashboardsCredential(
      {
        "dashboards-endpoint": "https://top.example.com",
        "dashboards-username": "top",
        "dashboards-password": "top-p",
        credentials: { "dashboards-endpoint": "https://nested.example.com", "dashboards-username": "n", "dashboards-password": "n-p" },
      },
      "x",
    );
    expect(credential?.dashboardsEndpoint).toBe("https://top.example.com");
  });

  it("returns undefined when dashboards fields are missing (SAML-enabled instance's new key shape)", () => {
    expect(extractDashboardsCredential({ "dashboards-endpoint": "https://dash.example.com" }, "x")).toBeUndefined();
  });

  it("returns undefined for a non-object payload", () => {
    expect(extractDashboardsCredential("not-an-object", "x")).toBeUndefined();
    expect(extractDashboardsCredential(null, "x")).toBeUndefined();
    expect(extractDashboardsCredential([1, 2], "x")).toBeUndefined();
  });

  it("returns undefined when a required field is present but empty", () => {
    const credential = extractDashboardsCredential(
      { "dashboards-endpoint": "", "dashboards-username": "u", "dashboards-password": "p" },
      "x",
    );
    expect(credential).toBeUndefined();
  });
});
