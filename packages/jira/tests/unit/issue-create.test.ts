import { describe, expect, it, vi } from "vitest";

import type { JiraAdfDocument } from "../../src/adf.js";
import type { JiraIssueEditableField } from "../../src/custom-fields.js";
import {
  buildJiraCreateIssueFields,
  createJiraIssue,
  fetchJiraCreateIssueFieldMetadata,
  fetchJiraCreateIssueTypes,
  normalizeJiraCreateLabels,
  resolveJiraCreateIssueType,
} from "../../src/issue-create.js";
import type { JiraCreateIssueType } from "../../src/types.js";

type FetchInput = Parameters<typeof fetch>[0];

const baseUrl = "https://jira-api.example.com/ex/jira/cloud-1";
const authorization = "Bearer secret-access-token";

const taskType: JiraCreateIssueType = { id: "10001", name: "Task", subtask: false };
const subtaskType: JiraCreateIssueType = { id: "10002", name: "Subtask", subtask: true };

function editableField(overrides: Partial<JiraIssueEditableField> & { readonly id: string }): JiraIssueEditableField {
  return {
    name: overrides.id,
    required: false,
    allowedValues: [],
    schema: null,
    ...overrides,
  };
}

function fieldMetadataMap(fields: readonly JiraIssueEditableField[]): ReadonlyMap<string, JiraIssueEditableField> {
  return new Map(fields.map((field) => [field.id, field]));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function sequencedFetch(responses: readonly Response[]): typeof fetch {
  let call = 0;
  return (async () => {
    const response = responses[call];
    call += 1;
    if (response === undefined) {
      throw new Error(`Unexpected extra fetch call (#${(call).toString()})`);
    }
    return await Promise.resolve(response);
  }) as typeof fetch;
}

describe("Jira issue-type resolution", () => {
  it("matches an issue type by case-insensitive display name", () => {
    expect(resolveJiraCreateIssueType([taskType, subtaskType], "task", "OPS")).toEqual(taskType);
    expect(resolveJiraCreateIssueType([taskType, subtaskType], "SUBTASK", "OPS")).toEqual(subtaskType);
  });

  it("lists available names when no issue type matches", () => {
    expect(() => resolveJiraCreateIssueType([taskType, subtaskType], "Epic", "OPS")).toThrow(
      'Jira issue type "Epic" was not found in project OPS. Available: Subtask, Task.',
    );
    expect(() => resolveJiraCreateIssueType([], "Epic", "OPS")).toThrow(
      'Jira issue type "Epic" was not found in project OPS.',
    );
  });
});

describe("Jira create-issue label normalization", () => {
  it("trims and dedupes while preserving first-seen order", () => {
    expect(normalizeJiraCreateLabels([" ops ", "ops", "urgent"])).toEqual(["ops", "urgent"]);
    expect(normalizeJiraCreateLabels([])).toEqual([]);
  });

  it("rejects a blank label", () => {
    expect(() => normalizeJiraCreateLabels(["ops", "  "])).toThrow("must not be blank");
  });
});

describe("Jira create-issue field assembly", () => {
  it("builds the minimal fields payload for a non-subtask issue type", () => {
    const fields = buildJiraCreateIssueFields({
      fieldMetadata: fieldMetadataMap([]),
      fieldValues: [],
      issueType: taskType,
      labels: [],
      projectKey: "OPS",
      summary: "Fix the deploy pipeline",
    });

    expect(fields).toEqual({
      project: { key: "OPS" },
      issuetype: { id: "10001" },
      summary: "Fix the deploy pipeline",
    });
  });

  it("includes description, priority, labels, parent, and custom fields when supplied", () => {
    const description: JiraAdfDocument = { type: "doc", version: 1, content: [{ type: "paragraph" }] };
    const fieldMetadata = fieldMetadataMap([
      editableField({ id: "description", name: "Description" }),
      editableField({
        id: "priority",
        name: "Priority",
        allowedValues: [{ id: "2", name: "High" }],
      }),
      editableField({ id: "labels", name: "Labels" }),
      editableField({ id: "parent", name: "Parent" }),
      editableField({
        id: "customfield_10101",
        name: "Custom text A",
        schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", items: null, type: "string" },
      }),
    ]);

    const fields = buildJiraCreateIssueFields({
      description,
      fieldMetadata,
      issueType: subtaskType,
      labels: ["ops", "urgent"],
      parentKey: "OPS-1",
      priorityName: "high",
      projectKey: "OPS",
      summary: "Investigate flaky test",
      fieldValues: [{ fieldName: "Custom text A", value: "Needs triage" }],
    });

    expect(fields).toEqual({
      project: { key: "OPS" },
      issuetype: { id: "10002" },
      summary: "Investigate flaky test",
      description,
      priority: { id: "2" },
      labels: ["ops", "urgent"],
      parent: { key: "OPS-1" },
      customfield_10101: "Needs triage",
    });
  });

  it("requires --parent for a subtask issue type and refuses it for a standard type", () => {
    const build = (issueType: JiraCreateIssueType, parentKey?: string): unknown => buildJiraCreateIssueFields({
      fieldMetadata: fieldMetadataMap([]),
      fieldValues: [],
      issueType,
      labels: [],
      projectKey: "OPS",
      summary: "Summary",
      ...(parentKey === undefined ? {} : { parentKey }),
    });

    expect(() => build(subtaskType)).toThrow("is a subtask type and requires --parent");
    expect(() => build(taskType, "OPS-1")).toThrow("--parent is only valid for a subtask issue type");
  });

  it("refuses labels when the project does not expose a labels field", () => {
    expect(() => buildJiraCreateIssueFields({
      fieldMetadata: fieldMetadataMap([]),
      fieldValues: [],
      issueType: taskType,
      labels: ["ops"],
      projectKey: "OPS",
      summary: "Summary",
    })).toThrow("Labels is not available when creating this issue in project OPS.");
  });

  it("refuses a priority when the project does not expose a priority field", () => {
    expect(() => buildJiraCreateIssueFields({
      fieldMetadata: fieldMetadataMap([]),
      fieldValues: [],
      issueType: taskType,
      labels: [],
      priorityName: "High",
      projectKey: "OPS",
      summary: "Summary",
    })).toThrow("Priority is not available when creating this issue in project OPS.");
  });

  it("resolves priority by id/name only, never the {value} shape a custom option field would use", () => {
    const build = (priorityName: string, allowedValues: readonly unknown[]): unknown => buildJiraCreateIssueFields({
      fieldMetadata: fieldMetadataMap([editableField({ id: "priority", name: "Priority", allowedValues })]),
      fieldValues: [],
      issueType: taskType,
      labels: [],
      priorityName,
      projectKey: "OPS",
      summary: "Summary",
    });

    expect(build("urgent", [])).toMatchObject({ priority: { name: "urgent" } });
    expect(build("High", [{ id: "2", name: "High" }])).toMatchObject({ priority: { id: "2" } });
    expect(() => build("  ", [{ id: "2", name: "High" }])).toThrow(
      'Field "Priority" expects a non-empty option value.',
    );
    expect(() => build("Nonexistent", [{ id: "2", name: "High" }])).toThrow(
      'Field "Priority" option value is not allowed or is ambiguous.',
    );
  });

  it("rejects an unresolved, ambiguous, or repeated custom field", () => {
    const fieldMetadata = fieldMetadataMap([
      editableField({ id: "customfield_1", name: "Duplicate Name", schema: { custom: null, items: null, type: "string" } }),
      editableField({ id: "customfield_2", name: "Duplicate Name", schema: { custom: null, items: null, type: "string" } }),
      editableField({ id: "customfield_3", name: "Notes", schema: { custom: null, items: null, type: "string" } }),
    ]);
    const build = (fieldValues: { readonly fieldName: string; readonly value: string }[]): unknown => buildJiraCreateIssueFields({
      fieldMetadata,
      fieldValues,
      issueType: taskType,
      labels: [],
      projectKey: "OPS",
      summary: "Summary",
    });

    expect(() => build([{ fieldName: "Missing Field", value: "x" }])).toThrow("was not found for this project");
    expect(() => build([{ fieldName: "Duplicate Name", value: "x" }])).toThrow("is ambiguous for this project");
    expect(() => build([{ fieldName: "Notes", value: "a" }, { fieldName: "Notes", value: "b" }])).toThrow(
      'Field "Notes" was provided more than once.',
    );
  });

  it("fails before any write when a project-required field is not supplied", () => {
    const fieldMetadata = fieldMetadataMap([
      editableField({ id: "customfield_9", name: "Epic Link", required: true, schema: { custom: null, items: null, type: "string" } }),
      editableField({ id: "reporter", name: "Reporter", required: true }),
    ]);

    expect(() => buildJiraCreateIssueFields({
      fieldMetadata,
      fieldValues: [],
      issueType: taskType,
      labels: [],
      projectKey: "OPS",
      summary: "Summary",
    })).toThrow(
      "Project OPS requires additional fields for this issue type: Epic Link. Supply them with --field 'FIELD NAME=value'.",
    );

    expect(buildJiraCreateIssueFields({
      fieldMetadata,
      fieldValues: [{ fieldName: "Epic Link", value: "OPS-1" }],
      issueType: taskType,
      labels: [],
      projectKey: "OPS",
      summary: "Summary",
    })).toMatchObject({ customfield_9: "OPS-1" });
  });

  it("treats description, priority, labels, and parent as satisfying their own required system field", () => {
    const fieldMetadata = fieldMetadataMap([
      editableField({ id: "description", name: "Description", required: true }),
      editableField({ id: "priority", name: "Priority", required: true, allowedValues: [{ id: "1", name: "High" }] }),
      editableField({ id: "labels", name: "Labels", required: true }),
      editableField({ id: "parent", name: "Parent", required: true }),
    ]);

    const fields = buildJiraCreateIssueFields({
      fieldMetadata,
      fieldValues: [],
      issueType: subtaskType,
      labels: ["ops"],
      parentKey: "OPS-1",
      priorityName: "High",
      projectKey: "OPS",
      summary: "Summary",
      description: { type: "doc", version: 1, content: [] },
    });

    expect(fields).toMatchObject({ labels: ["ops"], parent: { key: "OPS-1" }, priority: { id: "1" } });
  });
});

describe("Jira create-issue type and field metadata fetches", () => {
  it("fetches a single page of issue types and defaults a missing subtask flag to false", async () => {
    const fetchMock = vi.fn(sequencedFetch([
      jsonResponse({ isLast: true, startAt: 0, total: 1, issueTypes: [{ id: "10001", name: "Task" }] }),
    ]));

    await expect(fetchJiraCreateIssueTypes({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS"))
      .resolves.toEqual([{ id: "10001", name: "Task", subtask: false }]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/rest/api/3/issue/createmeta/OPS/issuetypes?startAt=0&maxResults=50`,
      { headers: { Accept: "application/json", Authorization: authorization } },
    );
  });

  it("follows pagination across multiple issue-type pages", async () => {
    const fetchMock = vi.fn(sequencedFetch([
      jsonResponse({ isLast: false, startAt: 0, total: 2, issueTypes: [{ id: "1", name: "Task" }] }),
      jsonResponse({ isLast: true, startAt: 1, total: 2, issueTypes: [{ id: "2", name: "Bug" }] }),
    ]));

    await expect(fetchJiraCreateIssueTypes({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS"))
      .resolves.toEqual([
        { id: "1", name: "Task", subtask: false },
        { id: "2", name: "Bug", subtask: false },
      ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid issue-types response", async () => {
    const fetchMock = vi.fn(sequencedFetch([jsonResponse({ issueTypes: [{ id: "" }] })]));

    await expect(fetchJiraCreateIssueTypes({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS"))
      .rejects.toThrow("Jira issue types response was not valid.");
  });

  it("surfaces the project key on a failed issue-types load", async () => {
    const fetchMock = vi.fn(sequencedFetch([new Response("not found", { status: 404 })]));

    await expect(fetchJiraCreateIssueTypes({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS"))
      .rejects.toThrow('Jira issue types for project "OPS" could not be loaded.');
  });

  it("fetches field metadata and normalizes missing name, required, allowedValues, and schema", async () => {
    const fetchMock = vi.fn(sequencedFetch([
      jsonResponse({
        isLast: true,
        startAt: 0,
        total: 1,
        fields: [{ fieldId: "summary" }],
      }),
    ]));

    await expect(fetchJiraCreateIssueFieldMetadata({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS", "10001"))
      .resolves.toEqual(new Map([["summary", { id: "summary", name: "summary", required: false, allowedValues: [], schema: null }]]));
  });

  it("follows pagination across multiple field-metadata pages", async () => {
    const fetchMock = vi.fn(sequencedFetch([
      jsonResponse({ isLast: false, startAt: 0, total: 2, fields: [{ fieldId: "summary", required: true }] }),
      jsonResponse({ isLast: true, startAt: 1, total: 2, fields: [{ fieldId: "priority", schema: { type: "priority" } }] }),
    ]));

    const fields = await fetchJiraCreateIssueFieldMetadata(
      { authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock },
      "OPS",
      "10001",
    );
    expect([...fields.keys()]).toEqual(["summary", "priority"]);
    expect(fields.get("priority")).toMatchObject({ schema: { custom: null, items: null, type: "priority" } });
  });

  it("rejects an invalid field-metadata response", async () => {
    const fetchMock = vi.fn(sequencedFetch([jsonResponse({ fields: [{}] })]));

    await expect(fetchJiraCreateIssueFieldMetadata({ authorization, baseUrl, cloudId: "cloud-1", fetchImpl: fetchMock }, "OPS", "10001"))
      .rejects.toThrow("Jira create-issue field metadata response was not valid.");
  });
});

describe("Jira issue creation", () => {
  function stubCreatePipeline(createResponse: Response): typeof fetch {
    return sequencedFetch([
      jsonResponse({ isLast: true, startAt: 0, total: 1, issueTypes: [{ id: "10001", name: "Task", subtask: false }] }),
      jsonResponse({ isLast: true, startAt: 0, total: 0, fields: [] }),
      createResponse,
    ]);
  }

  it("creates an issue end to end and returns the new key, id, and resolved issue type", async () => {
    const fetchMock = vi.fn(stubCreatePipeline(jsonResponse({ id: "30001", key: "OPS-456" }, 201)));

    await expect(createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueTypeName: "task",
      projectKey: "OPS",
      summary: "  New ticket  ",
    })).resolves.toEqual({ id: "30001", issueType: "Task", key: "OPS-456" });

    const createCall = fetchMock.mock.calls[2] as [FetchInput, RequestInit];
    expect(createCall[0]).toBe(`${baseUrl}/rest/api/3/issue`);
    expect(createCall[1]).toMatchObject({ method: "POST" });
    const requestBody = createCall[1].body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected a string request body");
    }
    expect(JSON.parse(requestBody)).toEqual({
      fields: { project: { key: "OPS" }, issuetype: { id: "10001" }, summary: "New ticket" },
    });
  });

  it("supports --notify-users=false on the create URL", async () => {
    const fetchMock = vi.fn(stubCreatePipeline(jsonResponse({ id: "1", key: "OPS-1" }, 201)));

    await createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueTypeName: "Task",
      notifyUsers: false,
      projectKey: "OPS",
      summary: "Summary",
    });

    const createCall = fetchMock.mock.calls[2] as [FetchInput];
    expect(createCall[0]).toBe(`${baseUrl}/rest/api/3/issue?notifyUsers=false`);
  });

  it("rejects a blank summary before any Jira request", async () => {
    const fetchMock = vi.fn(stubCreatePipeline(jsonResponse({ id: "1", key: "OPS-1" }, 201)));

    await expect(createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueTypeName: "Task",
      projectKey: "OPS",
      summary: "   ",
    })).rejects.toThrow("Summary must not be empty.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops after resolving the issue type when it does not exist, without loading field metadata", async () => {
    const fetchMock = vi.fn(sequencedFetch([
      jsonResponse({ isLast: true, startAt: 0, total: 1, issueTypes: [{ id: "10001", name: "Task", subtask: false }] }),
    ]));

    await expect(createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueTypeName: "Epic",
      projectKey: "OPS",
      summary: "Summary",
    })).rejects.toThrow('Jira issue type "Epic" was not found in project OPS.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed create response and an invalid create response body", async () => {
    const failed = vi.fn(stubCreatePipeline(new Response("server error", { status: 500 })));
    await expect(createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: failed,
      issueTypeName: "Task",
      projectKey: "OPS",
      summary: "Summary",
    })).rejects.toThrow("Jira issue could not be created.");

    const malformed = vi.fn(stubCreatePipeline(jsonResponse({ key: "OPS-1" })));
    await expect(createJiraIssue({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: malformed,
      issueTypeName: "Task",
      projectKey: "OPS",
      summary: "Summary",
    })).rejects.toThrow("Jira issue creation response was not valid.");
  });
});
