import { describe, expect, it } from "vitest";

import { extractDashboardsCredential, parseCredentialJson } from "../../../src/cloud-logging/dashboards-payload.js";

describe("extractDashboardsCredential", () => {
  it("reads flat top-level credential fields (CLI v7 shape)", () => {
    const result = extractDashboardsCredential(
      { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" },
      "service-key:mykey",
    );
    expect(result).toEqual({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:mykey" });
  });

  it("reads fields nested under a credentials key (CLI v8 shape)", () => {
    const result = extractDashboardsCredential(
      { credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } },
      "service-key:mykey",
    );
    expect(result?.dashboardsEndpoint).toBe("https://dash.example.com");
  });

  it("prefers the top level when both shapes could apply", () => {
    const result = extractDashboardsCredential(
      {
        "dashboards-endpoint": "https://top.example.com",
        "dashboards-username": "u",
        "dashboards-password": "p",
        credentials: { "dashboards-endpoint": "https://nested.example.com" },
      },
      "x",
    );
    expect(result?.dashboardsEndpoint).toBe("https://top.example.com");
  });

  it("returns undefined when a field is missing", () => {
    expect(extractDashboardsCredential({ "dashboards-endpoint": "e", "dashboards-username": "u" }, "x")).toBeUndefined();
  });

  it("returns undefined for a non-object payload", () => {
    expect(extractDashboardsCredential("not an object", "x")).toBeUndefined();
    expect(extractDashboardsCredential(null, "x")).toBeUndefined();
  });

  it("returns undefined for an empty-string field", () => {
    expect(
      extractDashboardsCredential({ "dashboards-endpoint": "", "dashboards-username": "u", "dashboards-password": "p" }, "x"),
    ).toBeUndefined();
  });
});

describe("parseCredentialJson", () => {
  it("extracts and parses a JSON object embedded in noisy cf CLI output", () => {
    const stdout = "Getting service instance...\n{\"credentials\":{\"a\":1}}\nOK\n";
    expect(parseCredentialJson(stdout, "test payload")).toEqual({ credentials: { a: 1 } });
  });

  it("throws a message that never echoes the raw parse error (which may contain a secret)", () => {
    expect(() => parseCredentialJson("no json here at all", "test payload")).toThrow(
      /Could not find a JSON object in the test payload/,
    );
  });

  it("throws without echoing V8's own parse-error snippet on malformed JSON", () => {
    expect(() => parseCredentialJson('{"credentials": {"password": "sekrit", "broken}}', "test payload")).toThrow(
      /Could not parse the test payload as JSON \(parse error details omitted/,
    );
  });
});
