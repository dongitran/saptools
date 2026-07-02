import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type {
  CustomFieldSnapshot,
  NormalizedCustomFieldSchema,
  PinnedCustomFieldConfig,
} from "./custom-fields.js";
import { SAPTOOLS_DIR_NAME, JIRA_DIR_NAME } from "./worklog-history.js";

const CLOUDS_DIR_NAME = "clouds";
const FIELDS_FILENAME = "fields.json";
const PINNED_FIELDS_FILENAME = "pinned-fields.json";
const SAFE_SEGMENT_PATTERN = /[^A-Za-z0-9._-]/gu;

const schemaShape = z.object({
  custom: z.string().nullable(),
  customId: z.number().int().optional(),
  items: z.string().nullable(),
  type: z.string(),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  cloudId: z.string(),
  cloudName: z.string(),
  discoveredAt: z.string(),
  totalFromApi: z.number(),
  fetched: z.number(),
  fields: z.array(z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    custom: z.boolean(),
    orderable: z.boolean(),
    navigable: z.boolean(),
    searchable: z.boolean(),
    clauseNames: z.array(z.string()),
    schema: schemaShape,
  })),
});
const pinnedSchema = z.object({
  version: z.literal(1),
  cloudId: z.string(),
  cloudName: z.string(),
  updatedAt: z.string(),
  fields: z.array(z.object({ id: z.string(), name: z.string(), schema: schemaShape })),
});

export interface CustomFieldStoreOptions {
  readonly homeDir?: string;
}

export function jiraCloudDataDirectory(cloudId: string, options: CustomFieldStoreOptions = {}): string {
  return join(
    options.homeDir ?? homedir(),
    SAPTOOLS_DIR_NAME,
    JIRA_DIR_NAME,
    CLOUDS_DIR_NAME,
    safeCloudIdSegment(cloudId),
  );
}

export function customFieldSnapshotPath(cloudId: string, options: CustomFieldStoreOptions = {}): string {
  return join(jiraCloudDataDirectory(cloudId, options), FIELDS_FILENAME);
}

export function pinnedCustomFieldsPath(cloudId: string, options: CustomFieldStoreOptions = {}): string {
  return join(jiraCloudDataDirectory(cloudId, options), PINNED_FIELDS_FILENAME);
}

export function safeCloudIdSegment(cloudId: string): string {
  const safe = cloudId.trim().replaceAll(SAFE_SEGMENT_PATTERN, "_");
  return safe.length === 0 ? "unknown-cloud" : safe;
}

export async function readCustomFieldSnapshot(
  cloudId: string,
  options: CustomFieldStoreOptions = {},
): Promise<CustomFieldSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(customFieldSnapshotPath(cloudId, options), "utf8"));
    const result = snapshotSchema.safeParse(parsed);
    return result.success ? sanitizeSnapshot(result.data) : null;
  } catch {
    return null;
  }
}

export async function writeCustomFieldSnapshot(
  snapshot: CustomFieldSnapshot,
  options: CustomFieldStoreOptions = {},
): Promise<void> {
  await writePrivateJson(customFieldSnapshotPath(snapshot.cloudId, options), snapshot);
}

export async function readPinnedCustomFields(
  cloudId: string,
  options: CustomFieldStoreOptions = {},
): Promise<PinnedCustomFieldConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pinnedCustomFieldsPath(cloudId, options), "utf8"));
    const result = pinnedSchema.safeParse(parsed);
    return result.success ? sanitizePinnedConfig(result.data) : null;
  } catch {
    return null;
  }
}

export async function writePinnedCustomFields(
  config: PinnedCustomFieldConfig,
  options: CustomFieldStoreOptions = {},
): Promise<void> {
  await writePrivateJson(pinnedCustomFieldsPath(config.cloudId, options), config);
}

function sanitizeSnapshot(value: z.infer<typeof snapshotSchema>): CustomFieldSnapshot {
  return {
    ...value,
    fields: value.fields.map((field) => ({ ...field, schema: sanitizeSchema(field.schema) })),
  };
}

function sanitizePinnedConfig(value: z.infer<typeof pinnedSchema>): PinnedCustomFieldConfig {
  return {
    ...value,
    fields: value.fields.map((field) => ({ ...field, schema: sanitizeSchema(field.schema) })),
  };
}

function sanitizeSchema(value: z.infer<typeof schemaShape>): NormalizedCustomFieldSchema {
  return {
    custom: value.custom,
    items: value.items,
    type: value.type,
    ...(value.customId === undefined ? {} : { customId: value.customId }),
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
