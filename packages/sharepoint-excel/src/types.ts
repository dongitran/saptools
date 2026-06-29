export type SecretStoreKind = "keyring" | "file";

export interface SharePointCredentials {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SharePointSiteRef {
  readonly hostname: string;
  readonly sitePath: string;
}

export interface SharePointTarget {
  readonly credentials: SharePointCredentials;
  readonly site: SharePointSiteRef;
}

export interface AccessTokenInfo {
  readonly accessToken: string;
  readonly expiresOn: number;
  readonly tokenType: string;
  readonly scope?: string;
}

export interface SharePointSite {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly webUrl: string;
}

export interface SharePointDrive {
  readonly id: string;
  readonly name: string;
  readonly driveType: string;
  readonly webUrl: string;
}

export interface DriveItemSummary {
  readonly id: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly size: number;
  readonly eTag?: string;
  readonly cTag?: string;
  readonly webUrl?: string;
}

export interface StoredProfile {
  readonly name: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly site: string;
  readonly drive?: string;
  readonly secretStore: SecretStoreKind;
  readonly updatedAt: string;
}

export interface RedactedProfile extends Omit<StoredProfile, "clientId"> {
  readonly clientId: string;
  readonly hasClientSecret: boolean;
}

export type JsonCellValue = string | number | boolean | null;
export type JsonRow = readonly JsonCellValue[];
export type JsonRecord = Readonly<Record<string, JsonCellValue>>;
export type WorkbookInputRow = JsonRow | JsonRecord;

export interface WorkbookCreateInput {
  readonly sheetName: string;
  readonly headers: readonly string[];
  readonly rows: readonly WorkbookInputRow[];
  readonly tableName?: string;
}

export interface WorkbookReadOptions {
  readonly sheetName?: string;
  readonly range?: string;
}

export interface WorkbookSheetReadResult {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: readonly JsonRow[];
}

export interface WorkbookReadResult {
  readonly sheets: readonly WorkbookSheetReadResult[];
}

export interface WorkbookMutationResult {
  readonly bytes: Uint8Array;
  readonly sheetName: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_AUTH_BASE = "https://login.microsoftonline.com";
export const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const ENV_TENANT = "SHAREPOINT_EXCEL_TENANT_ID";
export const ENV_CLIENT_ID = "SHAREPOINT_EXCEL_CLIENT_ID";
export const ENV_CLIENT_SECRET = "SHAREPOINT_EXCEL_CLIENT_SECRET";
export const ENV_SITE = "SHAREPOINT_EXCEL_SITE";
export const ENV_DRIVE = "SHAREPOINT_EXCEL_DRIVE";
export const ENV_PROFILE = "SHAREPOINT_EXCEL_PROFILE";
export const ENV_AUTH_BASE = "SHAREPOINT_EXCEL_AUTH_BASE";
export const ENV_GRAPH_BASE = "SHAREPOINT_EXCEL_GRAPH_BASE";
export const ENV_HOME = "SAPTOOLS_SHAREPOINT_EXCEL_HOME";
export const ENV_ALLOW_PLAINTEXT = "SAPTOOLS_SHAREPOINT_EXCEL_ALLOW_PLAINTEXT";

export const FALLBACK_ENV_TENANT = "SHAREPOINT_TENANT_ID";
export const FALLBACK_ENV_CLIENT_ID = "SHAREPOINT_CLIENT_ID";
export const FALLBACK_ENV_CLIENT_SECRET = "SHAREPOINT_CLIENT_SECRET";
export const FALLBACK_ENV_SITE = "SHAREPOINT_SITE";
export const FALLBACK_ENV_DRIVE = "SHAREPOINT_DRIVE";
