import type { RedactedProfile, SharePointDrive, SharePointSite, WorkbookReadResult } from "../types.js";
import type {
  RemoteMutationResult,
  RemoteReadResult,
  RemoteWorkbookResult,
} from "../workbook/service.js";

export function formatDriveList(drives: readonly SharePointDrive[]): string {
  if (drives.length === 0) {
    return "(no drives found)";
  }
  return drives.map((drive) => `- ${drive.name} [${drive.driveType}] (${drive.id})`).join("\n");
}

export function formatTestResult(site: SharePointSite, drives: readonly SharePointDrive[]): string {
  return [
    `Authenticated and resolved site: ${site.displayName} (${site.id})`,
    `Document libraries: ${drives.length.toString()}`,
    formatDriveList(drives),
  ].join("\n");
}

export function formatProfile(profile: RedactedProfile): string {
  return [
    `Profile: ${profile.name}`,
    `Tenant: ${profile.tenantId}`,
    `Client: ${profile.clientId}`,
    `Site: ${profile.site}`,
    `Drive: ${profile.drive ?? "(first available)"}`,
    `Secret store: ${profile.secretStore}`,
    `Client secret: ${profile.hasClientSecret ? "stored" : "missing"}`,
  ].join("\n");
}

export function formatCreateResult(result: RemoteWorkbookResult): string {
  return `Created ${result.path} in ${result.driveName} (${result.item.id})`;
}

export function formatMutationResult(action: string, result: RemoteMutationResult): string {
  return `${action} ${result.path} in ${result.driveName}; sheet ${result.mutation.sheetName} now has ${result.mutation.rowCount.toString()} row(s)`;
}

export function formatWorkbookRead(result: RemoteReadResult): string {
  return formatWorkbookSheets(result.workbook);
}

export function formatWorkbookSheets(workbook: WorkbookReadResult): string {
  return workbook.sheets
    .map((sheet) => `${sheet.name}: ${sheet.rowCount.toString()} row(s), ${sheet.columnCount.toString()} column(s)`)
    .join("\n");
}
