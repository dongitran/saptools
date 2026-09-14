import { z } from "zod";

import type { JiraAdfDocument } from "./adf.js";
import { convertFieldValue } from "./custom-field-values.js";
import type { FieldValueInput } from "./custom-field-values.js";
import { JiraCustomFieldSchemaSchema, normalizeFieldSchema, resolveFieldByDisplayName } from "./custom-fields.js";
import type { JiraIssueEditableField, NormalizedCustomFieldSchema } from "./custom-fields.js";
import { assertJiraResponseOk, jsonJiraHeaders, readJiraHeaders } from "./jira-http.js";
import type {
  JiraCreateIssueOptions,
  JiraCreateIssueResult,
  JiraCreateIssueType,
  JiraRequestOptions,
} from "./types.js";
import {
  buildJiraCreateMetaFieldsUrl,
  buildJiraCreateMetaIssueTypesUrl,
  buildJiraIssueCreateUrl,
} from "./urls.js";

const nonEmptyStringSchema = z.string().min(1);
const CREATE_META_PAGE_SIZE = 50;

/**
 * Fields Jira always fills in from the request itself (project, issuetype, summary) or from the
 * caller's own identity (reporter). A project-specific required field never needs one of these
 * named back to the user as "missing".
 */
const ALWAYS_SATISFIED_CREATE_FIELD_IDS: ReadonlySet<string> = new Set([
  "summary",
  "issuetype",
  "project",
  "reporter",
]);

const EMPTY_FIELD_SCHEMA: NormalizedCustomFieldSchema = { custom: null, items: null, type: "any" };

const CreateIssueTypeSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  subtask: z.boolean().optional(),
});

const CreateIssueTypesPageSchema = z.object({
  isLast: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  issueTypes: z.array(CreateIssueTypeSchema),
});

const CreateFieldMetaValueSchema = z.object({
  allowedValues: z.array(z.unknown()).optional(),
  fieldId: nonEmptyStringSchema,
  name: z.string().optional(),
  required: z.boolean().optional(),
  schema: JiraCustomFieldSchemaSchema.optional(),
});

const CreateFieldMetaPageSchema = z.object({
  isLast: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  fields: z.array(CreateFieldMetaValueSchema),
});

const CreateIssueResponseSchema = z.object({
  id: z.union([nonEmptyStringSchema, z.number()]),
  key: nonEmptyStringSchema,
}).loose();

export interface BuildCreateIssueFieldsInput {
  readonly description?: JiraAdfDocument;
  readonly fieldMetadata: ReadonlyMap<string, JiraIssueEditableField>;
  readonly fieldValues: readonly FieldValueInput[];
  readonly issueType: JiraCreateIssueType;
  readonly labels: readonly string[];
  readonly parentKey?: string;
  readonly priorityName?: string;
  readonly projectKey: string;
  readonly summary: string;
}

export async function createJiraIssue(options: JiraCreateIssueOptions): Promise<JiraCreateIssueResult> {
  const summary = requireNonEmptyText(options.summary, "Summary");
  const issueTypes = await fetchJiraCreateIssueTypes(options, options.projectKey);
  const issueType = resolveJiraCreateIssueType(issueTypes, options.issueTypeName, options.projectKey);
  const fieldMetadata = await fetchJiraCreateIssueFieldMetadata(options, options.projectKey, issueType.id);
  const fields = buildJiraCreateIssueFields({
    fieldMetadata,
    issueType,
    summary,
    fieldValues: options.fieldValues ?? [],
    labels: options.labels ?? [],
    projectKey: options.projectKey,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.parentKey === undefined ? {} : { parentKey: options.parentKey }),
    ...(options.priorityName === undefined ? {} : { priorityName: options.priorityName }),
  });
  const created = await postJiraCreateIssue(options, fields);
  return { id: created.id, issueType: issueType.name, key: created.key };
}

export async function fetchJiraCreateIssueTypes(
  options: JiraRequestOptions,
  projectKey: string,
): Promise<JiraCreateIssueType[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issueTypes: JiraCreateIssueType[] = [];
  let startAt = 0;
  let done = false;
  while (!done) {
    const response = await fetchImpl(
      buildJiraCreateMetaIssueTypesUrl(options.baseUrl, projectKey, startAt, CREATE_META_PAGE_SIZE),
      { headers: readJiraHeaders(options.authorization) },
    );
    assertJiraResponseOk(response, `Jira issue types for project "${projectKey}" could not be loaded.`);
    const page = parseCreateIssueTypesPage(await response.json());
    issueTypes.push(...page.issueTypes.map(toCreateIssueType));
    const pageStartAt = page.startAt ?? startAt;
    const nextStartAt = pageStartAt + page.issueTypes.length;
    done = page.isLast === true || page.issueTypes.length === 0 || nextStartAt <= startAt
      || (page.total !== undefined && nextStartAt >= page.total);
    startAt = nextStartAt;
  }
  return issueTypes;
}

export function resolveJiraCreateIssueType(
  issueTypes: readonly JiraCreateIssueType[],
  name: string,
  projectKey: string,
): JiraCreateIssueType {
  const needle = name.trim().toLowerCase();
  const match = issueTypes.find((issueType) => issueType.name.toLowerCase() === needle);
  if (match !== undefined) {
    return match;
  }
  const available = [...issueTypes].map((issueType) => issueType.name).sort((a, b) => a.localeCompare(b)).join(", ");
  throw new Error(
    `Jira issue type "${name}" was not found in project ${projectKey}.${available.length === 0 ? "" : ` Available: ${available}.`}`,
  );
}

export async function fetchJiraCreateIssueFieldMetadata(
  options: JiraRequestOptions,
  projectKey: string,
  issueTypeId: string,
): Promise<ReadonlyMap<string, JiraIssueEditableField>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fields = new Map<string, JiraIssueEditableField>();
  let startAt = 0;
  let done = false;
  while (!done) {
    const response = await fetchImpl(
      buildJiraCreateMetaFieldsUrl(options.baseUrl, projectKey, issueTypeId, startAt, CREATE_META_PAGE_SIZE),
      { headers: readJiraHeaders(options.authorization) },
    );
    assertJiraResponseOk(response, "Jira create-issue field metadata could not be loaded.");
    const page = parseCreateFieldMetaPage(await response.json());
    for (const value of page.fields) {
      fields.set(value.fieldId, toEditableField(value));
    }
    const pageStartAt = page.startAt ?? startAt;
    const nextStartAt = pageStartAt + page.fields.length;
    done = page.isLast === true || page.fields.length === 0 || nextStartAt <= startAt
      || (page.total !== undefined && nextStartAt >= page.total);
    startAt = nextStartAt;
  }
  return fields;
}

export function normalizeJiraCreateLabels(rawLabels: readonly string[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawLabels) {
    const label = raw.trim();
    if (label.length === 0) {
      throw new Error("Jira labels must not be blank.");
    }
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Assembles the `fields` payload for `POST /issue`. Pure and synchronous so every validation path
 * — subtask/parent consistency, unsupported labels, unresolved custom fields, and any remaining
 * project-required field — is unit-testable without an HTTP layer.
 */
export function buildJiraCreateIssueFields(input: BuildCreateIssueFieldsInput): Record<string, unknown> {
  assertCreateParentConsistency(input.issueType, input.parentKey, input.projectKey);
  if (input.description !== undefined) {
    assertCreateFieldSupported(input.fieldMetadata, "description", "Description", input.projectKey);
  }
  if (input.labels.length > 0) {
    assertCreateFieldSupported(input.fieldMetadata, "labels", "Labels", input.projectKey);
  }
  const custom = buildCreateIssueCustomFieldValues(input.fieldMetadata, input.fieldValues);
  const resolvedFieldIds = resolveCreateFieldIds(input, custom.fieldIds);
  assertCreateFieldsSatisfied(input.fieldMetadata, resolvedFieldIds, input.projectKey);
  return {
    project: { key: input.projectKey },
    issuetype: { id: input.issueType.id },
    summary: input.summary,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.priorityName === undefined
      ? {}
      : { priority: resolveCreatePriorityValue(input.priorityName, input.fieldMetadata, input.projectKey) }),
    ...(input.labels.length === 0 ? {} : { labels: [...input.labels] }),
    ...(input.parentKey === undefined ? {} : { parent: { key: input.parentKey } }),
    ...custom.fields,
  };
}

function assertCreateParentConsistency(
  issueType: JiraCreateIssueType,
  parentKey: string | undefined,
  projectKey: string,
): void {
  if (issueType.subtask && parentKey === undefined) {
    throw new Error(
      `Jira issue type "${issueType.name}" in project ${projectKey} is a subtask type and requires --parent <key>.`,
    );
  }
  if (!issueType.subtask && parentKey !== undefined) {
    throw new Error(
      `--parent is only valid for a subtask issue type; "${issueType.name}" in project ${projectKey} is not a subtask type.`,
    );
  }
}

function assertCreateFieldSupported(
  fieldMetadata: ReadonlyMap<string, JiraIssueEditableField>,
  fieldId: string,
  label: string,
  projectKey: string,
): void {
  if (!fieldMetadata.has(fieldId)) {
    throw new Error(`${label} is not available when creating this issue in project ${projectKey}.`);
  }
}

/**
 * Every field id the create request actually sends: the ids Jira always fills in, whichever of
 * description/priority/labels/parent the caller supplied, and every resolved `--field`/
 * `--field-file` entry. This is the single source of truth for "is this required field covered",
 * so a field can never be both included in the request and reported as missing.
 */
function resolveCreateFieldIds(
  input: BuildCreateIssueFieldsInput,
  customFieldIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set([...ALWAYS_SATISFIED_CREATE_FIELD_IDS, ...customFieldIds]);
  if (input.description !== undefined) {
    ids.add("description");
  }
  if (input.priorityName !== undefined) {
    ids.add("priority");
  }
  if (input.labels.length > 0) {
    ids.add("labels");
  }
  if (input.parentKey !== undefined) {
    ids.add("parent");
  }
  return ids;
}

function resolveCreatePriorityValue(
  priorityName: string,
  fieldMetadata: ReadonlyMap<string, JiraIssueEditableField>,
  projectKey: string,
): Record<string, string> {
  const priorityField = fieldMetadata.get("priority");
  if (priorityField === undefined) {
    throw new Error(`Priority is not available when creating this issue in project ${projectKey}.`);
  }
  return resolvePriorityAllowedValue(priorityName, priorityField.allowedValues);
}

/**
 * Jira's system `priority` field accepts only `{id}` or `{name}`, never `{value}` — the shape
 * `resolveAllowedFieldOptionValue` falls back to for an ordinary custom option field when nothing
 * is left to match against. A dedicated matcher keeps that contract correct even when a project's
 * create metadata reports no allowed values.
 */
function resolvePriorityAllowedValue(name: string, allowedValues: readonly unknown[]): Record<string, string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Field "Priority" expects a non-empty option value.');
  }
  const matches = allowedValues.filter((candidate): candidate is { readonly id: string } => {
    return isRecord(candidate) && typeof candidate["id"] === "string" && namesMatch(candidate["name"], trimmed);
  });
  if (matches.length === 1) {
    const match = matches[0];
    if (match !== undefined) {
      return { id: match.id };
    }
  }
  if (allowedValues.length > 0) {
    throw new Error('Field "Priority" option value is not allowed or is ambiguous.');
  }
  return { name: trimmed };
}

function namesMatch(value: unknown, name: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === name.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildCreateIssueCustomFieldValues(
  fieldMetadata: ReadonlyMap<string, JiraIssueEditableField>,
  values: readonly FieldValueInput[],
): { readonly fields: Record<string, unknown>; readonly fieldIds: ReadonlySet<string> } {
  const catalog = [...fieldMetadata.values()].map((field) => ({
    id: field.id,
    name: field.name,
    schema: field.schema ?? EMPTY_FIELD_SCHEMA,
  }));
  const fields: Record<string, unknown> = {};
  const fieldIds = new Set<string>();
  for (const value of values) {
    const pinned = requireSingleFieldMatch(resolveFieldByDisplayName(catalog, value.fieldName), value.fieldName);
    const editable = fieldMetadata.get(pinned.id);
    if (editable === undefined) {
      throw new Error(`Field "${pinned.name}" is not available when creating this issue.`);
    }
    if (fieldIds.has(pinned.id)) {
      throw new Error(`Field "${pinned.name}" was provided more than once.`);
    }
    fields[pinned.id] = convertFieldValue(value.value, pinned, editable);
    fieldIds.add(pinned.id);
  }
  return { fields, fieldIds };
}

function requireSingleFieldMatch<T extends { readonly name: string }>(matches: readonly T[], fieldName: string): T {
  if (matches.length === 0) {
    throw new Error(`Field "${fieldName}" was not found for this project and issue type.`);
  }
  if (matches.length > 1) {
    throw new Error(`Field name "${fieldName}" is ambiguous for this project and issue type.`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`Field "${fieldName}" was not found for this project and issue type.`);
  }
  return match;
}

function assertCreateFieldsSatisfied(
  fieldMetadata: ReadonlyMap<string, JiraIssueEditableField>,
  resolvedFieldIds: ReadonlySet<string>,
  projectKey: string,
): void {
  const missing = [...fieldMetadata.values()].filter((field) => field.required && !resolvedFieldIds.has(field.id));
  if (missing.length === 0) {
    return;
  }
  const names = missing.map((field) => field.name).sort((a, b) => a.localeCompare(b)).join(", ");
  throw new Error(
    `Project ${projectKey} requires additional fields for this issue type: ${names}. Supply them with --field 'FIELD NAME=value'.`,
  );
}

async function postJiraCreateIssue(
  options: JiraRequestOptions & { readonly notifyUsers?: boolean },
  fields: Record<string, unknown>,
): Promise<{ readonly id: string; readonly key: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueCreateUrl(options.baseUrl, createUrlOptions(options)),
    {
      body: JSON.stringify({ fields }),
      headers: jsonJiraHeaders(options.authorization),
      method: "POST",
    },
  );
  assertJiraResponseOk(response, "Jira issue could not be created.");
  const parsed = CreateIssueResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Jira issue creation response was not valid.");
  }
  return { id: String(parsed.data.id), key: parsed.data.key };
}

function createUrlOptions(options: { readonly notifyUsers?: boolean }): { readonly notifyUsers?: boolean } {
  return options.notifyUsers === undefined ? {} : { notifyUsers: options.notifyUsers };
}

function requireNonEmptyText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return trimmed;
}

function parseCreateIssueTypesPage(responseBody: unknown): z.infer<typeof CreateIssueTypesPageSchema> {
  const parsed = CreateIssueTypesPageSchema.safeParse(responseBody);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error("Jira issue types response was not valid.");
}

function toCreateIssueType(value: z.infer<typeof CreateIssueTypeSchema>): JiraCreateIssueType {
  return { id: value.id, name: value.name, subtask: value.subtask ?? false };
}

function parseCreateFieldMetaPage(responseBody: unknown): z.infer<typeof CreateFieldMetaPageSchema> {
  const parsed = CreateFieldMetaPageSchema.safeParse(responseBody);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error("Jira create-issue field metadata response was not valid.");
}

function toEditableField(value: z.infer<typeof CreateFieldMetaValueSchema>): JiraIssueEditableField {
  return {
    id: value.fieldId,
    name: value.name ?? value.fieldId,
    required: value.required ?? false,
    allowedValues: value.allowedValues ?? [],
    schema: value.schema === undefined ? null : normalizeFieldSchema(value.schema),
  };
}
