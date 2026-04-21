import type { GraphClient } from "./graph.js";
import { GraphHttpError } from "./graph.js";
import type { DriveItemSummary, SharePointDrive } from "./types.js";

interface RawDriveResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly driveType?: unknown;
  readonly webUrl?: unknown;
}

interface RawDriveListResponse {
  readonly value?: unknown;
}

interface RawDriveItem {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly size?: unknown;
  readonly webUrl?: unknown;
  readonly folder?: { readonly childCount?: unknown } | null;
  readonly file?: unknown;
}

interface RawChildrenResponse {
  readonly value?: unknown;
  readonly "@odata.nextLink"?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function encodePath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toDrive(raw: RawDriveResponse): SharePointDrive {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    driveType: asString(raw.driveType, "documentLibrary"),
    webUrl: asString(raw.webUrl),
  };
}

function toDriveItem(raw: RawDriveItem): DriveItemSummary {
  const id = asString(raw.id);
  const name = asString(raw.name);
  const folder = raw.folder ?? undefined;
  const isFolder = folder !== undefined;
  const childCount = folder === undefined ? undefined : asNumber(folder.childCount);
  const webUrl = asString(raw.webUrl);

  const base: DriveItemSummary = {
    id,
    name,
    isFolder,
    size: asNumber(raw.size),
  };

  if (childCount !== undefined && webUrl.length > 0) {
    return { ...base, childCount, webUrl };
  }
  if (childCount !== undefined) {
    return { ...base, childCount };
  }
  if (webUrl.length > 0) {
    return { ...base, webUrl };
  }
  return base;
}

export async function listDrives(
  client: GraphClient,
  siteId: string,
): Promise<readonly SharePointDrive[]> {
  const response = await client.request<RawDriveListResponse>(`/sites/${encodeURIComponent(siteId)}/drives`);

  if (!Array.isArray(response.value)) {
    return [];
  }

  return response.value
    .filter((entry): entry is RawDriveResponse => typeof entry === "object" && entry !== null)
    .map(toDrive);
}

async function collectChildren(client: GraphClient, firstUrl: string): Promise<readonly RawDriveItem[]> {
  const accumulated: RawDriveItem[] = [];
  let nextUrl: string | undefined = firstUrl;

  while (nextUrl !== undefined) {
    const page: RawChildrenResponse = await client.request<RawChildrenResponse>(nextUrl);
    if (Array.isArray(page.value)) {
      for (const entry of page.value) {
        if (typeof entry === "object" && entry !== null) {
          accumulated.push(entry as RawDriveItem);
        }
      }
    }
    nextUrl = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }

  return accumulated;
}

export async function listDriveRoot(
  client: GraphClient,
  driveId: string,
): Promise<readonly DriveItemSummary[]> {
  const raw = await collectChildren(client, `/drives/${encodeURIComponent(driveId)}/root/children`);
  return raw.map(toDriveItem);
}

export async function listDriveChildren(
  client: GraphClient,
  driveId: string,
  relativePath: string,
): Promise<readonly DriveItemSummary[]> {
  const normalized = relativePath.replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) {
    return await listDriveRoot(client, driveId);
  }

  const encoded = encodePath(normalized);
  const url = `/drives/${encodeURIComponent(driveId)}/root:/${encoded}:/children`;
  const raw = await collectChildren(client, url);
  return raw.map(toDriveItem);
}

export async function getDriveItemByPath(
  client: GraphClient,
  driveId: string,
  relativePath: string,
): Promise<DriveItemSummary | null> {
  const normalized = relativePath.replace(/^\/+|\/+$/g, "");
  const url =
    normalized.length === 0
      ? `/drives/${encodeURIComponent(driveId)}/root`
      : `/drives/${encodeURIComponent(driveId)}/root:/${encodePath(normalized)}`;

  try {
    const raw = await client.request<RawDriveItem>(url);
    return toDriveItem(raw);
  } catch (err) {
    if (err instanceof GraphHttpError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function createFolder(
  client: GraphClient,
  driveId: string,
  parentPath: string,
  folderName: string,
): Promise<DriveItemSummary> {
  const normalized = parentPath.replace(/^\/+|\/+$/g, "");
  const url =
    normalized.length === 0
      ? `/drives/${encodeURIComponent(driveId)}/root/children`
      : `/drives/${encodeURIComponent(driveId)}/root:/${encodePath(normalized)}:/children`;

  const raw = await client.request<RawDriveItem>(url, {
    method: "POST",
    body: {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    },
  });

  return toDriveItem(raw);
}

export async function deleteItem(
  client: GraphClient,
  driveId: string,
  itemId: string,
): Promise<void> {
  await client.request<undefined>(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
    expectJson: false,
  });
}
