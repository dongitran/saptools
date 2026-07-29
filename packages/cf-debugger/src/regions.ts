import { hasControlCharacter } from "./input-validation.js";
import { CfDebuggerError } from "./types.js";

export interface RegionInfo {
  readonly key: string;
  readonly apiEndpoint: string;
}

const REGION_KEY_PATTERN = /^[a-z]{2}\d{2}(?:-\d{3})?$/;

const REGION_API_ENDPOINTS: Readonly<Record<string, string>> = {
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

function synthesizeApiEndpoint(regionKey: string): string {
  const domain = regionKey.startsWith("cn")
    ? "platform.sapcloud.cn"
    : "hana.ondemand.com";
  return `https://api.cf.${regionKey}.${domain}`;
}

function rejectApiEndpoint(raw: string, reason: string): CfDebuggerError {
  return new CfDebuggerError(
    "UNSAFE_INPUT",
    `Invalid --api-endpoint ${JSON.stringify(raw)}: ${reason}. ` +
      "Expected an absolute https URL such as https://api.cf.<region>.hana.ondemand.com.",
  );
}

export function validateApiEndpointOverride(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "Invalid --api-endpoint value: it must be a string.",
    );
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw rejectApiEndpoint(raw, "the value is empty or whitespace only");
  }
  if (value !== raw) {
    throw rejectApiEndpoint(raw, "it contains surrounding whitespace");
  }
  if (value.startsWith("-")) {
    throw rejectApiEndpoint(raw, "a leading hyphen would be parsed as a cf CLI flag");
  }
  if (hasControlCharacter(value)) {
    throw rejectApiEndpoint(raw, "it contains control characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw rejectApiEndpoint(raw, "it is not a parseable absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw rejectApiEndpoint(
      raw,
      `the scheme must be https, not ${parsed.protocol.replace(":", "")} ` +
        "(credentials are sent to this endpoint)",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw rejectApiEndpoint(raw, "it must not embed userinfo credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw rejectApiEndpoint(raw, "it must not carry a query string or fragment");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw rejectApiEndpoint(raw, "it must not carry a path");
  }
  if (parsed.hostname === "") {
    throw rejectApiEndpoint(raw, "it has no host");
  }
  return value;
}

export function resolveApiEndpoint(
  regionKey: string,
  override?: string,
  onWarning?: (warning: string) => void,
): string {
  if (override !== undefined) {
    return validateApiEndpointOverride(override);
  }
  if (!REGION_KEY_PATTERN.test(regionKey)) {
    throw new CfDebuggerError(
      "UNKNOWN_REGION",
      `Unknown region key: ${JSON.stringify(regionKey)}. Expected a key matching aa00 or aa00-000, or pass --api-endpoint <url>.`,
    );
  }
  const endpoint = Object.hasOwn(REGION_API_ENDPOINTS, regionKey)
    ? REGION_API_ENDPOINTS[regionKey]
    : undefined;
  if (endpoint !== undefined) {
    return endpoint;
  }
  const synthesized = synthesizeApiEndpoint(regionKey);
  onWarning?.(
    `Region key ${regionKey} is not in the curated region list; using synthesized API endpoint ${synthesized}. Verify it or pass --api-endpoint <url>.`,
  );
  return synthesized;
}

export function listKnownRegionKeys(): readonly string[] {
  return Object.keys(REGION_API_ENDPOINTS);
}
