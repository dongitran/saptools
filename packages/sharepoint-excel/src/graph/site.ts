import type { SharePointSite, SharePointSiteRef } from "../types.js";

import type { GraphClient } from "./client.js";
import { GraphHttpError } from "./client.js";

interface RawSiteResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly webUrl?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stripQueryAndHash(value: string): string {
  const markerIndex = value.search(/[?#]/);
  return markerIndex === -1 ? value : value.slice(0, markerIndex);
}

function decodeSitePath(sitePath: string, input: string): string {
  return sitePath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (err) {
        throw new Error(`Invalid site reference "${input}". Site path has invalid encoding`, {
          cause: err,
        });
      }
    })
    .join("/");
}

function parseSiteInput(trimmed: string): { readonly hostname: string; readonly rawPath: string } {
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return { hostname: url.hostname, rawPath: url.pathname };
  }
  const withoutQuery = stripQueryAndHash(trimmed);
  const firstSlash = withoutQuery.indexOf("/");
  if (firstSlash === -1) {
    throw new Error(`Invalid site reference "${trimmed}". Expected host/sites/<name> or full URL`);
  }
  return { hostname: withoutQuery.slice(0, firstSlash), rawPath: withoutQuery.slice(firstSlash + 1) };
}

export function parseSiteRef(input: string): SharePointSiteRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Site reference is empty");
  }
  const { hostname, rawPath } = parseSiteInput(trimmed);
  const sitePath = decodeSitePath(rawPath.replace(/^\/+|(?<!\/)\/+$/g, ""), trimmed);
  if (hostname.length === 0 || sitePath.length === 0) {
    throw new Error(`Invalid site reference "${trimmed}". Missing hostname or site path`);
  }
  return { hostname, sitePath };
}

function encodeSitePath(sitePath: string): string {
  return sitePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export async function resolveSite(
  client: GraphClient,
  ref: SharePointSiteRef,
): Promise<SharePointSite> {
  const path = `/sites/${encodeURIComponent(ref.hostname)}:/${encodeSitePath(ref.sitePath)}`;
  let raw: RawSiteResponse;
  try {
    raw = await client.requestJson<RawSiteResponse>(path);
  } catch (err) {
    if (err instanceof GraphHttpError && err.status === 404) {
      throw new Error(`SharePoint site not found at ${ref.hostname}/${ref.sitePath}`, {
        cause: err,
      });
    }
    throw err;
  }
  const id = asString(raw.id);
  if (id.length === 0) {
    throw new Error(`Site response missing id for ${ref.hostname}/${ref.sitePath}`);
  }
  return {
    id,
    name: asString(raw.name, ref.sitePath),
    displayName: asString(raw.displayName, asString(raw.name, ref.sitePath)),
    webUrl: asString(raw.webUrl),
  };
}
