import type { Region, RegionKey } from "./types.js";

// Map of all supported SAP BTP Cloud Foundry regions
export const REGIONS: Readonly<Record<RegionKey, Region>> = {
  ap11: {
    key: "ap11",
    label: "Singapore - AWS (ap11)",
    apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
  },
  br10: {
    key: "br10",
    label: "Brazil São Paulo - AWS (br10)",
    apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
  },
};

export function getRegion(key: RegionKey): Region {
  const region = REGIONS[key];
  // REGION_KEYS as const guarantees key is always valid
  return region;
}

export function getAllRegions(): Region[] {
  return Object.values(REGIONS);
}
