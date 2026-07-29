import { describe, expect, it } from "vitest";

import { regionKeyFromSapApiEndpoint } from "../../src/cloud-foundry/commands.js";
import {
  listKnownRegionKeys,
  resolveApiEndpoint,
  validateApiEndpointOverride,
} from "../../src/regions.js";
import { CfDebuggerError } from "../../src/types.js";

const CURATED_REGIONS: Readonly<Record<string, string>> = {
  ae01: "https://api.cf.ae01.hana.ondemand.com",
  ap01: "https://api.cf.ap01.hana.ondemand.com",
  ap10: "https://api.cf.ap10.hana.ondemand.com",
  ap11: "https://api.cf.ap11.hana.ondemand.com",
  ap12: "https://api.cf.ap12.hana.ondemand.com",
  ap20: "https://api.cf.ap20.hana.ondemand.com",
  ap21: "https://api.cf.ap21.hana.ondemand.com",
  ap30: "https://api.cf.ap30.hana.ondemand.com",
  ap31: "https://api.cf.ap31.hana.ondemand.com",
  br10: "https://api.cf.br10.hana.ondemand.com",
  br20: "https://api.cf.br20.hana.ondemand.com",
  br30: "https://api.cf.br30.hana.ondemand.com",
  ca10: "https://api.cf.ca10.hana.ondemand.com",
  ca20: "https://api.cf.ca20.hana.ondemand.com",
  ch20: "https://api.cf.ch20.hana.ondemand.com",
  cn20: "https://api.cf.cn20.platform.sapcloud.cn",
  cn40: "https://api.cf.cn40.platform.sapcloud.cn",
  eu01: "https://api.cf.eu01.hana.ondemand.com",
  eu02: "https://api.cf.eu02.hana.ondemand.com",
  eu10: "https://api.cf.eu10.hana.ondemand.com",
  "eu10-002": "https://api.cf.eu10-002.hana.ondemand.com",
  "eu10-003": "https://api.cf.eu10-003.hana.ondemand.com",
  "eu10-004": "https://api.cf.eu10-004.hana.ondemand.com",
  "eu10-005": "https://api.cf.eu10-005.hana.ondemand.com",
  "eu10-006": "https://api.cf.eu10-006.hana.ondemand.com",
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu12: "https://api.cf.eu12.hana.ondemand.com",
  eu13: "https://api.cf.eu13.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  "eu20-001": "https://api.cf.eu20-001.hana.ondemand.com",
  "eu20-002": "https://api.cf.eu20-002.hana.ondemand.com",
  eu21: "https://api.cf.eu21.hana.ondemand.com",
  eu22: "https://api.cf.eu22.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  eu31: "https://api.cf.eu31.hana.ondemand.com",
  il30: "https://api.cf.il30.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp01: "https://api.cf.jp01.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  jp31: "https://api.cf.jp31.hana.ondemand.com",
  kr30: "https://api.cf.kr30.hana.ondemand.com",
  sa30: "https://api.cf.sa30.hana.ondemand.com",
  sa31: "https://api.cf.sa31.hana.ondemand.com",
  uk20: "https://api.cf.uk20.hana.ondemand.com",
  us01: "https://api.cf.us01.hana.ondemand.com",
  us02: "https://api.cf.us02.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  "us10-001": "https://api.cf.us10-001.hana.ondemand.com",
  "us10-002": "https://api.cf.us10-002.hana.ondemand.com",
  "us10-003": "https://api.cf.us10-003.hana.ondemand.com",
  us11: "https://api.cf.us11.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  "us21-001": "https://api.cf.us21-001.hana.ondemand.com",
  us22: "https://api.cf.us22.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
  us31: "https://api.cf.us31.hana.ondemand.com",
  us32: "https://api.cf.us32.hana.ondemand.com",
};

describe("resolveApiEndpoint", () => {
  it.each(Object.entries(CURATED_REGIONS))(
    "keeps the curated mapping for %s",
    (region, endpoint) => {
      expect(resolveApiEndpoint(region)).toBe(endpoint);
    },
  );

  it.each([
    "ap31",
    "eu10-006",
    "eu12",
    "eu21",
    "eu31",
    "us10-003",
    "us21-001",
    "us22",
    "us32",
  ])("includes newly curated region %s", (region) => {
    const endpoint = CURATED_REGIONS[region];
    expect(endpoint).toBeDefined();
    expect(resolveApiEndpoint(region)).toBe(endpoint);
  });

  it("maps curated China regions to the SAP China domain", () => {
    expect(resolveApiEndpoint("cn20")).toBe("https://api.cf.cn20.platform.sapcloud.cn");
    expect(resolveApiEndpoint("cn40")).toBe("https://api.cf.cn40.platform.sapcloud.cn");
  });

  it("synthesizes uncurated region endpoints and warns", () => {
    const warnings: string[] = [];

    expect(resolveApiEndpoint("ap13", undefined, (warning) => warnings.push(warning))).toBe(
      "https://api.cf.ap13.hana.ondemand.com",
    );
    expect(warnings).toEqual([
      expect.stringContaining(
        "ap13 is not in the curated region list; using synthesized API endpoint https://api.cf.ap13.hana.ondemand.com",
      ),
    ]);
  });

  it("derives the China domain for an uncurated cn-family key", () => {
    expect(resolveApiEndpoint("cn99")).toBe(
      "https://api.cf.cn99.platform.sapcloud.cn",
    );
  });

  it("honours a validated HTTPS override before region validation or warning", () => {
    const warnings: string[] = [];

    expect(resolveApiEndpoint("nonsense", "https://custom.example.com", (warning) => {
      warnings.push(warning);
    })).toBe(
      "https://custom.example.com",
    );
    expect(warnings).toEqual([]);
  });

  it.each([
    ["plaintext HTTP", "http://plaintext.example"],
    ["FTP", "ftp://x"],
    ["leading CLI flag", "--skip-ssl-validation"],
    ["whitespace only", "   "],
    ["surrounding whitespace", " https://api.cf.internal.example"],
    ["userinfo", "https://u:p@h.example"],
    ["query", "https://h.example/?x=1"],
    ["fragment", "https://h.example/#x"],
    ["path", "https://h.example/x"],
    ["control character", "https://h.example/\n"],
    ["non-URL", "not-a-url"],
  ])("rejects an unsafe %s endpoint override", (_name, endpoint) => {
    expect(() => resolveApiEndpoint("eu10", endpoint)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_INPUT" }),
    );
  });

  it("accepts a private HTTPS API endpoint without host allowlisting", () => {
    expect(resolveApiEndpoint("nonsense", "https://api.cf.internal.example")).toBe(
      "https://api.cf.internal.example",
    );
  });

  it("rejects non-string programmatic endpoint input with a coded error", () => {
    expect(() => validateApiEndpointOverride(42)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_INPUT" }),
    );
  });

  it.each([
    "nonsense",
    "EU10",
    "eu1",
    "eu10-01",
    "eu10-0000",
    "toString",
    "constructor",
    "__proto__",
  ])(
    "throws UNKNOWN_REGION for malformed key %s",
    (region) => {
      expect.assertions(3);
      try {
        resolveApiEndpoint(region);
      } catch (error) {
        if (!(error instanceof CfDebuggerError)) {
          throw error;
        }
        expect(error).toBeInstanceOf(CfDebuggerError);
        expect(error).toMatchObject({ code: "UNKNOWN_REGION" });
        expect(error.message).toMatch(/--api-endpoint/);
      }
    },
  );

  it("does not warn for curated regions", () => {
    const warnings: string[] = [];

    expect(resolveApiEndpoint("eu10", undefined, (warning) => warnings.push(warning))).toBe(
      "https://api.cf.eu10.hana.ondemand.com",
    );
    expect(warnings).toEqual([]);
  });

  it("ignores inherited endpoints for valid-shaped uncurated keys", () => {
    const key = "zz99";
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const warnings: string[] = [];
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      value: "https://attacker.invalid",
    });
    try {
      expect(resolveApiEndpoint(key, undefined, (warning) => warnings.push(warning))).toBe(
        "https://api.cf.zz99.hana.ondemand.com",
      );
      expect(warnings).toHaveLength(1);
    } finally {
      if (inherited === undefined) {
        Reflect.deleteProperty(Object.prototype, key);
      } else {
        Object.defineProperty(Object.prototype, key, inherited);
      }
    }
  });

  it("lists exactly the curated regions", () => {
    const keys = listKnownRegionKeys();
    expect(keys).toHaveLength(Object.keys(CURATED_REGIONS).length);
    expect(new Set(keys)).toEqual(new Set(Object.keys(CURATED_REGIONS)));
    expect(keys).not.toContain("ap13");
  });

  it("round-trips every curated region through the reverse endpoint mapper", () => {
    for (const region of listKnownRegionKeys()) {
      expect(regionKeyFromSapApiEndpoint(resolveApiEndpoint(region))).toBe(region);
    }
  });

  it.each(["ap13", "eu99", "cn99"])(
    "round-trips synthesized region %s through the reverse endpoint mapper",
    (region) => {
      expect(regionKeyFromSapApiEndpoint(resolveApiEndpoint(region))).toBe(region);
    },
  );

  it.each([
    "https://api.cf.cn20.hana.ondemand.com",
    "https://api.cf.eu10.platform.sapcloud.cn",
  ])("rejects a SAP region paired with the wrong domain: %s", (endpoint) => {
    expect(regionKeyFromSapApiEndpoint(endpoint)).toBeUndefined();
  });
});
