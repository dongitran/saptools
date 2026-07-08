import type { AssignedIssuesSearchBody } from "./types.js";

export const DEFAULT_JIRA_API_ROOT = "https://api.atlassian.com/ex/jira";

const ASSIGNED_ISSUES_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const ASSIGNED_ISSUE_FIELDS = [
  "summary",
  "status",
  "priority",
  "assignee",
  "updated",
  "issuetype",
] as const;
const ISSUE_DETAIL_FIELDS = [
  "summary",
  "status",
  "priority",
  "assignee",
  "updated",
  "issuetype",
  "description",
  "comment",
  "attachment",
  "issuelinks",
] as const;
const DEFAULT_ASSIGNED_ISSUE_LIMIT = 25;

export function buildAssignedIssuesSearchBody(
  maxResults = DEFAULT_ASSIGNED_ISSUE_LIMIT,
): AssignedIssuesSearchBody {
  return {
    fields: [...ASSIGNED_ISSUE_FIELDS],
    jql: ASSIGNED_ISSUES_JQL,
    maxResults,
  };
}

export function buildAssignedIssuesSearchUrl(
  cloudId: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${cloudRoot(apiRoot, cloudId)}/rest/api/3/search/jql`;
}

export function buildJiraIssueDetailUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const fields = encodeURIComponent(ISSUE_DETAIL_FIELDS.join(","));
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}?fields=${fields}&expand=renderedFields`;
}

export function buildJiraIssueRemoteLinksUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/remotelink`;
}

export function buildJiraIssueCommentsUrl(
  cloudId: string,
  issueKey: string,
  startAt: number,
  maxResults: number,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const url = new URL(`${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/comment`);
  url.searchParams.set("startAt", startAt.toString());
  url.searchParams.set("maxResults", maxResults.toString());
  return url.toString();
}

export function buildJiraIssueCommentCreateUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/comment`;
}

export function buildJiraIssueDescriptionUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const url = new URL(buildJiraIssueUrl(cloudId, issueKey, apiRoot));
  url.searchParams.set("fields", "description");
  return url.toString();
}

export function buildJiraIssueUpdateUrl(
  cloudId: string,
  issueKey: string,
  options: { readonly notifyUsers?: boolean },
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const url = new URL(buildJiraIssueUrl(cloudId, issueKey, apiRoot));
  if (options.notifyUsers !== undefined) {
    url.searchParams.set("notifyUsers", String(options.notifyUsers));
  }
  return url.toString();
}

export function buildJiraIssueTransitionsUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
  options: { readonly expandFields?: boolean } = {},
): string {
  const url = new URL(`${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/transitions`);
  if (options.expandFields === true) {
    url.searchParams.set("expand", "transitions.fields");
  }
  return url.toString();
}

export function buildJiraFieldSearchUrl(
  cloudId: string,
  startAt: number,
  maxResults: number,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const url = new URL(`${cloudRoot(apiRoot, cloudId)}/rest/api/3/field/search`);
  url.searchParams.set("type", "custom");
  url.searchParams.set("startAt", startAt.toString());
  url.searchParams.set("maxResults", maxResults.toString());
  return url.toString();
}

export function buildJiraIssueEditMetaUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/editmeta`;
}

export function buildJiraIssueWorklogUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/worklog`;
}

export function buildJiraCurrentUserUrl(
  cloudId: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${cloudRoot(apiRoot, cloudId)}/rest/api/3/myself`;
}

export function buildJiraAssignableUserSearchUrl(
  cloudId: string,
  issueKey: string,
  options: { readonly accountId?: string; readonly query?: string },
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const url = new URL(`${cloudRoot(apiRoot, cloudId)}/rest/api/3/user/assignable/search`);
  url.searchParams.set("issueKey", issueKey);
  if (options.query !== undefined) {
    url.searchParams.set("query", options.query);
  }
  if (options.accountId !== undefined) {
    url.searchParams.set("accountId", options.accountId);
  }
  url.searchParams.set("maxResults", "1000");
  return url.toString();
}

export function buildJiraIssueAssigneeUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/assignee`;
}

export function buildJiraAttachmentContentUrl(
  cloudId: string,
  attachmentId: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const encodedAttachmentId = encodeURIComponent(attachmentId);
  return `${cloudRoot(apiRoot, cloudId)}/rest/api/3/attachment/content/${encodedAttachmentId}`;
}

export function buildJiraAttachmentThumbnailUrl(
  cloudId: string,
  attachmentId: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const encodedAttachmentId = encodeURIComponent(attachmentId);
  return `${cloudRoot(apiRoot, cloudId)}/rest/api/3/attachment/thumbnail/${encodedAttachmentId}`;
}

export function buildJiraIssueUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  const encodedIssueKey = encodeURIComponent(issueKey);
  return `${cloudRoot(apiRoot, cloudId)}/rest/api/3/issue/${encodedIssueKey}`;
}

function cloudRoot(apiRoot: string, cloudId: string): string {
  const encodedCloudId = encodeURIComponent(cloudId);
  return `${trimTrailingSlash(apiRoot)}/${encodedCloudId}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
