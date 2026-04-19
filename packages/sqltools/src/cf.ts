import { cfApi, cfAuth, cfEnv, cfTargetSpace, getRegion, REGION_KEYS } from "@saptools/cf-sync";

import { extractVcapServicesSection } from "./parser.js";

export type { RegionKey } from "@saptools/cf-sync";

export function assertRegionKey(region: string): asserts region is (typeof REGION_KEYS)[number] {
  if (!(REGION_KEYS as readonly string[]).includes(region)) {
    throw new Error(`Unknown region key: ${region}`);
  }
}

export interface CfLoginTargetInput {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly email: string;
  readonly password: string;
}

export async function cfLoginAndTarget(input: CfLoginTargetInput): Promise<void> {
  assertRegionKey(input.region);
  const region = getRegion(input.region);
  await cfApi(region.apiEndpoint);
  await cfAuth(input.email, input.password);
  await cfTargetSpace(input.org, input.space);
}

export async function cfAppVcapServices(appName: string): Promise<string> {
  const stdout = await cfEnv(appName);
  return extractVcapServicesSection(stdout);
}
