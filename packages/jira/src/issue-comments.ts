import { z } from "zod";

import { JiraAdfDocumentSchema } from "./adf.js";
import { assertJiraResponseOk, readJiraHeaders } from "./jira-http.js";
import type { JiraIssueCommentDetail, JiraIssueCommentRequestOptions } from "./types.js";
import { buildJiraIssueCommentUrl } from "./urls.js";

const nonEmptyStringSchema = z.string().min(1);

export const JiraIssueCommentDetailSchema = z.object({
  author: z.object({
    displayName: nonEmptyStringSchema,
  }).loose(),
  body: JiraAdfDocumentSchema,
  created: nonEmptyStringSchema,
  id: z.union([nonEmptyStringSchema, z.number()]),
  updated: nonEmptyStringSchema,
}).loose();

export function parseJiraIssueCommentDetail(value: unknown): JiraIssueCommentDetail {
  const parsed = JiraIssueCommentDetailSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Jira issue comment response was not valid.");
  }
  return {
    authorDisplayName: parsed.data.author.displayName,
    body: parsed.data.body,
    created: parsed.data.created,
    id: String(parsed.data.id),
    updated: parsed.data.updated,
  };
}

export async function fetchJiraIssueComment(
  options: JiraIssueCommentRequestOptions,
): Promise<JiraIssueCommentDetail> {
  const response = await (options.fetchImpl ?? fetch)(
    buildJiraIssueCommentUrl(
      options.cloudId,
      options.issueKey,
      options.commentId,
      options.apiRoot,
    ),
    { headers: readJiraHeaders(options.accessToken) },
  );
  assertJiraResponseOk(response, "Jira issue comment could not be loaded.");
  const comment = await parseCommentResponse(response);
  if (comment.id !== options.commentId) {
    throw new Error("Jira issue comment response was not valid.");
  }
  return comment;
}

export async function deleteJiraIssueComment(
  options: JiraIssueCommentRequestOptions,
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(
    buildJiraIssueCommentUrl(
      options.cloudId,
      options.issueKey,
      options.commentId,
      options.apiRoot,
    ),
    {
      headers: readJiraHeaders(options.accessToken),
      method: "DELETE",
    },
  );
  assertJiraResponseOk(response, "Jira issue comment could not be deleted.");
}

async function parseCommentResponse(response: Response): Promise<JiraIssueCommentDetail> {
  try {
    return parseJiraIssueCommentDetail(await response.json());
  } catch {
    throw new Error("Jira issue comment response was not valid.");
  }
}
