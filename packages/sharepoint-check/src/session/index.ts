import { decodeAccessToken } from "../auth/jwt.js";
import { acquireAppToken } from "../auth/token.js";
import type { AcquireTokenOptions } from "../auth/token.js";
import type { FetchLike, GraphClient } from "../graph/client.js";
import { createGraphClient } from "../graph/client.js";
import { resolveSite } from "../graph/sites.js";
import type {
  AccessTokenInfo,
  DecodedTokenClaims,
  SharePointSite,
  SharePointTarget,
} from "../types.js";

export interface SessionOptions {
  readonly fetchFn?: FetchLike;
  readonly authBase?: string;
  readonly graphBase?: string;
}

export interface SharePointSession {
  readonly client: GraphClient;
  readonly token: AccessTokenInfo;
  readonly claims: DecodedTokenClaims;
  readonly site: SharePointSite;
}

export async function openSession(
  target: SharePointTarget,
  options: SessionOptions = {},
): Promise<SharePointSession> {
  const tokenOptions: AcquireTokenOptions = {
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.authBase === undefined ? {} : { authBase: options.authBase }),
  };
  const token = await acquireAppToken(target.credentials, tokenOptions);
  const claims = decodeAccessToken(token.accessToken);
  const client = createGraphClient({
    accessToken: token.accessToken,
    ...(options.graphBase === undefined ? {} : { baseUrl: options.graphBase }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  const site = await resolveSite(client, target.site);

  return { client, token, claims, site };
}
