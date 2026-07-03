import { describe, expect, it } from "vitest";

import {
  DEFAULT_JIRA_API_ROOT,
  buildAssignedIssuesSearchBody,
  buildAssignedIssuesSearchUrl,
  buildJiraAssignableUserSearchUrl,
  buildJiraAttachmentContentUrl,
  buildJiraAttachmentThumbnailUrl,
  buildJiraCurrentUserUrl,
  buildJiraIssueAssigneeUrl,
  buildJiraIssueCommentsUrl,
  buildJiraIssueDetailUrl,
  buildJiraIssueRemoteLinksUrl,
  buildJiraIssueTransitionsUrl,
  buildJiraIssueWorklogUrl,
} from "../../src/urls.js";

describe("Jira URL builders", () => {
  it("builds Atlassian Cloud URLs with encoded path segments", () => {
    expect(DEFAULT_JIRA_API_ROOT).toBe("https://api.atlassian.com/ex/jira");
    expect(buildAssignedIssuesSearchUrl("cloud 1")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/search/jql",
    );
    expect(buildJiraIssueDetailUrl("cloud 1", "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123?fields=summary%2Cstatus%2Cpriority%2Cassignee%2Cupdated%2Cissuetype%2Cdescription%2Ccomment%2Cattachment%2Cissuelinks&expand=renderedFields",
    );
    expect(buildJiraIssueRemoteLinksUrl("cloud 1", "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/remotelink",
    );
    expect(buildJiraIssueCommentsUrl("cloud 1", "OPS/123", 100, 50)).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/comment?startAt=100&maxResults=50",
    );
    expect(buildJiraAttachmentContentUrl("cloud 1", "100/01")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/attachment/content/100%2F01",
    );
    expect(buildJiraAttachmentThumbnailUrl("cloud 1", "100/01")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/attachment/thumbnail/100%2F01",
    );
    expect(buildJiraCurrentUserUrl("cloud 1")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/myself",
    );
    expect(buildJiraIssueAssigneeUrl("cloud 1", "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/assignee",
    );
  });

  it("builds action URLs from a custom API root for deterministic tests", () => {
    const apiRoot = "http://127.0.0.1:30129/ex/jira/";

    expect(buildJiraIssueTransitionsUrl("cloud-1", "OPS-123", apiRoot)).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1/rest/api/3/issue/OPS-123/transitions",
    );
    expect(buildJiraIssueWorklogUrl("cloud-1", "OPS-123", apiRoot)).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1/rest/api/3/issue/OPS-123/worklog",
    );
  });

  it("builds issue-scoped assignable-user searches with encoded query parameters", () => {
    const apiRoot = "http://127.0.0.1:30129/ex/jira/";
    const byQuery = new URL(buildJiraAssignableUserSearchUrl(
      "cloud 1",
      "OPS/&? 123",
      { query: "Zoë User + A&B/?" },
      apiRoot,
    ));
    expect(byQuery.pathname).toBe("/ex/jira/cloud%201/rest/api/3/user/assignable/search");
    expect(byQuery.searchParams.get("issueKey")).toBe("OPS/&? 123");
    expect(byQuery.searchParams.get("query")).toBe("Zoë User + A&B/?");
    expect(byQuery.searchParams.get("maxResults")).toBe("1000");

    const byAccount = new URL(buildJiraAssignableUserSearchUrl(
      "cloud-1",
      "OPS-123",
      { accountId: "acct +/&?" },
      apiRoot,
    ));
    expect(byAccount.searchParams.get("accountId")).toBe("acct +/&?");
    expect(byAccount.searchParams.get("maxResults")).toBe("1000");
  });

  it("builds the assigned issue search body used by JiraOps", () => {
    expect(buildAssignedIssuesSearchBody(10)).toEqual({
      fields: ["summary", "status", "priority", "assignee", "updated", "issuetype"],
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      maxResults: 10,
    });
  });
});
