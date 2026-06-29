import {
  downloadDriveFile,
  getDriveItemByPath,
  replaceDriveFile,
  selectDrive,
  uploadNewDriveFile,
} from "../graph/drive.js";
import type { SharePointExcelSession } from "../session.js";
import type {
  DriveItemSummary,
  WorkbookCreateInput,
  WorkbookInputRow,
  WorkbookMutationResult,
  WorkbookReadOptions,
  WorkbookReadResult,
} from "../types.js";

import {
  addWorkbookSheet,
  appendWorkbookRows,
  createWorkbookBytes,
  readWorkbookBytes,
  updateWorkbookCell,
} from "./excel.js";

export interface WorkbookServiceTarget {
  readonly session: SharePointExcelSession;
  readonly driveHint?: string;
}

export interface RemoteWorkbookResult {
  readonly driveId: string;
  readonly driveName: string;
  readonly path: string;
  readonly item: DriveItemSummary;
}

export interface RemoteReadResult extends RemoteWorkbookResult {
  readonly workbook: WorkbookReadResult;
}

export interface RemoteMutationResult extends RemoteWorkbookResult {
  readonly mutation: WorkbookMutationResult;
}

function normalizeWorkbookPath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Workbook path is required");
  }
  if (!normalized.toLowerCase().endsWith(".xlsx")) {
    throw new Error(`Workbook path must end with .xlsx: ${path}`);
  }
  return normalized;
}

function requireEtag(item: DriveItemSummary, path: string): string {
  if (item.eTag === undefined || item.eTag.length === 0) {
    throw new Error(`Cannot update ${path}: SharePoint item is missing an ETag`);
  }
  return item.eTag;
}

async function downloadExistingWorkbook(
  target: WorkbookServiceTarget,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly item: DriveItemSummary; readonly driveId: string; readonly driveName: string }> {
  const drive = selectDrive(target.session.drives, target.driveHint);
  const item = await getDriveItemByPath(target.session.client, drive.id, path);
  if (item === null || item.isFolder) {
    throw new Error(`Workbook not found: ${path}`);
  }
  const bytes = await downloadDriveFile(target.session.client, drive.id, path);
  return { bytes, item, driveId: drive.id, driveName: drive.name };
}

export async function createRemoteWorkbook(
  target: WorkbookServiceTarget,
  path: string,
  input: WorkbookCreateInput,
): Promise<RemoteWorkbookResult> {
  const normalizedPath = normalizeWorkbookPath(path);
  const drive = selectDrive(target.session.drives, target.driveHint);
  const bytes = await createWorkbookBytes(input);
  const item = await uploadNewDriveFile(target.session.client, drive.id, normalizedPath, bytes);
  return { driveId: drive.id, driveName: drive.name, path: normalizedPath, item };
}

export async function readRemoteWorkbook(
  target: WorkbookServiceTarget,
  path: string,
  options: WorkbookReadOptions = {},
): Promise<RemoteReadResult> {
  const normalizedPath = normalizeWorkbookPath(path);
  const downloaded = await downloadExistingWorkbook(target, normalizedPath);
  const workbook = await readWorkbookBytes(downloaded.bytes, options);
  return { ...downloaded, path: normalizedPath, workbook };
}

export async function appendRemoteWorkbookRows(
  target: WorkbookServiceTarget,
  path: string,
  sheetName: string,
  rows: readonly WorkbookInputRow[],
  matchHeader: boolean,
): Promise<RemoteMutationResult> {
  const normalizedPath = normalizeWorkbookPath(path);
  const downloaded = await downloadExistingWorkbook(target, normalizedPath);
  const mutation = await appendWorkbookRows(downloaded.bytes, sheetName, rows, matchHeader);
  const item = await replaceDriveFile(
    target.session.client,
    downloaded.driveId,
    normalizedPath,
    requireEtag(downloaded.item, normalizedPath),
    mutation.bytes,
  );
  return { ...downloaded, item, path: normalizedPath, mutation };
}

export async function updateRemoteWorkbookCell(
  target: WorkbookServiceTarget,
  path: string,
  sheetName: string,
  cellRef: string,
  value: string | number | boolean | null,
): Promise<RemoteMutationResult> {
  const normalizedPath = normalizeWorkbookPath(path);
  const downloaded = await downloadExistingWorkbook(target, normalizedPath);
  const mutation = await updateWorkbookCell(downloaded.bytes, sheetName, cellRef, value);
  const item = await replaceDriveFile(
    target.session.client,
    downloaded.driveId,
    normalizedPath,
    requireEtag(downloaded.item, normalizedPath),
    mutation.bytes,
  );
  return { ...downloaded, item, path: normalizedPath, mutation };
}

export async function addRemoteWorkbookSheet(
  target: WorkbookServiceTarget,
  path: string,
  sheetName: string,
  headers: readonly string[],
): Promise<RemoteMutationResult> {
  const normalizedPath = normalizeWorkbookPath(path);
  const downloaded = await downloadExistingWorkbook(target, normalizedPath);
  const mutation = await addWorkbookSheet(downloaded.bytes, sheetName, headers);
  const item = await replaceDriveFile(
    target.session.client,
    downloaded.driveId,
    normalizedPath,
    requireEtag(downloaded.item, normalizedPath),
    mutation.bytes,
  );
  return { ...downloaded, item, path: normalizedPath, mutation };
}
