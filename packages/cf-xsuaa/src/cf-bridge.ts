import process from "node:process";

import {
  cfApi,
  cfAuth,
  cfEnv,
  cfTargetSpace,
  getRegion,
  REGION_KEYS,
  type RegionKey,
} from "@saptools/cf-sync";

import type { AppRef, XsuaaCredentials } from "./types.js";
import { parseXsuaaFromVcap } from "./vcap.js";

function assertRegionKey(region: string): asserts region is RegionKey {
  if (!(REGION_KEYS as readonly string[]).includes(region)) {
    throw new Error(`Unknown region key: ${region}`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export async function fetchAppXsuaaCredentials(ref: AppRef): Promise<XsuaaCredentials> {
  assertRegionKey(ref.region);
  const email = requireEnv("SAP_EMAIL");
  const password = requireEnv("SAP_PASSWORD");

  const region = getRegion(ref.region);
  await cfApi(region.apiEndpoint);
  await cfAuth(email, password);
  await cfTargetSpace(ref.org, ref.space);
  const stdout = await cfEnv(ref.app);
  return parseXsuaaFromVcap(stdout);
}
