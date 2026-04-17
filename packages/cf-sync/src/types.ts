export const REGION_KEYS = [
  "ae01",
  "ap01",
  "ap10",
  "ap11",
  "ap12",
  "ap20",
  "ap21",
  "ap30",
  "br10",
  "br20",
  "br30",
  "ca10",
  "ca20",
  "ch20",
  "cn20",
  "cn40",
  "eu01",
  "eu02",
  "eu10",
  "eu11",
  "eu13",
  "eu20",
  "eu22",
  "eu30",
  "il30",
  "in30",
  "jp01",
  "jp10",
  "jp20",
  "jp30",
  "jp31",
  "sa30",
  "sa31",
  "uk20",
  "us01",
  "us02",
  "us10",
  "us11",
  "us20",
  "us21",
  "us30",
] as const;

export type RegionKey = (typeof REGION_KEYS)[number];

export interface Region {
  readonly key: RegionKey;
  readonly label: string;
  readonly apiEndpoint: string;
}

export interface AppNode {
  readonly name: string;
}

export interface SpaceNode {
  readonly name: string;
  readonly apps: readonly AppNode[];
}

export interface OrgNode {
  readonly name: string;
  readonly spaces: readonly SpaceNode[];
}

export interface RegionNode {
  readonly key: RegionKey;
  readonly label: string;
  readonly apiEndpoint: string;
  readonly accessible: boolean;
  readonly orgs: readonly OrgNode[];
}

export interface CfStructure {
  readonly syncedAt: string;
  readonly regions: readonly RegionNode[];
}
