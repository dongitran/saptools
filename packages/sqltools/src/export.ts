import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { cfAppVcapServices, cfLoginAndTarget } from "./cf.js";
import { extractHanaCredentials, parseVcapServices } from "./parser.js";
import { updateVscodeConnections } from "./sqltools.js";
import type { AppHanaEntry, ExportContext } from "./types.js";
import { writeCredentials } from "./writer.js";

export interface BuildEntryFromVcapInput {
  readonly vcapServices: string;
  readonly context: ExportContext;
}

export function buildEntryFromVcap(input: BuildEntryFromVcapInput): AppHanaEntry | null {
  const parsed = parseVcapServices(input.vcapServices);
  const bindings = parsed.hana;
  if (bindings === undefined || bindings.length === 0) {
    return null;
  }
  const firstBinding = bindings[0];
  if (firstBinding === undefined) {
    return null;
  }
  return {
    app: input.context.app,
    org: input.context.org,
    space: input.context.space,
    region: input.context.region,
    hana: extractHanaCredentials(firstBinding),
  };
}

export interface ExportOptions {
  readonly workspaceRoot?: string;
  readonly merge?: boolean;
  readonly credentialsOutputPath?: string | undefined;
  readonly writeCredentialsFile?: boolean;
}

export interface ExportResult {
  readonly entries: readonly AppHanaEntry[];
  readonly settingsPath: string;
  readonly credentialsPath: string | undefined;
  readonly connectionCount: number;
}

async function runExport(
  entries: readonly AppHanaEntry[],
  options: ExportOptions,
): Promise<ExportResult> {
  if (entries.length === 0) {
    throw new Error("No HANA credentials extracted — nothing to export");
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const { settingsPath, connectionCount } = await updateVscodeConnections(entries, {
    workspaceRoot,
    ...(options.merge === undefined ? {} : { merge: options.merge }),
  });

  let credentialsPath: string | undefined;
  if (options.writeCredentialsFile !== false) {
    credentialsPath = await writeCredentials(entries, {
      cwd: workspaceRoot,
      ...(options.credentialsOutputPath === undefined
        ? {}
        : { outputPath: options.credentialsOutputPath }),
    });
  }

  return { entries, settingsPath, credentialsPath, connectionCount };
}

export interface ExportFromVcapInput {
  readonly vcapServices: string;
  readonly context: ExportContext;
}

export async function exportFromVcap(
  input: ExportFromVcapInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const entry = buildEntryFromVcap({
    vcapServices: input.vcapServices,
    context: input.context,
  });
  if (entry === null) {
    throw new Error(`No HANA binding found in VCAP_SERVICES for app "${input.context.app}"`);
  }
  return await runExport([entry], options);
}

export interface ExportFromFileInput {
  readonly filePath: string;
  readonly context: ExportContext;
}

export async function exportFromFile(
  input: ExportFromFileInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const absolute = resolve(input.filePath);
  const raw = await readFile(absolute, "utf-8");
  return await exportFromVcap({ vcapServices: raw, context: input.context }, options);
}

export interface ExportFromCfInput {
  readonly context: ExportContext;
}

export async function exportFromCf(
  input: ExportFromCfInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const vcapServices = await cfAppVcapServices(input.context.app);
  return await exportFromVcap({ vcapServices, context: input.context }, options);
}

export interface ExportFromAppInput {
  readonly context: ExportContext;
  readonly email: string;
  readonly password: string;
}

export async function exportFromApp(
  input: ExportFromAppInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  await cfLoginAndTarget({
    region: input.context.region,
    org: input.context.org,
    space: input.context.space,
    email: input.email,
    password: input.password,
  });
  return await exportFromCf({ context: input.context }, options);
}
