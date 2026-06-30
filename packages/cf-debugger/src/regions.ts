export interface RegionInfo {
  readonly key: string;
  readonly apiEndpoint: string;
}

const REGION_API_ENDPOINTS: Readonly<Record<string, string>> = {
  ae01: "https://api.cf.ae01.hana.ondemand.com",
  ap01: "https://api.cf.ap01.hana.ondemand.com",
  ap10: "https://api.cf.ap10.hana.ondemand.com",
  ap11: "https://api.cf.ap11.hana.ondemand.com",
  ap12: "https://api.cf.ap12.hana.ondemand.com",
  ap20: "https://api.cf.ap20.hana.ondemand.com",
  ap21: "https://api.cf.ap21.hana.ondemand.com",
  ap30: "https://api.cf.ap30.hana.ondemand.com",
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
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu13: "https://api.cf.eu13.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  "eu20-001": "https://api.cf.eu20-001.hana.ondemand.com",
  "eu20-002": "https://api.cf.eu20-002.hana.ondemand.com",
  eu22: "https://api.cf.eu22.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  il30: "https://api.cf.il30.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp01: "https://api.cf.jp01.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  jp31: "https://api.cf.jp31.hana.ondemand.com",
  sa30: "https://api.cf.sa30.hana.ondemand.com",
  sa31: "https://api.cf.sa31.hana.ondemand.com",
  uk20: "https://api.cf.uk20.hana.ondemand.com",
  us01: "https://api.cf.us01.hana.ondemand.com",
  us02: "https://api.cf.us02.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  "us10-001": "https://api.cf.us10-001.hana.ondemand.com",
  "us10-002": "https://api.cf.us10-002.hana.ondemand.com",
  us11: "https://api.cf.us11.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
};

export function resolveApiEndpoint(regionKey: string, override?: string): string {
  if (override !== undefined && override !== "") {
    return override;
  }
  const endpoint = REGION_API_ENDPOINTS[regionKey];
  if (endpoint === undefined) {
    throw new Error(
      `Unknown region key: ${regionKey}. Pass \`apiEndpoint\` explicitly to override.`,
    );
  }
  return endpoint;
}

export function listKnownRegionKeys(): readonly string[] {
  return Object.keys(REGION_API_ENDPOINTS);
}
