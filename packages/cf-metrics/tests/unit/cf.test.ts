import { describe, expect, it } from "vitest";

import {
  extractFirstJsonObject,
  getApiEndpointForRegion,
  getRegionKeyForApi,
  parseCfTargetOutput,
  parseServiceStatus,
  isCfAuthFailure,
  redactSecretLikeText,
} from "../../src/cf.js";

describe("region <-> API endpoint mapping", () => {
  it("resolves a known region key", () => {
    expect(getApiEndpointForRegion("eu10")).toBe("https://api.cf.eu10.hana.ondemand.com");
  });

  it("returns undefined for an unknown region key", () => {
    expect(getApiEndpointForRegion("not-a-region")).toBeUndefined();
  });

  it("resolves a known API endpoint back to its region key", () => {
    expect(getRegionKeyForApi("https://api.cf.eu10.hana.ondemand.com")).toBe("eu10");
  });

  it("falls back to extracting the region key from a standard-shaped hostname not yet in the map", () => {
    // A real SAP region added after REGION_API_MAP was last updated must
    // still resolve on the ambient path (mirrors cf-otel's and cf-hana's
    // identical fallback) — this endpoint is deliberately not in the map above.
    expect(getRegionKeyForApi("https://api.cf.zz99.hana.ondemand.com")).toBe("zz99");
    expect(getRegionKeyForApi("https://api.cf.zz99-001.platform.sapcloud.cn")).toBe("zz99-001");
  });

  it("returns undefined for a non-SAP-shaped hostname even via the fallback", () => {
    expect(getRegionKeyForApi("https://example.com")).toBeUndefined();
    expect(getRegionKeyForApi("not a url at all")).toBeUndefined();
  });
});

describe("parseCfTargetOutput", () => {
  it("parses a well-formed cf target block", () => {
    const stdout = [
      "api endpoint:   https://api.cf.eu10.hana.ondemand.com",
      "api version:    3.181.0",
      "user:           user@example.com",
      "org:            example-org",
      "space:          space-demo",
    ].join("\n");
    expect(parseCfTargetOutput(stdout)).toEqual({
      apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
      orgName: "example-org",
      spaceName: "space-demo",
      regionKey: "eu10",
    });
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseCfTargetOutput("not logged in")).toBeUndefined();
  });
});

/**
 * Decides whether the user's own `cf` session gets abandoned in favour of an
 * isolated login. Too broad and every ordinary failure (typo'd instance name,
 * network blip) triggers a pointless re-login; too narrow and a dead session
 * surfaces as sixty identical per-binding failures.
 */
describe("isCfAuthFailure", () => {
  it.each([
    "cf space app --guid failed: FAILED\nNot logged in. Use 'cf login' or 'cf login --sso' to log in.",
    "cf curl /v3/x failed: Authentication has expired.  Please log back in to re-authenticate.",
    "cf curl /v3/x failed: The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate.",
    "cf auth failed: Credentials were rejected, please try again.",
    'cf curl /v3/x failed: {"errors":[{"code":1000,"title":"CF-InvalidAuthToken","detail":"Invalid Auth Token"}]} (401)',
  ])("recognizes a dead session: %s", (message) => {
    expect(isCfAuthFailure(new Error(message))).toBe(true);
  });

  it.each([
    "cf service nope --guid failed: Service instance 'nope' not found.",
    "cf curl /v3/x failed: Error performing request: dial tcp: connection reset",
    "The 'cf target' session changed while cf-metrics was reading it",
    "refresh token stored under a session directory",
  ])("leaves an ordinary failure alone: %s", (message) => {
    expect(isCfAuthFailure(new Error(message))).toBe(false);
  });

  it("copes with a non-Error value", () => {
    expect(isCfAuthFailure("not logged in")).toBe(true);
    expect(isCfAuthFailure(42)).toBe(false);
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts a JSON object embedded after leading prose text", () => {
    const stdout = 'Getting key key1 for service instance cloud-logging...\n\n{\n  "dashboards-endpoint": "https://x"\n}\n';
    expect(JSON.parse(extractFirstJsonObject(stdout))).toEqual({ "dashboards-endpoint": "https://x" });
  });

  it("handles nested braces and braces inside string values correctly", () => {
    const stdout = '{"a": {"b": 1}, "c": "text with } inside"}';
    expect(JSON.parse(extractFirstJsonObject(stdout))).toEqual({ a: { b: 1 }, c: "text with } inside" });
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractFirstJsonObject("no json here")).toThrow(/No JSON object found/);
  });
});

describe("redactSecretLikeText", () => {
  it("redacts a sensitive-keyed JSON value regardless of surrounding case", () => {
    const text = 'update failed: {"saml.sp.signature_private_key_PASSWORD":"hunter2","entity_id":"urn:x"}';
    const redacted = redactSecretLikeText(text);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain('"saml.sp.signature_private_key_PASSWORD":"[REDACTED]"');
    expect(redacted).toContain('"entity_id":"urn:x"');
  });

  it("redacts a PEM block wholesale, key type and all", () => {
    const text = "broker rejected:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----\nreason: bad format";
    const redacted = redactSecretLikeText(text);
    expect(redacted).not.toContain("MIIBogIBAAJ");
    expect(redacted).toContain("[REDACTED PEM BLOCK]");
    expect(redacted).toContain("reason: bad format");
  });

  it("leaves ordinary, non-sensitive text completely unchanged", () => {
    expect(redactSecretLikeText("cf update-service failed: instance not found")).toBe(
      "cf update-service failed: instance not found",
    );
  });
});

describe("parseServiceStatus", () => {
  it("extracts the status field from cf service output", () => {
    expect(parseServiceStatus("name:    cloud-logging\nstatus:    update succeeded\n")).toBe("update succeeded");
  });

  it("returns undefined when there is no status field", () => {
    expect(parseServiceStatus("name: cloud-logging")).toBeUndefined();
  });
});
