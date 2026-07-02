import { readFile } from "node:fs/promises";

import type { JiraIssueEditableField, PinnedCustomField } from "./custom-fields.js";
import { customFieldTypeSuffix, resolveFieldByDisplayName } from "./custom-fields.js";

export interface FieldValueInput {
  readonly fieldName: string;
  readonly value: string;
}

export function parseFieldAssignment(raw: string, label: string): FieldValueInput {
  const index = raw.indexOf("=");
  if (index <= 0) {
    throw new Error(`${label} must use FIELD NAME=value and include a non-empty field name.`);
  }
  const fieldName = raw.slice(0, index).trim();
  if (fieldName.length === 0) {
    throw new Error(`${label} must include a non-empty field name.`);
  }
  return { fieldName, value: raw.slice(index + 1) };
}

export async function parseFieldFileAssignment(raw: string, label: string): Promise<FieldValueInput> {
  const parsed = parseFieldAssignment(raw, label);
  const path = parsed.value.trim();
  if (path.length === 0) {
    throw new Error(`${label} must include a non-empty file path.`);
  }
  return { fieldName: parsed.fieldName, value: await readFile(path, "utf8") };
}

export async function collectFieldValueInputs(
  inlineValues: readonly string[] = [],
  fileValues: readonly string[] = [],
): Promise<FieldValueInput[]> {
  const inline = inlineValues.map((value) => parseFieldAssignment(value, "--field"));
  const files = await Promise.all(
    fileValues.map(async (value) => await parseFieldFileAssignment(value, "--field-file")),
  );
  return [...inline, ...files];
}

export function buildIssueFieldUpdate(input: {
  readonly editableFields: ReadonlyMap<string, JiraIssueEditableField>;
  readonly issueKey: string;
  readonly pinnedFields: readonly PinnedCustomField[];
  readonly values: readonly FieldValueInput[];
}): { readonly fields: Record<string, unknown>; readonly names: readonly string[] } {
  if (input.values.length === 0) {
    throw new Error("At least one --field or --field-file value is required.");
  }
  const fields: Record<string, unknown> = {};
  const names: string[] = [];
  const seenFieldIds = new Set<string>();
  for (const value of input.values) {
    const matches = resolveFieldByDisplayName(input.pinnedFields, value.fieldName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Pinned field "${value.fieldName}" was not found. Run \`jira fields pinned\` to inspect pinned display names.`
        : `Pinned field name "${value.fieldName}" is ambiguous. Unpin duplicate display names before updating.`);
    }
    const pinned = matches[0];
    if (pinned === undefined) {
      throw new Error(`Pinned field "${value.fieldName}" was not found.`);
    }
    if (seenFieldIds.has(pinned.id)) {
      throw new Error(`Pinned field "${pinned.name}" was provided more than once.`);
    }
    const editable = input.editableFields.get(pinned.id);
    if (editable === undefined) {
      throw new Error(`Pinned field "${pinned.name}" is not editable on ${input.issueKey}. Check the issue screen, field configuration, issue type, project, and workflow status.`);
    }
    fields[pinned.id] = convertFieldValue(value.value, pinned, editable);
    seenFieldIds.add(pinned.id);
    names.push(pinned.name);
  }
  return { fields, names };
}

export function convertFieldValue(value: string, pinned: PinnedCustomField, editable: JiraIssueEditableField): unknown {
  const schema = editable.schema ?? pinned.schema;
  const suffix = customFieldTypeSuffix({ schema }).toLowerCase();
  if (suffix === "textarea") {
    return textToAdfDocument(value);
  }
  if (suffix === "textfield" || schema.type === "string") {
    return value;
  }
  if (schema.type === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    throw new Error(`Field "${pinned.name}" expects a finite number.`);
  }
  if (schema.type === "date" || schema.type === "datetime") {
    return value;
  }
  if (schema.type === "option" || (suffix.includes("select") && !suffix.includes("multi"))) {
    return convertOptionValue(value, pinned, editable.allowedValues);
  }
  if (schema.type === "array" && (schema.items === "option" || suffix.includes("multi"))) {
    return value.split(",").map((part) => convertOptionValue(part.trim(), pinned, editable.allowedValues));
  }
  throw new Error(`Field "${pinned.name}" uses unsupported Jira custom field type ${schema.type}/${suffix || "unknown"}.`);
}

export function textToAdfDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function convertOptionValue(value: string, pinned: PinnedCustomField, allowedValues: readonly unknown[]): Record<string, string> {
  if (value.trim().length === 0) {
    throw new Error(`Field "${pinned.name}" expects a non-empty option value.`);
  }
  const matches = allowedValues.filter((candidate) => optionMatches(candidate, value));
  if (matches.length === 1) {
    const option = matches[0];
    if (isRecord(option) && typeof option["id"] === "string") {
      return { id: option["id"] };
    }
    if (isRecord(option) && typeof option["value"] === "string") {
      return { value: option["value"] };
    }
    if (isRecord(option) && typeof option["name"] === "string") {
      return { value: option["name"] };
    }
  }
  if (allowedValues.length > 0) {
    throw new Error(`Field "${pinned.name}" option value is not allowed or is ambiguous.`);
  }
  return /^\d+$/u.test(value) ? { id: value } : { value };
}

function optionMatches(candidate: unknown, value: string): boolean {
  if (!isRecord(candidate)) {
    return false;
  }
  const needle = value.trim().toLowerCase();
  return [candidate["id"], candidate["value"], candidate["name"]]
    .some((item) => typeof item === "string" && item.trim().toLowerCase() === needle);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
