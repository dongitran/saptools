import { describe, expect, it } from "vitest";

import {
  extractFirstJsonObject,
  extractVcapServices,
  getApiEndpointForRegion,
  getRegionKeyForApi,
  parseCfTargetOutput,
  parseServiceKeyNames,
  parseServiceStatus,
  parseServicesTable,
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

// `cf services` pads every column to a fixed width so the header word and the
// data below it start at the same character offset — hand-typing that
// alignment is error-prone, so build rows from fixed column widths instead.
function servicesRow(name: string, offering: string, plan: string, boundApps: string, lastOp: string): string {
  return name.padEnd(17) + offering.padEnd(16) + plan.padEnd(11) + boundApps.padEnd(20) + lastOp;
}

describe("parseServicesTable", () => {
  it("parses the v7+ 'offering' header shape, including a row with empty bound apps", () => {
    const stdout = [
      "Getting services in org example-org / space space-demo as user@example.com...",
      "",
      servicesRow("name", "offering", "plan", "bound apps", "last operation"),
      servicesRow("cloud-logging", "cloud-logging", "standard", "app1, app2", "create succeeded"),
      servicesRow("empty-instance", "cloud-logging", "standard", "", "create succeeded"),
    ].join("\n");
    const rows = parseServicesTable(stdout);
    expect(rows).toEqual([
      { name: "cloud-logging", offering: "cloud-logging", boundApps: ["app1", "app2"] },
      { name: "empty-instance", offering: "cloud-logging", boundApps: [] },
    ]);
  });

  it("parses the v6 'service' header shape", () => {
    const stdout = [
      servicesRow("name", "service", "plan", "bound apps", "last operation"),
      servicesRow("myapp-instance", "cloud-logging", "standard", "myapp", "create succeeded"),
    ].join("\n");
    expect(parseServicesTable(stdout)).toEqual([
      { name: "myapp-instance", offering: "cloud-logging", boundApps: ["myapp"] },
    ]);
  });

  it("returns an empty list when there is no recognizable header", () => {
    expect(parseServicesTable("No services found")).toEqual([]);
  });
});

describe("parseServiceKeyNames", () => {
  it("parses the key-name list under the 'name' header", () => {
    const stdout = ["Getting service keys for service instance cloud-logging as user@example.com...", "", "name", "key1", "key2"].join(
      "\n",
    );
    expect(parseServiceKeyNames(stdout)).toEqual(["key1", "key2"]);
  });

  it("returns an empty list when there are no keys", () => {
    expect(parseServiceKeyNames("No service key for service instance cloud-logging")).toEqual([]);
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

describe("extractVcapServices", () => {
  it("parses the VCAP_SERVICES JSON block from cf env output", () => {
    const stdout = [
      "VCAP_SERVICES:",
      '{"cloud-logging":[{"name":"cloud-logging","credentials":{"dashboards-endpoint":"https://x"}}]}',
      "VCAP_APPLICATION:{}",
    ].join("\n");
    const vcap = extractVcapServices(stdout);
    expect(vcap["cloud-logging"]).toEqual([{ name: "cloud-logging", credentials: { "dashboards-endpoint": "https://x" } }]);
  });

  it("throws when VCAP_SERVICES is absent", () => {
    expect(() => extractVcapServices("no vcap here")).toThrow(/VCAP_SERVICES section not found/);
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
