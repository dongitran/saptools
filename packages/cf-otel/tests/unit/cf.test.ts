import { describe, expect, it } from "vitest";

import {
  extractFirstJsonObject,
  getApiEndpointForRegion,
  getRegionKeyForApi,
  isCfAuthFailure,
  parseCfTargetOutput,
  parseServiceStatus,
  redactSecretLikeText,
} from "../../src/cf.js";

// The exact sequence a real `cf 8.18.0` emits for flavour text with
// CF_COLOR=true. Kept as a named constant rather than inlined so the escape
// does not run into the word after it and read as one unpronounceable token.
const CYAN_ON = "\u001b[36;1m";
const CYAN_OFF = "\u001b[0;22m";

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
    // still resolve on the ambient path (mirrors cf-hana's identical
    // fallback) — this endpoint is deliberately not in the map above.
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

  it("reads clean values when CF_COLOR styled them", () => {
    // `cf target` was measured not to colorize at all, but the same styling
    // appears in other commands' flavour text, and splitting on the first ":"
    // would otherwise carry the escape into the org/space name.
    const stdout = [
      `API endpoint:   ${CYAN_ON}https://api.cf.eu10.hana.ondemand.com${CYAN_OFF}`,
      `org:            ${CYAN_ON}example-org${CYAN_OFF}`,
      `space:          ${CYAN_ON}space-demo${CYAN_OFF}`,
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

describe("isCfAuthFailure", () => {
  it("recognizes an expired-token failure", () => {
    expect(isCfAuthFailure(new Error("authentication has expired, please log back in"))).toBe(true);
  });
  it("recognizes a 401/unauthorized failure", () => {
    expect(isCfAuthFailure(new Error("Server error, status code: 401, error code: 1000, message: Invalid Auth Token"))).toBe(true);
  });
  it("does not classify an unrelated cf failure as an auth failure", () => {
    expect(isCfAuthFailure(new Error("App 'foo' not found"))).toBe(false);
  });
  it("copes with a non-Error value", () => {
    expect(isCfAuthFailure("not logged in")).toBe(true);
    expect(isCfAuthFailure(42)).toBe(false);
  });
});
