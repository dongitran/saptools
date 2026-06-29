import { acquireAppToken } from "./auth/token.js";
import type { AcquireTokenOptions } from "./auth/token.js";
import { createGraphClient } from "./graph/client.js";
import type { FetchLike, GraphClient, GraphRetryOptions } from "./graph/client.js";
import { listDrives } from "./graph/drive.js";
import { resolveSite } from "./graph/site.js";
import type { AccessTokenInfo, SharePointDrive, SharePointSite, SharePointTarget } from "./types.js";

export interface SessionOptions {
  readonly fetchFn?: FetchLike;
  readonly authBase?: string;
  readonly graphBase?: string;
  readonly retry?: GraphRetryOptions;
}

export interface SharePointExcelSession {
  readonly token: AccessTokenInfo;
  readonly client: GraphClient;
  readonly site: SharePointSite;
  readonly drives: readonly SharePointDrive[];
}

export async function openSession(
  target: SharePointTarget,
  options: SessionOptions = {},
): Promise<SharePointExcelSession> {
  const tokenOptions: AcquireTokenOptions = {
    ...(options.authBase === undefined ? {} : { authBase: options.authBase }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  };
  const token = await acquireAppToken(target.credentials, tokenOptions);
  const client = createGraphClient({
    accessToken: token.accessToken,
    ...(options.graphBase === undefined ? {} : { baseUrl: options.graphBase }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  const site = await resolveSite(client, target.site);
  const drives = await listDrives(client, site.id);
  return { token, client, site, drives };
}
