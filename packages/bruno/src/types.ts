import type { RegionKey } from "@saptools/cf-sync";

export interface CfAppRef {
  readonly region: RegionKey;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface BruVarsBlock {
  readonly entries: ReadonlyMap<string, string>;
}

export interface BruEnvFile {
  readonly path: string;
  readonly name: string;
  readonly raw: string;
  readonly vars: BruVarsBlock;
  readonly secrets: readonly string[];
}

export interface AppFolder {
  readonly path: string;
  readonly name: string;
  readonly environments: readonly BruEnvFile[];
}

export interface SpaceFolder {
  readonly path: string;
  readonly name: string;
  readonly apps: readonly AppFolder[];
}

export interface OrgFolder {
  readonly path: string;
  readonly name: string;
  readonly spaces: readonly SpaceFolder[];
}

export interface RegionFolder {
  readonly path: string;
  readonly key: string;
  readonly orgs: readonly OrgFolder[];
}

export interface BrunoCollection {
  readonly root: string;
  readonly regions: readonly RegionFolder[];
}

export interface BrunoContext {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly updatedAt: string;
}

export interface CfRoute {
  readonly url: string;
}

export const CF_META_KEYS = ["__cf_region", "__cf_org", "__cf_space", "__cf_app"] as const;
export type CfMetaKey = (typeof CF_META_KEYS)[number];
