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
  eu10: "https://api.cf.eu10.hana.ondemand.com",
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu12: "https://api.cf.eu12.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  eu21: "https://api.cf.eu21.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  eu31: "https://api.cf.eu31.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  kr30: "https://api.cf.kr30.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  us11: "https://api.cf.us11.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
  us31: "https://api.cf.us31.hana.ondemand.com",
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
