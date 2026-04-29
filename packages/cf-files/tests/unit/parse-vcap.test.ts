import { describe, expect, it } from "vitest";

import { parseDefaultEnv, parseVcapServices } from "../../src/parse-vcap.js";

describe("parseDefaultEnv", () => {
  it("extracts VCAP_APPLICATION, VCAP_SERVICES, and user-provided env vars", () => {
    const raw = [
      "Getting env variables for app demo-app in org demo-org / space dev as user@example.com...",
      "OK",
      "",
      "System-Provided:",
      "{",
      '  "VCAP_APPLICATION": {',
      '    "application_id": "app-guid",',
      '    "application_name": "demo-app"',
      "  },",
      '  "VCAP_SERVICES": {',
      '    "xsuaa": [{',
      '      "name": "demo-xsuaa",',
      '      "credentials": { "clientid": "abc" }',
      "    }]",
      "  }",
      "}",
      "",
      "User-Provided:",
      "destinations: [",
      '  { "name": "backend", "url": "https://example.com", "forwardAuthToken": true }',
      "]",
      "FEATURE_FLAG: true",
      "APP_MODE: local",
    ].join("\n");

    expect(parseDefaultEnv(raw)).toEqual({
      VCAP_APPLICATION: {
        application_id: "app-guid",
        application_name: "demo-app",
      },
      VCAP_SERVICES: {
        xsuaa: [{ name: "demo-xsuaa", credentials: { clientid: "abc" } }],
      },
      destinations: [
        {
          name: "backend",
          url: "https://example.com",
          forwardAuthToken: true,
        },
      ],
      FEATURE_FLAG: true,
      APP_MODE: "local",
    });
  });

  it("stays compatible with simplified inline VCAP output", () => {
    const raw = [
      "System-Provided:",
      'VCAP_SERVICES: {"xsuaa":[{"credentials":{"clientid":"demo"}}]}',
      "",
      'VCAP_APPLICATION: {"application_id":"x"}',
      "",
      "User-Provided:",
      "(empty)",
    ].join("\n");

    expect(parseDefaultEnv(raw)).toEqual({
      VCAP_SERVICES: { xsuaa: [{ credentials: { clientid: "demo" } }] },
      VCAP_APPLICATION: { application_id: "x" },
    });
  });
});

describe("parseVcapServices", () => {
  it("extracts VCAP_SERVICES JSON from cf env output", () => {
    const raw = [
      "Getting env variables for app demo-app in org demo-org / space dev as user@example.com...",
      "OK",
      "",
      "System-Provided:",
      'VCAP_SERVICES: {"xsuaa":[{"name":"demo-xsuaa","credentials":{"clientid":"abc"}}]}',
      "",
      'VCAP_APPLICATION: {"application_id":"x"}',
      "",
    ].join("\n");

    const result = parseVcapServices(raw);
    expect(result).toEqual({
      xsuaa: [{ name: "demo-xsuaa", credentials: { clientid: "abc" } }],
    });
  });

  it("handles pretty-printed multi-line JSON", () => {
    const raw = [
      "System-Provided:",
      "VCAP_SERVICES: {",
      '  "hana": [',
      "    {",
      '      "name": "demo-db",',
      '      "credentials": {',
      '        "host": "host.example.com",',
      '        "port": 30015',
      "      }",
      "    }",
      "  ]",
      "}",
      "",
      "VCAP_APPLICATION: {}",
    ].join("\n");

    const result = parseVcapServices(raw);
    expect(result).toEqual({
      hana: [
        {
          name: "demo-db",
          credentials: { host: "host.example.com", port: 30015 },
        },
      ],
    });
  });

  it("handles nested braces inside string values", () => {
    const raw = 'VCAP_SERVICES: {"a":{"b":"x{y}z"}}';
    expect(parseVcapServices(raw)).toEqual({ a: { b: "x{y}z" } });
  });

  it("throws when VCAP_SERVICES marker is missing", () => {
    expect(() => parseVcapServices("no marker at all")).toThrow(/VCAP_SERVICES block not found/);
  });

  it("throws when opening brace is missing after marker", () => {
    expect(() => parseVcapServices("VCAP_SERVICES:")).toThrow(/JSON payload not found/);
  });

  it("throws when JSON is unterminated", () => {
    expect(() => parseVcapServices('VCAP_SERVICES: {"a":1')).toThrow(/Malformed VCAP_SERVICES/);
  });

  it("throws when payload is not valid JSON", () => {
    expect(() => parseVcapServices("VCAP_SERVICES: {not valid json}")).toThrow(
      /Failed to parse VCAP_SERVICES JSON/,
    );
  });
});
