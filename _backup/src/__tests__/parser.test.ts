import { describe, it, expect } from "vitest";
import { parseVcapServices, extractHanaCredentials } from "../parser.js";
import type { RawHanaBinding } from "../types.js";

const MOCK_HANA_CREDENTIALS = {
  host: "abc123.hana.prod-ap11.hanacloud.ondemand.com",
  port: "443",
  user: "SCHEMA_RT",
  password: "secret-password",
  schema: "MY_SCHEMA",
  hdi_user: "SCHEMA_DT",
  hdi_password: "hdi-secret",
  url: "jdbc:sap://abc123.hana.prod-ap11.hanacloud.ondemand.com:443",
  database_id: "abc123-uuid",
  certificate: "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----",
};

const MOCK_VCAP = JSON.stringify({
  hana: [{ binding_guid: "guid-1", credentials: MOCK_HANA_CREDENTIALS }],
});

describe("parseVcapServices", () => {
  it("parses a valid VCAP_SERVICES string", () => {
    const result = parseVcapServices(MOCK_VCAP);

    expect(result.hana).toHaveLength(1);
    expect(result.hana?.[0]?.credentials.host).toBe(MOCK_HANA_CREDENTIALS.host);
  });

  it("returns empty object when no hana key", () => {
    const result = parseVcapServices(JSON.stringify({ redis: [] }));

    expect(result.hana).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseVcapServices("not json")).toThrow("not valid JSON");
  });

  it("throws when VCAP_SERVICES is not an object", () => {
    expect(() => parseVcapServices('"a string"')).toThrow("must be a JSON object");
  });

  it("throws when hana binding is missing credentials", () => {
    const bad = JSON.stringify({ hana: [{ no_credentials: true }] });

    expect(() => parseVcapServices(bad)).toThrow();
  });

  it("throws when a credential field is not a string", () => {
    const bad = JSON.stringify({
      hana: [{ credentials: { ...MOCK_HANA_CREDENTIALS, port: 443 } }],
    });

    expect(() => parseVcapServices(bad)).toThrow('Missing or invalid HANA credential field: "port"');
  });

  it("throws when hana binding is a primitive (number)", () => {
    const bad = JSON.stringify({ hana: [123] });

    expect(() => parseVcapServices(bad)).toThrow("HANA binding must be an object");
  });

  it("returns empty object when hana is not an array", () => {
    const result = parseVcapServices(JSON.stringify({ hana: "not-array" }));

    expect(result.hana).toBeUndefined();
  });
});

describe("extractHanaCredentials", () => {
  it("maps raw credentials to clean output shape", () => {
    const binding: RawHanaBinding = { credentials: MOCK_HANA_CREDENTIALS };
    const result = extractHanaCredentials(binding);

    expect(result.host).toBe(MOCK_HANA_CREDENTIALS.host);
    expect(result.hdiUser).toBe(MOCK_HANA_CREDENTIALS.hdi_user);
    expect(result.hdiPassword).toBe(MOCK_HANA_CREDENTIALS.hdi_password);
    expect(result.databaseId).toBe(MOCK_HANA_CREDENTIALS.database_id);
    expect(result.schema).toBe(MOCK_HANA_CREDENTIALS.schema);
    expect(result.certificate).toBe(MOCK_HANA_CREDENTIALS.certificate);
  });
});
