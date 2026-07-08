import { describe, expect, it } from "vitest";

import {
  formatConnectionStatus,
  formatIssueDetail,
  formatIssueLinks,
  formatIssueTransitions,
  formatIssues,
  formatJiraIssueCommentAdded,
  formatJiraIssueDescriptionUpdated,
  formatJiraIssueSummaryUpdated,
  formatCustomFieldRows,
  formatCustomFieldDiscovery,
  formatPinnedCustomFields,
  formatPinnedCustomFieldHint,
} from "../../src/format.js";
import type {
  JiraConnectionStatus,
  JiraIssueDetail,
  JiraIssueRemoteLink,
  JiraIssueSummary,
  JiraIssueTransition,
} from "../../src/types.js";

describe("CLI text formatters", () => {
  it("formats connection status without token values", () => {
    const status: JiraConnectionStatus = {
      connected: true,
      cloudId: "cloud-1",
      cloudName: "Example Jira",
      usable: true,
    };

    expect(formatConnectionStatus(status)).toBe("Connected to Example Jira (cloud-1)");
    expect(formatConnectionStatus({ ...status, usable: false })).toBe(
      "Connected to Example Jira (cloud-1) (refresh required)",
    );
    expect(
      formatConnectionStatus({
        connected: false,
        cloudId: null,
        cloudName: null,
        usable: false,
      }),
    ).toBe("Not connected to Jira.");
  });

  it("formats issue lists for terminal use", () => {
    const issues: readonly JiraIssueSummary[] = [
      {
        assigneeDisplayName: "Current User",
        issueType: "Bug",
        key: "OPS-123",
        priority: "High",
        status: "In Progress",
        statusCategory: "In Progress",
        summary: "Stabilize deployment",
        updated: "2026-05-01T08:20:00.000+0000",
      },
    ];

    expect(formatIssues(issues)).toContain("OPS-123");
    expect(formatIssues([])).toBe("No Jira issues found.");
  });

  it("formats detail, links, and transitions", () => {
    const detail: JiraIssueDetail = {
      assigneeDisplayName: null,
      attachments: [],
      comments: [],
      descriptionAdf: null,
      descriptionText: "Deploy safely",
      images: [],
      issueType: "Task",
      key: "OPS-123",
      linkedCloneIssues: [],
      priority: null,
      status: "In Progress",
      statusCategory: "In Progress",
      summary: "Stabilize deployment",
      updated: "2026-05-01T08:20:00.000+0000",
    };
    const links: readonly JiraIssueRemoteLink[] = [
      { id: "1", relationship: "Runbook", title: "Docs", url: "https://docs.example.com" },
    ];
    const transitions: readonly JiraIssueTransition[] = [
      { id: "31", name: "Start Review", toStatus: "Review" },
    ];

    expect(formatIssueDetail(detail)).toContain("Deploy safely");
    expect(formatIssueLinks(links)).toContain("https://docs.example.com");
    expect(formatIssueTransitions(transitions)).toContain("31");
    expect(formatIssueLinks([])).toBe("No Jira remote links found.");
    expect(formatIssueTransitions([])).toBe("No Jira transitions found.");
    expect(formatIssueDetail({ ...detail, descriptionText: "" })).toContain("(no description)");
  });

  it("formats saved issue image file links", () => {
    const detail: JiraIssueDetail = {
      assigneeDisplayName: null,
      attachments: [],
      comments: [],
      descriptionAdf: null,
      descriptionText: "See attached screenshot.",
      images: [
        {
          attachmentId: "10001",
          byteLength: 8,
          filePath: "/tmp/saptools-jira/OPS-123/screenshot.png",
          fileUrl: "file:///tmp/saptools-jira/OPS-123/screenshot.png",
          filename: "screenshot.png",
          mimeType: "image/png",
          source: "description",
        },
      ],
      issueType: "Task",
      key: "OPS-123",
      linkedCloneIssues: [],
      priority: null,
      status: "In Progress",
      statusCategory: "In Progress",
      summary: "Stabilize deployment",
      updated: "2026-05-01T08:20:00.000+0000",
    };

    expect(formatIssueDetail(detail)).toContain(
      "Images:\nscreenshot.png: file:///tmp/saptools-jira/OPS-123/screenshot.png",
    );
  });

  it("formats issue content write confirmations", () => {
    expect(formatJiraIssueDescriptionUpdated("OPS-123")).toBe("Description updated on OPS-123.");
    expect(formatJiraIssueSummaryUpdated("OPS-123")).toBe("Summary updated on OPS-123.");
    expect(formatJiraIssueCommentAdded("OPS-123")).toBe("Comment added to OPS-123.");
  });
});

  it("formats custom field discovery, pinned fields, and hints", () => {
    const field = { id: "customfield_10101", key: "customfield_10101", name: "Custom text A", custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ["Custom text A"], schema: { type: "string", items: null, custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 } };
    const config = { version: 1 as const, cloudId: "cloud-1", cloudName: "Example", updatedAt: "2026-07-02T00:00:00.000Z", fields: [{ id: field.id, name: field.name, schema: field.schema }] };
    const snapshot = { version: 1 as const, cloudId: "cloud-1", cloudName: "Example", discoveredAt: "2026-07-02T00:00:00.000Z", fetched: 1, totalFromApi: 1, fields: [field] };
    expect(formatCustomFieldRows([field])).toContain("textarea");
    expect(formatCustomFieldRows([])).toBe("No matching Jira custom fields found.");
    expect(formatCustomFieldDiscovery(snapshot, [])).toContain("Matches: 0");
    expect(formatPinnedCustomFields(config)).toBe("Custom text A");
    expect(formatPinnedCustomFields(null)).toBe("No pinned Jira custom fields.");
    expect(formatPinnedCustomFieldHint(config)).toContain("Custom text A");
    expect(formatPinnedCustomFieldHint(null)).toBe("");
  });
