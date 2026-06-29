import process from "node:process";

import type { Command } from "commander";

import { parseSecretStoreKind, resolveRuntime } from "../config/resolve.js";
import type { ResolvedRuntime } from "../config/resolve.js";
import { createProfileStore, findProfile, redactProfile, removeProfile, upsertProfile } from "../credentials/profile-store.js";
import type { SecretVault } from "../credentials/secret-vault.js";
import { createFileSecretVault, createKeyringSecretVault } from "../credentials/secret-vault.js";
import { formatCreateResult, formatDriveList, formatMutationResult, formatProfile, formatTestResult, formatWorkbookRead } from "../output/format.js";
import { openSession } from "../session.js";
import type { SharePointExcelSession } from "../session.js";
import { DEFAULT_PROFILE_NAME, ENV_ALLOW_PLAINTEXT } from "../types.js";
import type { WorkbookReadOptions } from "../types.js";
import { parseCellValue, parseHeaders, parseWorkbookRows } from "../workbook/json.js";
import { addRemoteWorkbookSheet, appendRemoteWorkbookRows, createRemoteWorkbook, readRemoteWorkbook, updateRemoteWorkbookCell } from "../workbook/service.js";
import type { WorkbookServiceTarget } from "../workbook/service.js";

import {
  addCommonOptions,
  requireFlag,
  toRuntimeOverrides,
} from "./options.js";
import type {
  AddSheetFlags,
  AppendFlags,
  CommonFlags,
  ConfigGetFlags,
  ConfigSetFlags,
  CreateFlags,
  ReadFlags,
  UpdateCellFlags,
} from "./options.js";

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeOutput(json: boolean | undefined, jsonValue: unknown, textValue: string): void {
  if (json === true) {
    writeJson(jsonValue);
    return;
  }
  process.stdout.write(`${textValue}\n`);
}

function getSecretVault(storeKind: "keyring" | "file"): SecretVault {
  return storeKind === "keyring" ? createKeyringSecretVault() : createFileSecretVault();
}

interface OpenRuntimeResult {
  readonly runtime: ResolvedRuntime;
  readonly session: SharePointExcelSession;
}

async function openRuntime(flags: CommonFlags): Promise<OpenRuntimeResult> {
  const runtime = await resolveRuntime({ overrides: toRuntimeOverrides(flags) });
  const session = await openSession(runtime.target);
  return { runtime, session };
}

function toServiceTarget(
  session: SharePointExcelSession,
  runtime: ResolvedRuntime,
  flags: CommonFlags,
): WorkbookServiceTarget {
  const driveHint = flags.drive ?? runtime.drive;
  return driveHint === undefined ? { session } : { session, driveHint };
}

function toReadOptions(flags: ReadFlags): WorkbookReadOptions {
  return {
    ...(flags.sheet === undefined ? {} : { sheetName: flags.sheet }),
    ...(flags.range === undefined ? {} : { range: flags.range }),
  };
}

function assertPlaintextAllowed(flags: ConfigSetFlags): void {
  if (flags.store !== "file") {
    return;
  }
  if (flags.allowPlaintextSecret === true || process.env[ENV_ALLOW_PLAINTEXT] === "1") {
    return;
  }
  throw new Error(
    `Plaintext secret file store requires --allow-plaintext-secret or ${ENV_ALLOW_PLAINTEXT}=1`,
  );
}

async function handleConfigSet(flags: ConfigSetFlags): Promise<void> {
  assertPlaintextAllowed(flags);
  const secretStore = parseSecretStoreKind(flags.store);
  const input = {
    name: flags.profile ?? DEFAULT_PROFILE_NAME,
    tenantId: requireFlag(flags.tenant, "--tenant"),
    clientId: requireFlag(flags.clientId, "--client-id"),
    clientSecret: requireFlag(flags.clientSecret, "--client-secret"),
    site: requireFlag(flags.site, "--site"),
    secretStore,
    ...(flags.drive === undefined ? {} : { drive: flags.drive }),
  };
  const profile = await upsertProfile(createProfileStore(), getSecretVault(secretStore), input);
  const redacted = await redactProfile(profile, getSecretVault(secretStore));
  writeOutput(flags.json, redacted, formatProfile(redacted));
}

async function handleConfigGet(flags: ConfigGetFlags): Promise<void> {
  const name = flags.profile ?? DEFAULT_PROFILE_NAME;
  const profile = findProfile(await createProfileStore().readProfiles(), name);
  if (profile === undefined) {
    throw new Error(`Profile "${name}" not found`);
  }
  const redacted = await redactProfile(profile, getSecretVault(profile.secretStore));
  writeOutput(flags.json, redacted, formatProfile(redacted));
}

async function handleConfigRemove(flags: ConfigGetFlags): Promise<void> {
  const name = flags.profile ?? DEFAULT_PROFILE_NAME;
  const profile = findProfile(await createProfileStore().readProfiles(), name);
  const secretStore = profile?.secretStore ?? "keyring";
  const removed = await removeProfile(createProfileStore(), getSecretVault(secretStore), name);
  const output = { profile: name, removed };
  writeOutput(flags.json, output, `Removed profile ${name}: ${String(removed)}`);
}

async function handleTest(flags: CommonFlags): Promise<void> {
  const { session } = await openRuntime(flags);
  const output = { site: session.site, drives: session.drives, tokenType: session.token.tokenType };
  writeOutput(flags.json, output, formatTestResult(session.site, session.drives));
}

async function handleDrives(flags: CommonFlags): Promise<void> {
  const { session } = await openRuntime(flags);
  writeOutput(flags.json, session.drives, formatDriveList(session.drives));
}

async function handleCreate(flags: CreateFlags): Promise<void> {
  const { runtime, session } = await openRuntime(flags);
  const result = await createRemoteWorkbook(
    toServiceTarget(session, runtime, flags),
    requireFlag(flags.path, "--path"),
    {
      sheetName: requireFlag(flags.sheet, "--sheet"),
      headers: parseHeaders(flags.headers),
      rows: parseWorkbookRows(flags.rows),
      ...(flags.table === undefined ? {} : { tableName: flags.table }),
    },
  );
  writeOutput(flags.json, result, formatCreateResult(result));
}

async function handleRead(flags: ReadFlags): Promise<void> {
  const { runtime, session } = await openRuntime(flags);
  const result = await readRemoteWorkbook(
    toServiceTarget(session, runtime, flags),
    requireFlag(flags.path, "--path"),
    toReadOptions(flags),
  );
  writeOutput(flags.json, result, formatWorkbookRead(result));
}

async function handleAppend(flags: AppendFlags): Promise<void> {
  const { runtime, session } = await openRuntime(flags);
  const result = await appendRemoteWorkbookRows(
    toServiceTarget(session, runtime, flags),
    requireFlag(flags.path, "--path"),
    requireFlag(flags.sheet, "--sheet"),
    parseWorkbookRows(requireFlag(flags.record, "--record")),
    flags.matchHeader !== false,
  );
  writeOutput(flags.json, result, formatMutationResult("Updated", result));
}

async function handleUpdateCell(flags: UpdateCellFlags): Promise<void> {
  const { runtime, session } = await openRuntime(flags);
  const result = await updateRemoteWorkbookCell(
    toServiceTarget(session, runtime, flags),
    requireFlag(flags.path, "--path"),
    requireFlag(flags.sheet, "--sheet"),
    requireFlag(flags.cell, "--cell"),
    parseCellValue(requireFlag(flags.value, "--value")),
  );
  writeOutput(flags.json, result, formatMutationResult("Updated", result));
}

async function handleAddSheet(flags: AddSheetFlags): Promise<void> {
  const { runtime, session } = await openRuntime(flags);
  const result = await addRemoteWorkbookSheet(
    toServiceTarget(session, runtime, flags),
    requireFlag(flags.path, "--path"),
    requireFlag(flags.sheet, "--sheet"),
    parseHeaders(flags.headers),
  );
  writeOutput(flags.json, result, formatMutationResult("Updated", result));
}

function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage local SharePoint Excel profiles");
  config.command("set")
    .description("Store a SharePoint app-only profile")
    .option("--profile <name>", "Profile name", DEFAULT_PROFILE_NAME)
    .requiredOption("--tenant <id>", "Azure AD tenant ID")
    .requiredOption("--client-id <id>", "App registration client ID")
    .requiredOption("--client-secret <secret>", "App registration client secret")
    .requiredOption("--site <ref>", "SharePoint site")
    .option("--drive <nameOrId>", "Default document library")
    .option("--store <keyring|file>", "Secret store", "keyring")
    .option("--allow-plaintext-secret", "Allow plaintext file secret storage", false)
    .option("--json", "Emit JSON output", false)
    .action(handleConfigSet);
  config.command("get")
    .description("Read a stored profile without printing secrets")
    .option("--profile <name>", "Profile name", DEFAULT_PROFILE_NAME)
    .option("--json", "Emit JSON output", false)
    .action(handleConfigGet);
  config.command("remove")
    .description("Remove a stored profile")
    .option("--profile <name>", "Profile name", DEFAULT_PROFILE_NAME)
    .option("--json", "Emit JSON output", false)
    .action(handleConfigRemove);
}

export function registerCommands(program: Command): void {
  registerConfigCommands(program);
  addCommonOptions(program.command("test").description("Authenticate, resolve site, and list drives"))
    .action(handleTest);
  addCommonOptions(program.command("drives").description("List SharePoint document libraries"))
    .action(handleDrives);
  addCommonOptions(program.command("create").description("Create a new .xlsx file without overwriting"))
    .requiredOption("--path <xlsxPath>", "SharePoint path for the new workbook")
    .requiredOption("--sheet <name>", "Initial sheet name")
    .option("--headers <csv>", "Comma-separated header row")
    .option("--rows <json>", "JSON row/object or array of rows/objects")
    .option("--table <name>", "Optional Excel table name")
    .action(handleCreate);
  addCommonOptions(program.command("read").description("Read workbook sheets or a range"))
    .requiredOption("--path <xlsxPath>", "SharePoint workbook path")
    .option("--sheet <name>", "Sheet to read")
    .option("--range <a1Range>", "A1 range, e.g. A1:C10")
    .action(handleRead);
  addCommonOptions(program.command("append").description("Append one or more records to a sheet"))
    .requiredOption("--path <xlsxPath>", "SharePoint workbook path")
    .requiredOption("--sheet <name>", "Sheet to append")
    .requiredOption("--record <json>", "JSON row/object or array of rows/objects")
    .option("--no-match-header", "Append object values by key order instead of row 1 headers")
    .action(handleAppend);
  addCommonOptions(program.command("update-cell").description("Update one cell in a workbook"))
    .requiredOption("--path <xlsxPath>", "SharePoint workbook path")
    .requiredOption("--sheet <name>", "Sheet name")
    .requiredOption("--cell <a1Cell>", "A1 cell reference, e.g. B2")
    .requiredOption("--value <jsonOrString>", "JSON scalar or raw string")
    .action(handleUpdateCell);
  addCommonOptions(program.command("add-sheet").description("Add a new sheet to an existing workbook"))
    .requiredOption("--path <xlsxPath>", "SharePoint workbook path")
    .requiredOption("--sheet <name>", "New sheet name")
    .option("--headers <csv>", "Optional comma-separated header row")
    .action(handleAddSheet);
}
