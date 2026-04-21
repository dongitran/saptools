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

export interface DecodedTokenClaims {
  readonly appId?: string | undefined;
  readonly appDisplayName?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt?: number | undefined;
  readonly issuedAt?: number | undefined;
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
  readonly childCount?: number;
  readonly webUrl?: string;
}

export interface FolderTreeNode {
  readonly name: string;
  readonly path: string;
  readonly fileCount: number;
  readonly folderCount: number;
  readonly totalSize: number;
  readonly children: readonly FolderTreeNode[];
}

export interface TreeWalkLimits {
  readonly maxDepth: number;
  readonly maxEntriesPerFolder: number;
  readonly maxTotalEntries: number;
}

export interface ValidateExpectation {
  readonly rootPath: string;
  readonly subdirectories: readonly string[];
}

export interface ValidateResultEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly isFolder: boolean;
}

export interface ValidateResult {
  readonly root: ValidateResultEntry;
  readonly subdirectories: readonly ValidateResultEntry[];
  readonly allPresent: boolean;
}

export interface WriteTestResult {
  readonly created: boolean;
  readonly deleted: boolean;
  readonly probePath: string;
  readonly itemId?: string;
  readonly error?: string;
}

export const DEFAULT_TREE_LIMITS: TreeWalkLimits = {
  maxDepth: 3,
  maxEntriesPerFolder: 500,
  maxTotalEntries: 10_000,
};

export const ENV_TENANT = "SHAREPOINT_TENANT_ID";
export const ENV_CLIENT_ID = "SHAREPOINT_CLIENT_ID";
export const ENV_CLIENT_SECRET = "SHAREPOINT_CLIENT_SECRET";
export const ENV_SITE = "SHAREPOINT_SITE";
export const ENV_ROOT = "SHAREPOINT_ROOT_DIR";
export const ENV_SUBDIRS = "SHAREPOINT_SUBDIRS";
export const ENV_AUTH_BASE = "SHAREPOINT_AUTH_BASE";
export const ENV_GRAPH_BASE = "SHAREPOINT_GRAPH_BASE";

export const DEFAULT_AUTH_BASE = "https://login.microsoftonline.com";
export const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
