import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { customFieldSnapshotPath, writeCustomFieldSnapshot } from "../../src/custom-field-store.js";
import { buildIssueFieldUpdate, parseFieldAssignment } from "../../src/custom-field-values.js";
import { createCustomFieldSnapshot, customFieldTypeSuffix, normalizeFieldSchema, searchCustomFields } from "../../src/custom-fields.js";

const textareaField = {
  id: "customfield_10101",
  key: "customfield_10101",
  name: "Custom text A",
  custom: true,
  orderable: true,
  navigable: true,
  searchable: true,
  clauseNames: ["Custom text A"],
  schema: { type: "string", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 },
} as const;

const textfieldPinned = {
  id: "customfield_10102",
  name: "Custom text B",
  schema: { type: "string", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10102 },
} as const;

describe("custom field helpers", () => {
  it("searches IDs, names, clause names, schema types, and custom suffixes", () => {
    const fields = [textareaField];
    expect(searchCustomFields(fields, "10101")).toHaveLength(1);
    expect(searchCustomFields(fields, "custom text a")).toHaveLength(1);
    expect(searchCustomFields(fields, "string")).toHaveLength(1);
    expect(searchCustomFields(fields, "textarea")).toHaveLength(1);
    expect(searchCustomFields(fields, "missing")).toEqual([]);
  });

  it("writes cross-platform home-relative snapshots without secrets", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "jira-fields-"));
    try {
      const snapshot = createCustomFieldSnapshot({ cloudId: "cloud/one", cloudName: "Example", fields: [textareaField], totalFromApi: 1, now: new Date("2026-07-02T00:00:00.000Z") });
      await writeCustomFieldSnapshot(snapshot, { homeDir });
      const path = customFieldSnapshotPath("cloud/one", { homeDir });
      expect(path).toBe(join(homeDir, ".saptools", "jira", "clouds", "cloud_one", "fields.json"));
      const raw = await readFile(path, "utf8");
      expect(raw).toContain("customfield_10101");
      expect(raw).not.toMatch(/accessToken|refreshToken|Authorization|clientSecret/u);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("parses first equals and converts textarea/textfield updates after editability checks", () => {
    expect(parseFieldAssignment("Custom text B=a=b", "--field")).toEqual({ fieldName: "Custom text B", value: "a=b" });
    const update = buildIssueFieldUpdate({
      issueKey: "OPS-123",
      pinnedFields: [{ id: textareaField.id, name: textareaField.name, schema: textareaField.schema }, textfieldPinned],
      values: [{ fieldName: "custom TEXT a", value: "Long note" }, { fieldName: "Custom text B", value: "One line" }],
      editableFields: new Map([
        [textareaField.id, { id: textareaField.id, name: textareaField.name, required: false, allowedValues: [], schema: textareaField.schema }],
        [textfieldPinned.id, { id: textfieldPinned.id, name: textfieldPinned.name, required: false, allowedValues: [], schema: textfieldPinned.schema }],
      ]),
    });
    expect(update.fields).toEqual({
      customfield_10101: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Long note" }] }] },
      customfield_10102: "One line",
    });
  });

  it("fails before PUT when a pinned field is not editable", () => {
    expect(() => buildIssueFieldUpdate({ issueKey: "OPS-123", pinnedFields: [{ id: textareaField.id, name: textareaField.name, schema: textareaField.schema }], values: [{ fieldName: "Custom text A", value: "x" }], editableFields: new Map() }))
      .toThrow('Pinned field "Custom text A" is not editable on OPS-123');
  });
});

  it("converts number, date, option, and multiselect values", () => {
    const numberPinned = { id: "customfield_2", name: "Score", schema: { type: "number", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" } };
    const datePinned = { id: "customfield_3", name: "Due", schema: { type: "date", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker" } };
    const optionPinned = { id: "customfield_4", name: "Choice", schema: { type: "option", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } };
    const multiPinned = { id: "customfield_5", name: "Choices", schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect" } };
    const update = buildIssueFieldUpdate({
      issueKey: "OPS-123",
      pinnedFields: [numberPinned, datePinned, optionPinned, multiPinned],
      values: [
        { fieldName: "Score", value: "4.5" },
        { fieldName: "Due", value: "2026-07-02" },
        { fieldName: "Choice", value: "Alpha" },
        { fieldName: "Choices", value: "one,two" },
      ],
      editableFields: new Map([
        ["customfield_2", { id: "customfield_2", name: "Score", required: false, allowedValues: [], schema: numberPinned.schema }],
        ["customfield_3", { id: "customfield_3", name: "Due", required: false, allowedValues: [], schema: datePinned.schema }],
        ["customfield_4", { id: "customfield_4", name: "Choice", required: false, allowedValues: [{ id: "10", value: "Alpha" }], schema: optionPinned.schema }],
        ["customfield_5", { id: "customfield_5", name: "Choices", required: false, allowedValues: [{ id: "1", value: "one" }, { id: "2", value: "two" }], schema: multiPinned.schema }],
      ]),
    });
    expect(update.fields).toMatchObject({ customfield_2: 4.5, customfield_3: "2026-07-02", customfield_4: { id: "10" }, customfield_5: [{ id: "1" }, { id: "2" }] });
  });

  it("covers empty searches and conversion errors", () => {
    expect(searchCustomFields([textareaField], "")).toHaveLength(1);
    expect(() => parseFieldAssignment("=value", "--field")).toThrow("non-empty field name");
    expect(() => buildIssueFieldUpdate({
      issueKey: "OPS-123",
      pinnedFields: [{ id: "customfield_x", name: "Unsupported", schema: { type: "object", items: null, custom: null } }],
      values: [{ fieldName: "Unsupported", value: "x" }],
      editableFields: new Map([["customfield_x", { id: "customfield_x", name: "Unsupported", required: false, allowedValues: [], schema: { type: "object", items: null, custom: null } }]]),
    })).toThrow("unsupported");
    expect(() => buildIssueFieldUpdate({
      issueKey: "OPS-123",
      pinnedFields: [{ id: "customfield_n", name: "Score", schema: { type: "number", items: null, custom: null } }],
      values: [{ fieldName: "Score", value: "nan" }],
      editableFields: new Map([["customfield_n", { id: "customfield_n", name: "Score", required: false, allowedValues: [], schema: { type: "number", items: null, custom: null } }]]),
    })).toThrow("finite number");
  });

  it("reads pinned custom fields and falls back to null for missing snapshots", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "jira-pinned-"));
    try {
      const store = await import("../../src/custom-field-store.js");
      expect(await store.readCustomFieldSnapshot("cloud-1", { homeDir })).toBeNull();
      expect(await store.readPinnedCustomFields("cloud-1", { homeDir })).toBeNull();
      await store.writePinnedCustomFields({ version: 1, cloudId: "cloud-1", cloudName: "Example", updatedAt: "2026-07-02T00:00:00.000Z", fields: [{ id: "customfield_10101", name: "Custom text A", schema: textareaField.schema }] }, { homeDir });
      await expect(store.readPinnedCustomFields("cloud-1", { homeDir })).resolves.toMatchObject({ fields: [{ name: "Custom text A" }] });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("covers option conversion fallback and ambiguous errors", () => {
    const optionPinned = { id: "customfield_o", name: "Choice", schema: { type: "option", items: null, custom: null } };
    expect(buildIssueFieldUpdate({ issueKey: "OPS-123", pinnedFields: [optionPinned], values: [{ fieldName: "Choice", value: "77" }], editableFields: new Map([["customfield_o", { id: "customfield_o", name: "Choice", required: false, allowedValues: [], schema: optionPinned.schema }]]) }).fields)
      .toEqual({ customfield_o: { id: "77" } });
    expect(() => buildIssueFieldUpdate({ issueKey: "OPS-123", pinnedFields: [optionPinned], values: [{ fieldName: "Choice", value: "Alpha" }], editableFields: new Map([["customfield_o", { id: "customfield_o", name: "Choice", required: false, allowedValues: [{ value: "Alpha" }, { name: "Alpha" }], schema: optionPinned.schema }]]) }))
      .toThrow("ambiguous");
    expect(() => buildIssueFieldUpdate({ issueKey: "OPS-123", pinnedFields: [optionPinned], values: [{ fieldName: "Missing", value: "x" }], editableFields: new Map([["customfield_o", { id: "customfield_o", name: "Choice", required: false, allowedValues: [], schema: optionPinned.schema }]]) }))
      .toThrow("was not found");
  });


  it("normalizes missing schemas and custom type suffix fallbacks", () => {
    expect(normalizeFieldSchema(undefined)).toEqual({ custom: null, items: null, type: "any" });
    expect(customFieldTypeSuffix({ schema: { type: "array", items: "option", custom: null } })).toBe("option");
    expect(customFieldTypeSuffix({ schema: { type: "string", items: null, custom: "textfield" } })).toBe("textfield");
  });
