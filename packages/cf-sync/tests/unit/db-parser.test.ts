import { describe, expect, it } from "vitest";

import {
  extractHanaBindingsFromCfEnv,
  extractVcapServicesSection,
  parseHanaBindings,
} from "../../src/db-parser.js";

const VALID_HANA_CREDENTIALS = {
  host: "hana.example.internal",
  port: "443",
  user: "DB_USER",
  password: "db-password",
  schema: "APP_SCHEMA",
  hdi_user: "HDI_USER",
  hdi_password: "HDI_PASSWORD",
  url: "jdbc:sap://hana.example.internal:443",
  database_id: "DB-123",
  certificate: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
} as const;

describe("db-parser", () => {
  it("extracts hana bindings with credentials and optional metadata", () => {
    const raw = JSON.stringify({
      hana: [
        {
          name: "hana-primary",
          label: "hana",
          plan: "hdi-shared",
          credentials: VALID_HANA_CREDENTIALS,
        },
      ],
    });

    expect(parseHanaBindings(raw)).toEqual([
      {
        kind: "hana",
        name: "hana-primary",
        label: "hana",
        plan: "hdi-shared",
        credentials: {
          host: VALID_HANA_CREDENTIALS.host,
          port: VALID_HANA_CREDENTIALS.port,
          user: VALID_HANA_CREDENTIALS.user,
          password: VALID_HANA_CREDENTIALS.password,
          schema: VALID_HANA_CREDENTIALS.schema,
          hdiUser: VALID_HANA_CREDENTIALS.hdi_user,
          hdiPassword: VALID_HANA_CREDENTIALS.hdi_password,
          url: VALID_HANA_CREDENTIALS.url,
          databaseId: VALID_HANA_CREDENTIALS.database_id,
          certificate: VALID_HANA_CREDENTIALS.certificate,
        },
      },
    ]);
  });

  it("returns an empty list when VCAP_SERVICES has no hana bindings", () => {
    const raw = JSON.stringify({
      xsuaa: [],
    });

    expect(parseHanaBindings(raw)).toEqual([]);
  });

  it("extracts multiple hana bindings and omits invalid optional metadata", () => {
    const raw = JSON.stringify({
      hana: [
        {
          name: "hana-primary",
          label: "hana",
          plan: "hdi-shared",
          credentials: VALID_HANA_CREDENTIALS,
        },
        {
          name: 123,
          label: false,
          plan: null,
          credentials: {
            ...VALID_HANA_CREDENTIALS,
            schema: "SECOND_SCHEMA",
          },
        },
      ],
    });

    expect(parseHanaBindings(raw)).toEqual([
      {
        kind: "hana",
        name: "hana-primary",
        label: "hana",
        plan: "hdi-shared",
        credentials: expect.objectContaining({
          schema: VALID_HANA_CREDENTIALS.schema,
          hdiUser: VALID_HANA_CREDENTIALS.hdi_user,
          hdiPassword: VALID_HANA_CREDENTIALS.hdi_password,
          databaseId: VALID_HANA_CREDENTIALS.database_id,
        }),
      },
      {
        kind: "hana",
        credentials: expect.objectContaining({
          schema: "SECOND_SCHEMA",
        }),
      },
    ]);
  });

  it("extracts the VCAP_SERVICES block from cf env output", () => {
    const stdout = [
      "Getting env variables for app orders-srv in org demo / space dev as user@example.com...",
      "",
      "System-Provided:",
      "VCAP_SERVICES: {",
      '  "hana": []',
      "}",
      "",
      "VCAP_APPLICATION: {",
      '  "application_name": "orders-srv"',
      "}",
    ].join("\n");

    expect(JSON.parse(extractVcapServicesSection(stdout))).toEqual({ hana: [] });
  });

  it("extracts hana bindings when VCAP_APPLICATION is absent", () => {
    const stdout = [
      "System-Provided:",
      "VCAP_SERVICES: {",
      '  "hana": []',
      "}",
      "",
    ].join("\n");

    expect(extractHanaBindingsFromCfEnv(stdout)).toEqual([]);
  });

  it("rejects malformed hana credential payloads", () => {
    const raw = JSON.stringify({
      hana: [
        {
          name: "hana-primary",
          credentials: {
            ...VALID_HANA_CREDENTIALS,
            password: 123,
          },
        },
      ],
    });

    expect(() => parseHanaBindings(raw)).toThrow(/password/);
  });

  it("rejects cf env output without a VCAP_SERVICES block", () => {
    expect(() => extractVcapServicesSection("no services here")).toThrow(/VCAP_SERVICES section/);
  });

  it("rejects invalid VCAP_SERVICES JSON", () => {
    expect(() => parseHanaBindings("{not-json")).toThrow(/not valid JSON/);
  });

  it("rejects non-object VCAP_SERVICES payloads", () => {
    expect(() => parseHanaBindings(JSON.stringify(["hana"]))).toThrow(/JSON object/);
  });

  it("rejects non-array hana payloads", () => {
    expect(() => parseHanaBindings(JSON.stringify({ hana: "nope" }))).toThrow(/hana must be an array/);
  });

  it("rejects hana bindings that are not objects", () => {
    expect(() => parseHanaBindings(JSON.stringify({ hana: [null] }))).toThrow(/HANA binding must be an object/);
  });

  it("rejects hana bindings without credentials", () => {
    expect(() => parseHanaBindings(JSON.stringify({ hana: [{ name: "hana-primary" }] }))).toThrow(
      /HANA credentials must be an object/,
    );
  });
});
