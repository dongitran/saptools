import type { DriveItemSummary, SharePointDrive } from "../types.js";

import type { GraphClient } from "./client.js";
import { GraphHttpError } from "./client.js";

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
  readonly eTag?: unknown;
  readonly cTag?: unknown;
  readonly webUrl?: unknown;
  readonly folder?: unknown;
  readonly file?: unknown;
}

interface UploadSessionResponse {
  readonly uploadUrl?: unknown;
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function encodeDrivePath(relativePath: string): string {
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
  const base = {
    id: asString(raw.id),
    name: asString(raw.name),
    isFolder: raw.folder !== undefined && raw.folder !== null,
    size: asNumber(raw.size),
  };
  return {
    ...base,
    ...(typeof raw.eTag === "string" ? { eTag: raw.eTag } : {}),
    ...(typeof raw.cTag === "string" ? { cTag: raw.cTag } : {}),
    ...(typeof raw.webUrl === "string" ? { webUrl: raw.webUrl } : {}),
  };
}

export async function listDrives(
  client: GraphClient,
  siteId: string,
): Promise<readonly SharePointDrive[]> {
  const response = await client.requestJson<RawDriveListResponse>(`/sites/${encodeURIComponent(siteId)}/drives`);
  if (!Array.isArray(response.value)) {
    return [];
  }
  return response.value
    .filter((entry): entry is RawDriveResponse => typeof entry === "object" && entry !== null)
    .map(toDrive);
}

export function selectDrive(
  drives: readonly SharePointDrive[],
  driveHint: string | undefined,
): SharePointDrive {
  if (drives.length === 0) {
    throw new Error("SharePoint site has no drives (document libraries)");
  }
  if (driveHint === undefined || driveHint.length === 0) {
    const first = drives[0];
    if (first === undefined) {
      throw new Error("No drives available");
    }
    return first;
  }
  const match = drives.find((drive) => drive.id === driveHint || drive.name === driveHint);
  if (match === undefined) {
    throw new Error(`Drive "${driveHint}" not found. Available: ${drives.map((d) => d.name).join(", ")}`);
  }
  return match;
}

export async function getDriveItemByPath(
  client: GraphClient,
  driveId: string,
  relativePath: string,
): Promise<DriveItemSummary | null> {
  const normalized = relativePath.replace(/^\/+|(?<!\/)\/+$/g, "");
  const path =
    normalized.length === 0
      ? `/drives/${encodeURIComponent(driveId)}/root`
      : `/drives/${encodeURIComponent(driveId)}/root:/${encodeDrivePath(normalized)}`;
  try {
    return toDriveItem(await client.requestJson<RawDriveItem>(path));
  } catch (err) {
    if (err instanceof GraphHttpError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function downloadDriveFile(
  client: GraphClient,
  driveId: string,
  relativePath: string,
): Promise<Uint8Array> {
  const encodedPath = encodeDrivePath(relativePath.replace(/^\/+|(?<!\/)\/+$/g, ""));
  return await client.requestBytes(`/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/content`, {
    headers: { Accept: XLSX_CONTENT_TYPE },
  });
}

async function createUploadSession(
  client: GraphClient,
  driveId: string,
  relativePath: string,
): Promise<string> {
  const encodedPath = encodeDrivePath(relativePath.replace(/^\/+|(?<!\/)\/+$/g, ""));
  const response = await client.requestJson<UploadSessionResponse>(
    `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/createUploadSession`,
    {
      method: "POST",
      body: { item: { "@microsoft.graph.conflictBehavior": "fail" } },
    },
  );
  if (typeof response.uploadUrl !== "string" || response.uploadUrl.length === 0) {
    throw new Error("Graph upload session response missing uploadUrl");
  }
  return response.uploadUrl;
}

export async function uploadNewDriveFile(
  client: GraphClient,
  driveId: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<DriveItemSummary> {
  const existing = await getDriveItemByPath(client, driveId, relativePath);
  if (existing !== null) {
    throw new Error(`Refusing to overwrite existing SharePoint file: ${relativePath}`);
  }
  const uploadUrl = await createUploadSession(client, driveId, relativePath);
  const lastByte = bytes.byteLength - 1;
  const raw = await client.requestJson<RawDriveItem>(uploadUrl, {
    method: "PUT",
    rawBody: bytes,
    includeAuthorization: false,
    headers: {
      "Content-Length": bytes.byteLength.toString(),
      "Content-Range": `bytes 0-${lastByte.toString()}/${bytes.byteLength.toString()}`,
      "Content-Type": XLSX_CONTENT_TYPE,
    },
  });
  return toDriveItem(raw);
}

export async function replaceDriveFile(
  client: GraphClient,
  driveId: string,
  relativePath: string,
  eTag: string,
  bytes: Uint8Array,
): Promise<DriveItemSummary> {
  const encodedPath = encodeDrivePath(relativePath.replace(/^\/+|(?<!\/)\/+$/g, ""));
  const raw = await client.requestJson<RawDriveItem>(
    `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/content`,
    {
      method: "PUT",
      rawBody: bytes,
      headers: {
        "Content-Type": XLSX_CONTENT_TYPE,
        "If-Match": eTag,
      },
    },
  );
  return toDriveItem(raw);
}
