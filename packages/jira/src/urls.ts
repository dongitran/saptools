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

export function buildJiraIssueTransitionsUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/transitions`;
}

export function buildJiraIssueWorklogUrl(
  cloudId: string,
  issueKey: string,
  apiRoot = DEFAULT_JIRA_API_ROOT,
): string {
  return `${buildJiraIssueUrl(cloudId, issueKey, apiRoot)}/worklog`;
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
