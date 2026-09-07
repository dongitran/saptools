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

/**
 * REST root for the Atlassian API gateway, used by OAuth tokens and by scoped API tokens.
 * Classic API tokens address their site directly and never go through this composition.
 */
export function buildJiraCloudBaseUrl(cloudId: string, apiRoot = DEFAULT_JIRA_API_ROOT): string {
  return `${trimTrailingSlash(apiRoot)}/${encodeURIComponent(cloudId)}`;
}

/**
 * Strips every trailing slash, so a pasted `https://site//` cannot produce `//rest/api/3`.
 *
 * Scans backwards rather than matching `/\/+$/`: that pattern restarts at each slash on a string
 * that does not end in one, which is quadratic and reads as a ReDoS risk to scanners.
 */
export function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

export function buildAssignedIssuesSearchBody(
  maxResults = DEFAULT_ASSIGNED_ISSUE_LIMIT,
): AssignedIssuesSearchBody {
  return {
    fields: [...ASSIGNED_ISSUE_FIELDS],
    jql: ASSIGNED_ISSUES_JQL,
    maxResults,
  };
}

export function buildAssignedIssuesSearchUrl(baseUrl: string): string {
  return `${apiRoot3(baseUrl)}/search/jql`;
}

export function buildJiraIssueDetailUrl(baseUrl: string, issueKey: string): string {
  const fields = encodeURIComponent(ISSUE_DETAIL_FIELDS.join(","));
  return `${buildJiraIssueUrl(baseUrl, issueKey)}?fields=${fields}&expand=renderedFields`;
}

export function buildJiraIssueRemoteLinksUrl(baseUrl: string, issueKey: string): string {
  return `${buildJiraIssueUrl(baseUrl, issueKey)}/remotelink`;
}

export function buildJiraIssueCommentsUrl(
  baseUrl: string,
  issueKey: string,
  startAt: number,
  maxResults: number,
): string {
  const url = new URL(`${buildJiraIssueUrl(baseUrl, issueKey)}/comment`);
  url.searchParams.set("startAt", startAt.toString());
  url.searchParams.set("maxResults", maxResults.toString());
  return url.toString();
}

export function buildJiraIssueCommentCreateUrl(baseUrl: string, issueKey: string): string {
  return `${buildJiraIssueUrl(baseUrl, issueKey)}/comment`;
}

export function buildJiraIssueCommentUrl(
  baseUrl: string,
  issueKey: string,
  commentId: string,
): string {
  return `${buildJiraIssueCommentCreateUrl(baseUrl, issueKey)}/${encodeURIComponent(commentId)}`;
}

export function buildJiraIssueDescriptionUrl(baseUrl: string, issueKey: string): string {
  const url = new URL(buildJiraIssueUrl(baseUrl, issueKey));
  url.searchParams.set("fields", "description");
  return url.toString();
}

export function buildJiraIssueUpdateUrl(
  baseUrl: string,
  issueKey: string,
  options: { readonly notifyUsers?: boolean },
): string {
  const url = new URL(buildJiraIssueUrl(baseUrl, issueKey));
  if (options.notifyUsers !== undefined) {
    url.searchParams.set("notifyUsers", String(options.notifyUsers));
  }
  return url.toString();
}

export function buildJiraIssueTransitionsUrl(
  baseUrl: string,
  issueKey: string,
  options: { readonly expandFields?: boolean } = {},
): string {
  const url = new URL(`${buildJiraIssueUrl(baseUrl, issueKey)}/transitions`);
  if (options.expandFields === true) {
    url.searchParams.set("expand", "transitions.fields");
  }
  return url.toString();
}

export function buildJiraFieldSearchUrl(
  baseUrl: string,
  startAt: number,
  maxResults: number,
): string {
  const url = new URL(`${apiRoot3(baseUrl)}/field/search`);
  url.searchParams.set("type", "custom");
  url.searchParams.set("startAt", startAt.toString());
  url.searchParams.set("maxResults", maxResults.toString());
  return url.toString();
}

export function buildJiraIssueEditMetaUrl(baseUrl: string, issueKey: string): string {
  return `${buildJiraIssueUrl(baseUrl, issueKey)}/editmeta`;
}

export function buildJiraIssueWorklogUrl(baseUrl: string, issueKey: string): string {
  return `${buildJiraIssueUrl(baseUrl, issueKey)}/worklog`;
}

export function buildJiraCurrentUserUrl(baseUrl: string): string {
  return `${apiRoot3(baseUrl)}/myself`;
}

export function buildJiraAssignableUserSearchUrl(
  baseUrl: string,
  issueKey: string,
  options: { readonly accountId?: string; readonly query?: string },
): string {
  const url = new URL(`${apiRoot3(baseUrl)}/user/assignable/search`);
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

export function buildJiraIssueAssigneeUrl(baseUrl: string, issueKey: string): string {
  return `${buildJiraIssueUrl(baseUrl, issueKey)}/assignee`;
}

export function buildJiraAttachmentContentUrl(baseUrl: string, attachmentId: string): string {
  return `${apiRoot3(baseUrl)}/attachment/content/${encodeURIComponent(attachmentId)}`;
}

export function buildJiraAttachmentThumbnailUrl(baseUrl: string, attachmentId: string): string {
  return `${apiRoot3(baseUrl)}/attachment/thumbnail/${encodeURIComponent(attachmentId)}`;
}

export function buildJiraIssueUrl(baseUrl: string, issueKey: string): string {
  return `${apiRoot3(baseUrl)}/issue/${encodeURIComponent(issueKey)}`;
}

function apiRoot3(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/rest/api/3`;
}
