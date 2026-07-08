import { z } from "zod";

import { JiraAdfDocumentSchema, textToAdfDocument, type JiraAdfDocument } from "./adf.js";
import { parseJiraAssignableUsers, parseJiraCurrentUser } from "./assignment.js";
import { JiraCustomFieldSearchPageSchema, JiraIssueEditMetadataSchema, normalizeCustomField, normalizeFieldSchema } from "./custom-fields.js";
import type { JiraCustomFieldSearchPage, JiraIssueEditableField, NormalizedCustomField } from "./custom-fields.js";
import {
  collectAdfMediaReferences,
  collectDescriptionImageReferences,
  hasAdfMedia,
  hydrateIssueImages,
  type JiraIssueImageReference,
} from "./issue-images.js";
import type {
  AddJiraIssueCommentOptions,
  AddJiraIssueWorklogOptions,
  AssignJiraIssueOptions,
  FetchAssignedJiraIssuesOptions,
  FetchJiraCustomFieldsOptions,
  FetchJiraIssueDetailOptions,
  JiraAssignableUser,
  JiraIssueAttachment,
  JiraIssueComment,
  JiraIssueCommentResult,
  JiraIssueDetail,
  JiraIssueKeyRequestOptions,
  JiraIssueRemoteLink,
  JiraIssueSummary,
  JiraIssueTransition,
  JiraRequestOptions,
  SearchJiraAssignableUsersOptions,
  TransitionJiraIssueOptions,
  UpdateJiraIssueDescriptionOptions,
  UpdateJiraIssueFieldsOptions,
  UpdateJiraIssueSummaryOptions,
} from "./types.js";
import {
  buildAssignedIssuesSearchBody,
  buildAssignedIssuesSearchUrl,
  buildJiraAssignableUserSearchUrl,
  buildJiraCurrentUserUrl,
  buildJiraFieldSearchUrl,
  buildJiraIssueAssigneeUrl,
  buildJiraIssueCommentCreateUrl,
  buildJiraIssueCommentsUrl,
  buildJiraIssueDescriptionUrl,
  buildJiraIssueDetailUrl,
  buildJiraIssueEditMetaUrl,
  buildJiraIssueRemoteLinksUrl,
  buildJiraIssueUpdateUrl,
  buildJiraIssueTransitionsUrl,
  buildJiraIssueWorklogUrl,
} from "./urls.js";
import { formatJiraDate } from "./worklog-history.js";

const nonEmptyStringSchema = z.string().min(1);
const JIRA_COMMENTS_PAGE_SIZE = 100;

interface ParsedJiraIssueDetail {
  readonly commentImageReferences: readonly JiraIssueImageReference[];
  readonly detail: JiraIssueDetail;
  readonly descriptionImageReferences: readonly JiraIssueImageReference[];
}

interface MappedComments {
  readonly comments: JiraIssueComment[];
  readonly imageReferences: readonly JiraIssueImageReference[];
}

const JiraIssueSummarySchema = z.object({
  key: nonEmptyStringSchema,
  fields: z.object({
    summary: nonEmptyStringSchema,
    status: z.object({
      name: nonEmptyStringSchema,
      statusCategory: z.object({ name: nonEmptyStringSchema }),
    }),
    priority: z.object({ name: nonEmptyStringSchema }).nullable().optional(),
    assignee: z.object({ displayName: nonEmptyStringSchema }).nullable().optional(),
    issuetype: z.object({ name: nonEmptyStringSchema }),
    updated: nonEmptyStringSchema,
  }),
});

const JiraAssignedIssuesResponseSchema = z.object({
  issues: z.array(JiraIssueSummarySchema),
});

const JiraRemoteLinkSchema = z.object({
  id: z.union([z.string(), z.number()]),
  relationship: z.string().optional(),
  object: z.object({
    title: nonEmptyStringSchema,
    url: nonEmptyStringSchema,
  }),
});

const JiraTransitionResponseSchema = z.object({
  transitions: z.array(
    z.object({
      id: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
      to: z.object({ name: nonEmptyStringSchema }).optional(),
    }),
  ),
});

const CommentSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  author: z.object({ displayName: z.string().optional() }).optional(),
  body: z.unknown().optional().nullable(),
  created: z.string().optional(),
});

const JiraCommentsResponseSchema = z.object({
  comments: z.array(CommentSchema),
  isLast: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});

const JiraCommentCreateResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
}).loose();

const AttachmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  filename: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema,
  size: z.number().nonnegative().optional(),
});

const LinkedIssueSchema = z.object({
  key: nonEmptyStringSchema,
  fields: z.object({ status: z.object({ name: nonEmptyStringSchema }).optional() }).optional(),
});

const IssueLinkSchema = z.object({
  type: z
    .object({
      inward: z.string().optional(),
      name: z.string().optional(),
      outward: z.string().optional(),
    })
    .optional(),
  inwardIssue: LinkedIssueSchema.optional(),
  outwardIssue: LinkedIssueSchema.optional(),
});

const JiraIssueDetailResponseSchema = z.object({
  key: nonEmptyStringSchema,
  renderedFields: z
    .object({
      description: z.string().nullable().optional(),
    })
    .optional(),
  fields: JiraIssueSummarySchema.shape.fields.extend({
    attachment: z.array(AttachmentSchema).optional(),
    comment: z.union([z.array(CommentSchema), z.object({ comments: z.array(CommentSchema) })]).optional(),
    description: z.unknown().optional().nullable(),
    issuelinks: z.array(IssueLinkSchema).optional(),
  }),
});

const JiraIssueDescriptionResponseSchema = z.object({
  fields: z.object({
    description: JiraAdfDocumentSchema.nullable().optional(),
  }),
});


export async function fetchJiraCustomFields(
  options: FetchJiraCustomFieldsOptions,
): Promise<{ readonly fields: readonly NormalizedCustomField[]; readonly totalFromApi: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResults = options.maxResults ?? 50;
  const fields: NormalizedCustomField[] = [];
  let totalFromApi = 0;
  let startAt = 0;
  let done = false;
  while (!done) {
    const response = await fetchImpl(buildJiraFieldSearchUrl(options.cloudId, startAt, maxResults, options.apiRoot), {
      headers: readJiraHeaders(options.accessToken),
    });
    assertOk(response, "Jira custom fields could not be loaded.");
    const page = parseCustomFieldPage(await response.json());
    fields.push(...page.values.map(normalizeCustomField));
    totalFromApi = page.total ?? fields.length;
    const pageStartAt = page.startAt ?? startAt;
    const nextStartAt = pageStartAt + page.values.length;
    done = page.isLast === true || page.values.length === 0 || nextStartAt <= startAt || (page.total !== undefined && nextStartAt >= page.total);
    startAt = nextStartAt;
  }
  return { fields, totalFromApi };
}

export async function fetchJiraIssueEditMetadata(
  options: JiraIssueKeyRequestOptions,
): Promise<ReadonlyMap<string, JiraIssueEditableField>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(buildJiraIssueEditMetaUrl(options.cloudId, options.issueKey, options.apiRoot), {
    headers: readJiraHeaders(options.accessToken),
  });
  assertOk(response, "Jira issue edit metadata could not be loaded.");
  const parsed = JiraIssueEditMetadataSchema.safeParse(await response.json());
  if (!parsed.success) {throw new Error("Jira issue edit metadata response was not valid.");}
  return new Map(Object.entries(parsed.data.fields).map(([id, field]) => [id, {
    id,
    name: field.name ?? id,
    required: field.required ?? false,
    allowedValues: field.allowedValues ?? [],
    schema: field.schema === undefined ? null : normalizeFieldSchema(field.schema),
  }]));
}

export async function updateJiraIssueFields(options: UpdateJiraIssueFieldsOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueUpdateUrl(
      options.cloudId,
      options.issueKey,
      updateUrlOptions(options),
      options.apiRoot,
    ),
    {
      body: JSON.stringify({ fields: options.fields }),
      headers: jsonJiraHeaders(options.accessToken),
      method: "PUT",
    },
  );
  assertOk(response, "Jira issue fields could not be updated.");
}

export async function fetchJiraIssueDescriptionAdf(
  options: JiraIssueKeyRequestOptions,
): Promise<JiraAdfDocument | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueDescriptionUrl(options.cloudId, options.issueKey, options.apiRoot),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertOk(response, "Jira issue description could not be loaded.");
  const parsed = JiraIssueDescriptionResponseSchema.safeParse(await response.json());
  if (parsed.success) {
    return parsed.data.fields.description ?? null;
  }
  throw new Error("Jira issue description response was not valid.");
}

export async function updateJiraIssueDescription(
  options: UpdateJiraIssueDescriptionOptions,
): Promise<void> {
  const editableFields = await fetchJiraIssueEditMetadata(options);
  requireEditableIssueField(editableFields, "description", options.issueKey);
  const currentDescription = shouldFetchCurrentDescription(options)
    ? await fetchJiraIssueDescriptionAdf(options)
    : null;
  const description = resolveDescriptionUpdateDocument(options, currentDescription);
  await updateJiraIssueFields({
    ...options,
    fields: { description },
  });
}

export async function updateJiraIssueSummary(
  options: UpdateJiraIssueSummaryOptions,
): Promise<void> {
  const summary = options.summary.trim();
  if (summary.length === 0) {
    throw new Error("Jira issue summary must not be empty.");
  }
  const editableFields = await fetchJiraIssueEditMetadata(options);
  requireEditableIssueField(editableFields, "summary", options.issueKey);
  await updateJiraIssueFields({
    ...options,
    fields: { summary },
  });
}

export async function addJiraIssueComment(
  options: AddJiraIssueCommentOptions,
): Promise<JiraIssueCommentResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueCommentCreateUrl(options.cloudId, options.issueKey, options.apiRoot),
    {
      body: JSON.stringify({ body: options.body }),
      headers: jsonJiraHeaders(options.accessToken),
      method: "POST",
    },
  );
  assertOk(response, "Jira issue comment could not be added.");
  const parsed = JiraCommentCreateResponseSchema.safeParse(await response.json());
  if (parsed.success) {
    return { id: String(parsed.data.id) };
  }
  throw new Error("Jira issue comment response was not valid.");
}

function updateUrlOptions(
  options: UpdateJiraIssueFieldsOptions,
): { readonly notifyUsers?: boolean } {
  return options.notifyUsers === undefined ? {} : { notifyUsers: options.notifyUsers };
}

function requireEditableIssueField(
  editableFields: ReadonlyMap<string, JiraIssueEditableField>,
  fieldId: "description" | "summary",
  issueKey: string,
): void {
  if (editableFields.has(fieldId)) {
    return;
  }
  throw new Error(`Jira field "${fieldId}" is not editable on ${issueKey}. Check the issue screen, field configuration, issue type, project, and workflow status.`);
}

function resolveDescriptionUpdateDocument(
  options: UpdateJiraIssueDescriptionOptions,
  currentDescription: JiraAdfDocument | null,
): JiraAdfDocument {
  if ((options.mode ?? "replace") === "append") {
    return appendAdfDocument(currentDescription, options.description);
  }
  if (options.inputKind === "plain-text" && options.force !== true && hasAdfMedia(currentDescription)) {
    throw new Error(`Current description on ${options.issueKey} contains media. Use --append to preserve it or --force to replace it.`);
  }
  return options.description;
}

function shouldFetchCurrentDescription(options: UpdateJiraIssueDescriptionOptions): boolean {
  return (options.mode ?? "replace") === "append" || options.inputKind === "plain-text";
}

function appendAdfDocument(
  currentDescription: JiraAdfDocument | null,
  addition: JiraAdfDocument,
): JiraAdfDocument {
  if (currentDescription === null) {
    return addition;
  }
  return {
    ...currentDescription,
    content: [...currentDescription.content, ...addition.content],
  };
}

export async function fetchJiraCurrentUser(options: JiraRequestOptions): Promise<JiraAssignableUser> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(buildJiraCurrentUserUrl(options.cloudId, options.apiRoot), {
    headers: readJiraHeaders(options.accessToken),
  });
  assertOk(response, "Jira current user could not be loaded.");
  return parseJiraCurrentUser(await response.json());
}

export async function searchJiraAssignableUsers(
  options: SearchJiraAssignableUsersOptions,
): Promise<JiraAssignableUser[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraAssignableUserSearchUrl(
      options.cloudId,
      options.issueKey,
      assignableSearchUrlOptions(options),
      options.apiRoot,
    ),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertOk(response, "Jira assignable users could not be loaded.");
  return parseJiraAssignableUsers(await response.json());
}

function assignableSearchUrlOptions(
  options: SearchJiraAssignableUsersOptions,
): { readonly accountId?: string; readonly query?: string } {
  return {
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.query === undefined ? {} : { query: options.query }),
  };
}

export async function assignJiraIssue(options: AssignJiraIssueOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueAssigneeUrl(options.cloudId, options.issueKey, options.apiRoot),
    {
      body: JSON.stringify({ accountId: options.accountId }),
      headers: jsonJiraHeaders(options.accessToken),
      method: "PUT",
    },
  );
  assertOk(response, "Jira issue assignee could not be updated.");
}

export async function fetchAssignedJiraIssues(
  options: FetchAssignedJiraIssuesOptions,
): Promise<JiraIssueSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildAssignedIssuesSearchUrl(options.cloudId, options.apiRoot),
    {
      body: JSON.stringify(buildAssignedIssuesSearchBody(options.maxResults)),
      headers: jsonJiraHeaders(options.accessToken),
      method: "POST",
    },
  );
  assertOk(response, "Assigned Jira issues could not be loaded.");
  const responseBody: unknown = await response.json();
  return parseAssignedIssuesResponse(responseBody);
}

export async function fetchJiraIssueDetail(
  options: FetchJiraIssueDetailOptions,
): Promise<JiraIssueDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueDetailUrl(options.cloudId, options.issueKey, options.apiRoot),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertOk(response, "Jira issue detail could not be loaded.");
  const responseBody: unknown = await response.json();
  const parsed = parseJiraIssueDetail(responseBody);
  const mappedComments = await fetchPaginatedIssueComments(options);
  const detail =
    mappedComments === null ? parsed.detail : { ...parsed.detail, comments: mappedComments.comments };
  const imageReferences = [
    ...parsed.descriptionImageReferences,
    ...(mappedComments?.imageReferences ?? parsed.commentImageReferences),
  ];
  return options.downloadImages === true
    ? await hydrateIssueImages(detail, imageReferences, options)
    : detail;
}

export async function fetchJiraIssueRemoteLinks(
  options: JiraIssueKeyRequestOptions,
): Promise<JiraIssueRemoteLink[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueRemoteLinksUrl(options.cloudId, options.issueKey, options.apiRoot),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertOk(response, "Jira remote links could not be loaded.");
  const responseBody: unknown = await response.json();
  return parseRemoteLinksResponse(responseBody);
}

export async function fetchJiraIssueTransitions(
  options: JiraIssueKeyRequestOptions,
): Promise<JiraIssueTransition[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueTransitionsUrl(options.cloudId, options.issueKey, options.apiRoot),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertOk(response, "Jira issue transitions could not be loaded.");
  const responseBody: unknown = await response.json();
  return parseTransitionsResponse(responseBody);
}

export async function transitionJiraIssue(
  options: TransitionJiraIssueOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueTransitionsUrl(options.cloudId, options.issueKey, options.apiRoot),
    {
      body: JSON.stringify({ transition: { id: options.transitionId } }),
      headers: jsonJiraHeaders(options.accessToken),
      method: "POST",
    },
  );
  assertOk(response, "Jira issue transition could not be applied.");
}

export async function addJiraIssueWorklog(
  options: AddJiraIssueWorklogOptions,
): Promise<void> {
  if (!Number.isInteger(options.minutes) || options.minutes <= 0) {
    throw new Error("Jira worklog minutes must be a positive integer.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueWorklogUrl(options.cloudId, options.issueKey, options.apiRoot),
    {
      body: JSON.stringify(buildWorklogRequestBody(options)),
      headers: jsonJiraHeaders(options.accessToken),
      method: "POST",
    },
  );
  assertOk(response, "Jira worklog could not be added.");
}

export function extractTextFromAdf(value: unknown): string {
  return collectAdfText(value).join(" ").replaceAll(/\s+/gu, " ").trim();
}

function parseCustomFieldPage(responseBody: unknown): JiraCustomFieldSearchPage {
  const parsed = JiraCustomFieldSearchPageSchema.safeParse(responseBody);
  if (parsed.success) {return parsed.data;}
  throw new Error("Jira custom field response was not valid.");
}

function parseAssignedIssuesResponse(responseBody: unknown): JiraIssueSummary[] {
  const parseResult = JiraAssignedIssuesResponseSchema.safeParse(responseBody);
  if (parseResult.success) {
    return parseResult.data.issues.map(mapIssueSummary);
  }

  throw new Error("Assigned Jira issue response was not valid.");
}

function parseJiraIssueDetail(responseBody: unknown): ParsedJiraIssueDetail {
  const parseResult = JiraIssueDetailResponseSchema.safeParse(responseBody);
  if (parseResult.success) {
    return mapIssueDetail(parseResult.data);
  }

  throw new Error("Jira issue detail response was not valid.");
}

function parseRemoteLinksResponse(responseBody: unknown): JiraIssueRemoteLink[] {
  const parseResult = z.array(JiraRemoteLinkSchema).safeParse(responseBody);
  if (parseResult.success) {
    return parseResult.data.map((link) => ({
      id: String(link.id),
      relationship: link.relationship ?? "Remote link",
      title: link.object.title,
      url: link.object.url,
    }));
  }

  throw new Error("Jira remote links response was not valid.");
}

function parseTransitionsResponse(responseBody: unknown): JiraIssueTransition[] {
  const parseResult = JiraTransitionResponseSchema.safeParse(responseBody);
  if (parseResult.success) {
    return parseResult.data.transitions.map((transition) => ({
      id: transition.id,
      name: transition.name,
      toStatus: transition.to?.name ?? transition.name,
    }));
  }

  throw new Error("Jira issue transitions response was not valid.");
}

function mapIssueDetail(
  issue: z.infer<typeof JiraIssueDetailResponseSchema>,
): ParsedJiraIssueDetail {
  const mappedComments = mapComments(issue.fields.comment);
  const descriptionImageReferences = collectDescriptionImageReferences(
    issue.fields.description,
    issue.renderedFields?.description ?? "",
  );
  const detail = {
    ...mapIssueSummary(issue),
    attachments: mapAttachments(issue.fields.attachment ?? []),
    comments: mappedComments.comments,
    descriptionText: extractTextFromAdf(issue.fields.description),
    images: [],
    linkedCloneIssues: mapCloneIssueLinks(issue.fields.issuelinks ?? []),
  };
  return {
    detail,
    commentImageReferences: mappedComments.imageReferences,
    descriptionImageReferences,
  };
}

async function fetchPaginatedIssueComments(
  options: JiraIssueKeyRequestOptions,
): Promise<MappedComments | null> {
  try {
    return await fetchPaginatedIssueCommentsOrThrow(options);
  } catch {
    return null;
  }
}

async function fetchPaginatedIssueCommentsOrThrow(
  options: JiraIssueKeyRequestOptions,
): Promise<MappedComments> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const comments: z.infer<typeof CommentSchema>[] = [];
  let isComplete = false;
  let startAt = 0;

  while (!isComplete) {
    const response = await fetchImpl(
      buildJiraIssueCommentsUrl(
        options.cloudId,
        options.issueKey,
        startAt,
        JIRA_COMMENTS_PAGE_SIZE,
        options.apiRoot,
      ),
      { headers: readJiraHeaders(options.accessToken) },
    );
    if (!response.ok) {
      throw new Error("Jira issue comments could not be loaded.");
    }

    const page = parseCommentsPage(await response.json());
    comments.push(...page.comments);
    const pageStartAt = page.startAt ?? startAt;
    const nextStartAt = pageStartAt + page.comments.length;
    isComplete = isLastCommentsPage(page, startAt, nextStartAt);
    startAt = nextStartAt;
  }

  return mapCommentList(comments);
}

function parseCommentsPage(
  responseBody: unknown,
): z.infer<typeof JiraCommentsResponseSchema> {
  const parseResult = JiraCommentsResponseSchema.safeParse(responseBody);
  if (parseResult.success) {
    return parseResult.data;
  }

  throw new Error("Jira issue comments response was not valid.");
}

function isLastCommentsPage(
  page: z.infer<typeof JiraCommentsResponseSchema>,
  currentStartAt: number,
  nextStartAt: number,
): boolean {
  return (
    page.isLast === true ||
    page.comments.length === 0 ||
    page.comments.length < (page.maxResults ?? JIRA_COMMENTS_PAGE_SIZE) ||
    nextStartAt <= currentStartAt ||
    (page.total !== undefined && nextStartAt >= page.total)
  );
}

function mapIssueSummary(issue: z.infer<typeof JiraIssueSummarySchema>): JiraIssueSummary {
  return {
    assigneeDisplayName: issue.fields.assignee?.displayName ?? null,
    issueType: issue.fields.issuetype.name,
    key: issue.key,
    priority: issue.fields.priority?.name ?? null,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory.name,
    summary: issue.fields.summary,
    updated: issue.fields.updated,
  };
}

function mapComments(
  commentField: z.infer<typeof JiraIssueDetailResponseSchema>["fields"]["comment"],
): MappedComments {
  const comments = Array.isArray(commentField) ? commentField : commentField?.comments ?? [];
  return mapCommentList(comments);
}

function mapCommentList(
  comments: readonly z.infer<typeof CommentSchema>[],
): MappedComments {
  const imageReferences: JiraIssueImageReference[] = [];
  return {
    comments: comments.map((comment, index) => {
      const id = normalizeId(comment.id, index, "comment");
      imageReferences.push(...collectAdfMediaReferences(comment.body, "comment", id));
      return {
        authorDisplayName: comment.author?.displayName ?? "Unknown author",
        bodyText: extractTextFromAdf(comment.body),
        created: comment.created ?? "",
        id,
      };
    }),
    imageReferences,
  };
}

function mapAttachments(
  attachments: readonly z.infer<typeof AttachmentSchema>[],
): JiraIssueAttachment[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    id: String(attachment.id),
    mimeType: attachment.mimeType,
    size: attachment.size ?? 0,
  }));
}

function mapCloneIssueLinks(
  issueLinks: readonly z.infer<typeof IssueLinkSchema>[],
): readonly { readonly key: string; readonly relationship: string; readonly status: string | null }[] {
  return issueLinks.flatMap((issueLink) => {
    const cloneIssue = mapCloneIssueLink(issueLink);
    return cloneIssue === null ? [] : [cloneIssue];
  });
}

function mapCloneIssueLink(
  issueLink: z.infer<typeof IssueLinkSchema>,
): { readonly key: string; readonly relationship: string; readonly status: string | null } | null {
  if (isCloneLinkType(issueLink.type) && issueLink.outwardIssue !== undefined) {
    const relationship = issueLink.type?.outward ?? "clones";
    return isClonesRelationship(relationship)
      ? mapLinkedIssue(issueLink.outwardIssue, relationship)
      : null;
  }

  if (isCloneLinkType(issueLink.type) && issueLink.inwardIssue !== undefined) {
    const relationship = issueLink.type?.inward ?? "is cloned by";
    return isClonesRelationship(relationship)
      ? mapLinkedIssue(issueLink.inwardIssue, relationship)
      : null;
  }

  return null;
}

function mapLinkedIssue(
  issue: z.infer<typeof LinkedIssueSchema>,
  relationship: string,
): { readonly key: string; readonly relationship: string; readonly status: string | null } {
  return {
    key: issue.key,
    relationship,
    status: issue.fields?.status?.name ?? null,
  };
}

function isCloneLinkType(type: z.infer<typeof IssueLinkSchema>["type"]): boolean {
  return [type?.name, type?.inward, type?.outward].some((label) => {
    return typeof label === "string" && label.toLowerCase().includes("clone");
  });
}

function isClonesRelationship(relationship: string): boolean {
  return relationship.trim().toLowerCase() === "clones";
}

function normalizeId(value: string | number | undefined, index: number, prefix: string): string {
  return value === undefined ? `${prefix}-${index.toString()}` : String(value);
}

function collectAdfText(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const current = typeof value["text"] === "string" ? [value["text"]] : [];
  const content = value["content"];
  return Array.isArray(content)
    ? [...current, ...content.flatMap((child: unknown) => collectAdfText(child))]
    : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertOk(response: Response, message: string): void {
  if (response.ok) {
    return;
  }

  throw new Error(message);
}

function readJiraHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function jsonJiraHeaders(accessToken: string): Record<string, string> {
  return {
    ...readJiraHeaders(accessToken),
    "Content-Type": "application/json",
  };
}

function buildWorklogRequestBody(
  options: AddJiraIssueWorklogOptions,
): Record<string, unknown> {
  const comment = options.comment?.trim() ?? "";
  return comment.length > 0
    ? {
        comment: textToAdfDocument(comment),
        started: options.started ?? formatJiraDate(new Date()),
        timeSpentSeconds: options.minutes * 60,
      }
    : {
        started: options.started ?? formatJiraDate(new Date()),
        timeSpentSeconds: options.minutes * 60,
      };
}
