import { describe, expect, it } from "vitest";

import {
  extractHanaCredentials,
  extractVcapServicesSection,
  parseVcapServices,
} from "../../src/parser.js";
import type { RawHanaBinding } from "../../src/types.js";

const VALID_CREDENTIALS = {
  host: "host.hana.example.com",
  port: "443",
  user: "USER_1",
  password: "pw",
  schema: "SCHEMA_1",
  hdi_user: "HDI_USER",
  hdi_password: "HDI_PASS",
  url: "jdbc:sap://host.hana.example.com:443",
  database_id: "DB123",
  certificate: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
} as const;

function validBinding(): RawHanaBinding {
  return { credentials: VALID_CREDENTIALS };
}

describe("parseVcapServices", () => {
  it("parses a valid payload with one hana binding", () => {
    const raw = JSON.stringify({ hana: [validBinding()] });
    const result = parseVcapServices(raw);
    expect(result.hana?.length).toBe(1);
    expect(result.hana?.[0]?.credentials.host).toBe(VALID_CREDENTIALS.host);
  });

  it("returns empty when hana key is absent", () => {
    const raw = JSON.stringify({ xsuaa: [] });
    expect(parseVcapServices(raw)).toEqual({});
  });

  it("throws on invalid JSON", () => {
    expect(() => parseVcapServices("{not-json")).toThrow(/not valid JSON/);
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseVcapServices(JSON.stringify(["a"]))).toThrow(/JSON object/);
  });

  it("throws when hana key is not an array", () => {
    const raw = JSON.stringify({ hana: "nope" });
    expect(() => parseVcapServices(raw)).toThrow(/hana must be an array/);
  });

  it("throws when a binding is missing credentials", () => {
    const raw = JSON.stringify({ hana: [{ label: "hana" }] });
    expect(() => parseVcapServices(raw)).toThrow(/HANA credentials/);
  });

  it("throws when a required credential field is missing", () => {
    const partial = { ...VALID_CREDENTIALS } as Record<string, unknown>;
    delete partial["certificate"];
    const raw = JSON.stringify({ hana: [{ credentials: partial }] });
    expect(() => parseVcapServices(raw)).toThrow(/"certificate"/);
  });
});

describe("extractHanaCredentials", () => {
  it("maps snake_case fields to camelCase", () => {
    const creds = extractHanaCredentials(validBinding());
    expect(creds.hdiUser).toBe(VALID_CREDENTIALS.hdi_user);
    expect(creds.hdiPassword).toBe(VALID_CREDENTIALS.hdi_password);
    expect(creds.databaseId).toBe(VALID_CREDENTIALS.database_id);
  });

  it("preserves all other fields verbatim", () => {
    const creds = extractHanaCredentials(validBinding());
    expect(creds.host).toBe(VALID_CREDENTIALS.host);
    expect(creds.port).toBe(VALID_CREDENTIALS.port);
    expect(creds.user).toBe(VALID_CREDENTIALS.user);
    expect(creds.password).toBe(VALID_CREDENTIALS.password);
    expect(creds.schema).toBe(VALID_CREDENTIALS.schema);
    expect(creds.url).toBe(VALID_CREDENTIALS.url);
    expect(creds.certificate).toBe(VALID_CREDENTIALS.certificate);
  });
});

describe("extractVcapServicesSection", () => {
  it("extracts the VCAP_SERVICES block between markers", () => {
    const stdout = [
      "Getting env for app example...",
      "",
      "System-Provided:",
      "VCAP_SERVICES: {",
      '  "hana": []',
      "}",
      "",
      "VCAP_APPLICATION: {",
      '  "application_name": "example"',
      "}",
    ].join("\n");
    const block = extractVcapServicesSection(stdout);
    expect(block.startsWith("{")).toBe(true);
    expect(block.endsWith("}")).toBe(true);
    expect(JSON.parse(block)).toEqual({ hana: [] });
  });

  it("falls back to end-of-string when VCAP_APPLICATION marker is missing", () => {
    const stdout = 'VCAP_SERVICES: {"hana": []}\n';
    const block = extractVcapServicesSection(stdout);
    expect(JSON.parse(block)).toEqual({ hana: [] });
  });

  it("throws when VCAP_SERVICES marker is not present", () => {
    expect(() => extractVcapServicesSection("no marker here")).toThrow(
      /VCAP_SERVICES section not found/,
    );
  });
});
