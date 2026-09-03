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

  it("accepts CF CLI v8's nested credentials wrapper", () => {
    // Regression test: `cf service-key` prints {"credentials": {...}} on CLI v8
    // where v7 printed the fields flat, so reading only the top level made
    // every --service-key lookup come back empty and made a freshly minted key
    // look empty too -- the latter only after SAML had already been disabled.
    const credential = extractDashboardsCredential(
      {
        credentials: {
          "dashboards-endpoint": "https://dash.example.com",
          "dashboards-username": "u",
          "dashboards-password": "p",
        },
      },
      "service-key:mykey",
    );

    expect(credential).toEqual({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "service-key:mykey",
    });
  });

  it("prefers top-level fields over a nested credentials key when both are present", () => {
    // The VCAP path hands over an already-unwrapped `credentials` object, so a
    // payload that carries the fields at the top level must never be
    // re-interpreted through a `credentials` key meaning something else.
    const credential = extractDashboardsCredential(
      {
        "dashboards-endpoint": "https://top.example.com",
        "dashboards-username": "top-user",
        "dashboards-password": "top-pw",
        credentials: {
          "dashboards-endpoint": "https://nested.example.com",
          "dashboards-username": "nested-user",
          "dashboards-password": "nested-pw",
        },
      },
      "x",
    );

    expect(credential).toMatchObject({ dashboardsEndpoint: "https://top.example.com", username: "top-user", password: "top-pw" });
  });

  it("returns undefined when the v8 wrapper carries no basic-auth fields (key created after SAML was enabled)", () => {
    expect(
      extractDashboardsCredential({ credentials: { "dashboards-endpoint": "https://dash.example.com" } }, "x"),
    ).toBeUndefined();
  });

  it("ignores a credentials key that is not an object", () => {
    expect(extractDashboardsCredential({ credentials: null }, "x")).toBeUndefined();
    expect(extractDashboardsCredential({ credentials: "nope" }, "x")).toBeUndefined();
    expect(extractDashboardsCredential({ credentials: [1, 2] }, "x")).toBeUndefined();
  });

  it("returns undefined when a required field is present but empty", () => {
    const credential = extractDashboardsCredential(
      { "dashboards-endpoint": "", "dashboards-username": "u", "dashboards-password": "p" },
      "x",
    );
    expect(credential).toBeUndefined();
  });
});
