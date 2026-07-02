import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);

export const JiraCustomFieldSchemaSchema = z.object({
  custom: z.string().nullable().optional(),
  customId: z.number().int().optional(),
  items: z.string().nullable().optional(),
  type: nonEmptyStringSchema,
});

export const JiraCustomFieldSchema = z.object({
  clauseNames: z.array(z.string()).optional(),
  custom: z.boolean().optional(),
  id: nonEmptyStringSchema,
  key: nonEmptyStringSchema.optional(),
  name: nonEmptyStringSchema,
  navigable: z.boolean().optional(),
  orderable: z.boolean().optional(),
  schema: JiraCustomFieldSchemaSchema.optional(),
  searchable: z.boolean().optional(),
});

export const JiraCustomFieldSearchPageSchema = z.object({
  isLast: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  values: z.array(JiraCustomFieldSchema),
});

export const JiraIssueEditMetadataSchema = z.object({
  fields: z.record(
    z.string(),
    z.object({
      allowedValues: z.array(z.unknown()).optional(),
      key: z.string().optional(),
      name: z.string().optional(),
      required: z.boolean().optional(),
      schema: JiraCustomFieldSchemaSchema.optional(),
    }),
  ),
});

export interface NormalizedCustomFieldSchema {
  readonly custom: string | null;
  readonly customId?: number;
  readonly items: string | null;
  readonly type: string;
}

export interface NormalizedCustomField {
  readonly clauseNames: readonly string[];
  readonly custom: boolean;
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly navigable: boolean;
  readonly orderable: boolean;
  readonly schema: NormalizedCustomFieldSchema;
  readonly searchable: boolean;
}

export interface CustomFieldSnapshot {
  readonly cloudId: string;
  readonly cloudName: string;
  readonly discoveredAt: string;
  readonly fetched: number;
  readonly fields: readonly NormalizedCustomField[];
  readonly totalFromApi: number;
  readonly version: 1;
}

export interface PinnedCustomField {
  readonly id: string;
  readonly name: string;
  readonly schema: NormalizedCustomFieldSchema;
}

export interface PinnedCustomFieldConfig {
  readonly cloudId: string;
  readonly cloudName: string;
  readonly fields: readonly PinnedCustomField[];
  readonly updatedAt: string;
  readonly version: 1;
}

export interface JiraIssueEditableField {
  readonly allowedValues: readonly unknown[];
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly schema: NormalizedCustomFieldSchema | null;
}

export type JiraCustomFieldSearchPage = z.infer<typeof JiraCustomFieldSearchPageSchema>;
export type JiraIssueEditMetadata = z.infer<typeof JiraIssueEditMetadataSchema>;

export function normalizeCustomField(field: z.infer<typeof JiraCustomFieldSchema>): NormalizedCustomField {
  return {
    clauseNames: field.clauseNames ?? [],
    custom: field.custom ?? true,
    id: field.id,
    key: field.key ?? field.id,
    name: field.name,
    navigable: field.navigable ?? false,
    orderable: field.orderable ?? false,
    schema: normalizeFieldSchema(field.schema),
    searchable: field.searchable ?? false,
  };
}

export function normalizeFieldSchema(
  schema: z.infer<typeof JiraCustomFieldSchemaSchema> | undefined,
): NormalizedCustomFieldSchema {
  return {
    custom: schema?.custom ?? null,
    ...(schema?.customId === undefined ? {} : { customId: schema.customId }),
    items: schema?.items ?? null,
    type: schema?.type ?? "any",
  };
}

export function createCustomFieldSnapshot(input: {
  readonly cloudId: string;
  readonly cloudName: string;
  readonly fields: readonly NormalizedCustomField[];
  readonly totalFromApi: number;
  readonly now?: Date;
}): CustomFieldSnapshot {
  return {
    version: 1,
    cloudId: input.cloudId,
    cloudName: input.cloudName,
    discoveredAt: (input.now ?? new Date()).toISOString(),
    totalFromApi: input.totalFromApi,
    fetched: input.fields.length,
    fields: [...input.fields].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

export function searchCustomFields(
  fields: readonly NormalizedCustomField[],
  query: string,
): NormalizedCustomField[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...fields];
  }
  return fields.filter((field) => searchableText(field).includes(needle));
}

export function customFieldTypeSuffix(field: Pick<NormalizedCustomField, "schema">): string {
  const custom = field.schema.custom;
  if (custom === null || custom.trim().length === 0) {
    return field.schema.items ?? "";
  }
  return custom.split(":").at(-1) ?? custom;
}

export function resolveFieldByDisplayName<T extends { readonly name: string }>(
  fields: readonly T[],
  name: string,
): readonly T[] {
  const needle = normalizeName(name);
  return fields.filter((field) => normalizeName(field.name) === needle);
}

function searchableText(field: NormalizedCustomField): string {
  return [
    field.id,
    field.key,
    field.name,
    ...field.clauseNames,
    field.schema.type,
    field.schema.items ?? "",
    customFieldTypeSuffix(field),
  ].join("\n").toLowerCase();
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
