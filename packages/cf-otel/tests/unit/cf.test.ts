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

// The exact sequences a real `cf 8.18.0` emits with CF_COLOR=true: every table
// header cell is wrapped in bold-on/bold-off, and flavour text is cyan. Kept as
// named constants rather than inlined so the escape does not run into the word
// after it and read as one unpronounceable token.
const BOLD_ON = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";
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

  it("still parses the table when CF_COLOR styled the header", () => {
    // Same failure mode as the service-keys table: measured on a real tenant,
    // a styled header took `cf services` from 42 parsed rows to 0, which makes
    // instance discovery report that no Cloud Logging instance exists at all.
    const stdout = [
      `${BOLD_ON}name${BOLD_OFF}            ${BOLD_ON}offering${BOLD_OFF}        ${BOLD_ON}plan${BOLD_OFF}       ` +
        `${BOLD_ON}bound apps${BOLD_OFF}    ${BOLD_ON}last operation${BOLD_OFF}`,
      "cloud-logging   cloud-logging   standard   legacy-app    create succeeded",
    ].join("\n");

    expect(parseServicesTable(stdout)).toEqual([
      { name: "cloud-logging", offering: "cloud-logging", boundApps: ["legacy-app"] },
    ]);
  });
});

describe("parseServiceKeyNames", () => {
  it("parses the CF CLI v6/v7 single-column shape", () => {
    const stdout = ["Getting service keys for service instance cloud-logging as user@example.com...", "", "name", "key1", "key2"].join(
      "\n",
    );
    expect(parseServiceKeyNames(stdout)).toEqual(["key1", "key2"]);
  });

  it("parses the CF CLI v8 three-column table, taking the name column only", () => {
    // Regression test against the real v8 shape: the table is
    // {"name", "last operation", "message"} rendered by DisplayTableWithHeader,
    // so a parser that required the header line to equal "name" returned []
    // and claimed the instance had no service keys. Taking whole rows instead
    // would have produced "key1   create succeeded" as a key name.
    const stdout = [
      "Getting keys for service instance cloud-logging as user@example.com...",
      "",
      "name   last operation     message",
      "key1   create succeeded   ",
      "key2   update succeeded   broker note here",
    ].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual(["key1", "key2"]);
  });

  it("handles v8 rows whose trailing columns are absent rather than padded", () => {
    const stdout = ["name   last operation     message", "key1   create succeeded", "key2"].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual(["key1", "key2"]);
  });

  it("locates the end of the name column without matching the literal 'last operation' header", () => {
    // The boundary is the next non-space run after "name", so a renamed or
    // reordered second column cannot silently reintroduce whole-row names.
    const stdout = ["name   status   note", "key1   ok       fine"].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual(["key1"]);
  });

  it("returns an empty list for v8's no-keys message, which prints no header at all", () => {
    const stdout = [
      "Getting keys for service instance cloud-logging as user@example.com...",
      "",
      "No service keys for service instance cloud-logging",
    ].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual([]);
  });

  it("returns an empty list when there are no keys", () => {
    expect(parseServiceKeyNames("No service key for service instance cloud-logging")).toEqual([]);
  });

  it("still parses the table when CF_COLOR styled the header", () => {
    // The escape sequences here are the ones a real `cf 8.18.0` emits with
    // CF_COLOR=true: each header cell is wrapped in bold-on/bold-off, and the
    // data rows are left unstyled. Measured against a real tenant, a styled
    // header shifted every column index and turned 54 real keys into 0 --
    // `buildEnv` forces the variable off, and `stripAnsi` covers callers that
    // hand this parser output it collected some other way.
    const stdout = [
      `${BOLD_ON}name${BOLD_OFF}   ${BOLD_ON}last operation${BOLD_OFF}     ${BOLD_ON}message${BOLD_OFF}`,
      "key1   create succeeded   ",
      "key2   create succeeded   ",
    ].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual(["key1", "key2"]);
  });

  it("stops at the first blank line after the rows and skips a row with an empty name cell", () => {
    const stdout = ["name   last operation", "key1   create succeeded", "       stray continuation", "", "OK"].join("\n");

    expect(parseServiceKeyNames(stdout)).toEqual(["key1"]);
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
