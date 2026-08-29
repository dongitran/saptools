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
