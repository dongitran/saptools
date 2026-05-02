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
        throw new Error(`Invalid site reference "${input}". Site path contains invalid URL encoding`, {
          cause: err,
        });
      }
    })
    .join("/");
}

function parseSiteInput(trimmed: string): { readonly hostname: string; readonly rawPath: string } {
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { hostname: url.hostname, rawPath: url.pathname };
    } catch (err) {
      throw new Error(`Invalid site reference "${trimmed}". Expected a valid SharePoint URL`, {
        cause: err,
      });
    }
  }

  const withoutQuery = stripQueryAndHash(trimmed);
  const firstSlash = withoutQuery.indexOf("/");
  if (firstSlash === -1) {
    throw new Error(
      `Invalid site reference "${trimmed}". Expected host/sites/<name> or a full URL`,
    );
  }

  return {
    hostname: withoutQuery.slice(0, firstSlash),
    rawPath: withoutQuery.slice(firstSlash + 1),
  };
}

export function parseSiteRef(input: string): SharePointSiteRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Site reference is empty");
  }

  const { hostname, rawPath } = parseSiteInput(trimmed);
  if (hostname.length === 0) {
    throw new Error(`Invalid site reference "${trimmed}". Missing hostname`);
  }

  const sitePath = decodeSitePath(rawPath.replace(/^\/+|\/+$/g, ""), trimmed);
  if (sitePath.length === 0) {
    throw new Error(`Invalid site reference "${trimmed}". Missing site path (e.g. sites/demo)`);
  }

  return { hostname, sitePath };
}

function encodeSitePath(sitePath: string): string {
  return sitePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function resolveSite(
  client: GraphClient,
  ref: SharePointSiteRef,
): Promise<SharePointSite> {
  const path = `/sites/${encodeURIComponent(ref.hostname)}:/${encodeSitePath(ref.sitePath)}`;
  let raw: RawSiteResponse;
  try {
    raw = await client.request<RawSiteResponse>(path);
  } catch (err) {
    if (err instanceof GraphHttpError && err.status === 404) {
      throw new Error(
        `SharePoint site not found at ${ref.hostname}/${ref.sitePath}. ` +
          `Check the SHAREPOINT_SITE value — use the server-relative path (e.g. "sites/demo"), ` +
          `not a deep URL like "sites/demo/SitePages/Home.aspx".`,
        { cause: err },
      );
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
