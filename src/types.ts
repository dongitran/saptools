// Supported SAP BTP Cloud Foundry regions
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

// HANA credentials extracted from VCAP_SERVICES
export interface HanaCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdiUser: string;
  readonly hdiPassword: string;
  readonly url: string;
  readonly databaseId: string;
  readonly certificate: string;
}

// One app's extracted entry written to the output file
export interface AppHanaEntry {
  readonly app: string;
  readonly org: string;
  readonly space: string;
  readonly region: RegionKey;
  readonly hana: HanaCredentials;
}

// Raw shape inside VCAP_SERVICES["hana"][0]["credentials"]
export interface RawHanaCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdi_user: string;
  readonly hdi_password: string;
  readonly url: string;
  readonly database_id: string;
  readonly certificate: string;
}

export interface RawHanaBinding {
  readonly credentials: RawHanaCredentials;
}

export interface RawVcapServices {
  readonly hana?: readonly RawHanaBinding[];
}
