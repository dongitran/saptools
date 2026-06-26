// Local minimal region type; values match cf-sync catalog exactly.
export interface CfRegion {
  readonly key: string;
  readonly apiEndpoint: string;
}

export const REGIONS: Readonly<Record<string, CfRegion>> = {
  ae01: { key: "ae01", apiEndpoint: "https://api.cf.ae01.hana.ondemand.com" },
  ap01: { key: "ap01", apiEndpoint: "https://api.cf.ap01.hana.ondemand.com" },
  ap10: { key: "ap10", apiEndpoint: "https://api.cf.ap10.hana.ondemand.com" },
  ap11: { key: "ap11", apiEndpoint: "https://api.cf.ap11.hana.ondemand.com" },
  ap12: { key: "ap12", apiEndpoint: "https://api.cf.ap12.hana.ondemand.com" },
  ap20: { key: "ap20", apiEndpoint: "https://api.cf.ap20.hana.ondemand.com" },
  ap21: { key: "ap21", apiEndpoint: "https://api.cf.ap21.hana.ondemand.com" },
  ap30: { key: "ap30", apiEndpoint: "https://api.cf.ap30.hana.ondemand.com" },
  br10: { key: "br10", apiEndpoint: "https://api.cf.br10.hana.ondemand.com" },
  br20: { key: "br20", apiEndpoint: "https://api.cf.br20.hana.ondemand.com" },
  br30: { key: "br30", apiEndpoint: "https://api.cf.br30.hana.ondemand.com" },
  ca10: { key: "ca10", apiEndpoint: "https://api.cf.ca10.hana.ondemand.com" },
  ca20: { key: "ca20", apiEndpoint: "https://api.cf.ca20.hana.ondemand.com" },
  ch20: { key: "ch20", apiEndpoint: "https://api.cf.ch20.hana.ondemand.com" },
  cn20: { key: "cn20", apiEndpoint: "https://api.cf.cn20.platform.sapcloud.cn" },
  cn40: { key: "cn40", apiEndpoint: "https://api.cf.cn40.platform.sapcloud.cn" },
  eu01: { key: "eu01", apiEndpoint: "https://api.cf.eu01.hana.ondemand.com" },
  eu02: { key: "eu02", apiEndpoint: "https://api.cf.eu02.hana.ondemand.com" },
  eu10: { key: "eu10", apiEndpoint: "https://api.cf.eu10.hana.ondemand.com" },
  "eu10-002": { key: "eu10-002", apiEndpoint: "https://api.cf.eu10-002.hana.ondemand.com" },
  "eu10-003": { key: "eu10-003", apiEndpoint: "https://api.cf.eu10-003.hana.ondemand.com" },
  "eu10-004": { key: "eu10-004", apiEndpoint: "https://api.cf.eu10-004.hana.ondemand.com" },
  "eu10-005": { key: "eu10-005", apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com" },
  "eu10-006": { key: "eu10-006", apiEndpoint: "https://api.cf.eu10-006.hana.ondemand.com" },
  eu11: { key: "eu11", apiEndpoint: "https://api.cf.eu11.hana.ondemand.com" },
  eu13: { key: "eu13", apiEndpoint: "https://api.cf.eu13.hana.ondemand.com" },
  eu20: { key: "eu20", apiEndpoint: "https://api.cf.eu20.hana.ondemand.com" },
  "eu20-001": { key: "eu20-001", apiEndpoint: "https://api.cf.eu20-001.hana.ondemand.com" },
  "eu20-002": { key: "eu20-002", apiEndpoint: "https://api.cf.eu20-002.hana.ondemand.com" },
  eu22: { key: "eu22", apiEndpoint: "https://api.cf.eu22.hana.ondemand.com" },
  eu30: { key: "eu30", apiEndpoint: "https://api.cf.eu30.hana.ondemand.com" },
  il30: { key: "il30", apiEndpoint: "https://api.cf.il30.hana.ondemand.com" },
  in30: { key: "in30", apiEndpoint: "https://api.cf.in30.hana.ondemand.com" },
  jp01: { key: "jp01", apiEndpoint: "https://api.cf.jp01.hana.ondemand.com" },
  jp10: { key: "jp10", apiEndpoint: "https://api.cf.jp10.hana.ondemand.com" },
  jp20: { key: "jp20", apiEndpoint: "https://api.cf.jp20.hana.ondemand.com" },
  jp30: { key: "jp30", apiEndpoint: "https://api.cf.jp30.hana.ondemand.com" },
  jp31: { key: "jp31", apiEndpoint: "https://api.cf.jp31.hana.ondemand.com" },
  sa30: { key: "sa30", apiEndpoint: "https://api.cf.sa30.hana.ondemand.com" },
  sa31: { key: "sa31", apiEndpoint: "https://api.cf.sa31.hana.ondemand.com" },
  uk20: { key: "uk20", apiEndpoint: "https://api.cf.uk20.hana.ondemand.com" },
  us01: { key: "us01", apiEndpoint: "https://api.cf.us01.hana.ondemand.com" },
  us02: { key: "us02", apiEndpoint: "https://api.cf.us02.hana.ondemand.com" },
  us10: { key: "us10", apiEndpoint: "https://api.cf.us10.hana.ondemand.com" },
  "us10-001": { key: "us10-001", apiEndpoint: "https://api.cf.us10-001.hana.ondemand.com" },
  "us10-002": { key: "us10-002", apiEndpoint: "https://api.cf.us10-002.hana.ondemand.com" },
  us11: { key: "us11", apiEndpoint: "https://api.cf.us11.hana.ondemand.com" },
  us20: { key: "us20", apiEndpoint: "https://api.cf.us20.hana.ondemand.com" },
  us21: { key: "us21", apiEndpoint: "https://api.cf.us21.hana.ondemand.com" },
  us30: { key: "us30", apiEndpoint: "https://api.cf.us30.hana.ondemand.com" },
};

export function getAllRegions(): readonly CfRegion[] {
  return Object.values(REGIONS);
}

export function resolveApiEndpointForRegion(key: string): string {
  const region = REGIONS[key];
  if (region === undefined) {
    throw new Error(`Unknown CF region: ${key}`);
  }
  return region.apiEndpoint;
}

export function regionKeyForApiEndpoint(apiEndpoint: string): string | undefined {
  const normalized = normalizeApiEndpoint(apiEndpoint);
  return getAllRegions().find((r) => normalizeApiEndpoint(r.apiEndpoint) === normalized)?.key;
}

function normalizeApiEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
}
