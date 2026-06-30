import type {
  JiraConnectionStatus,
  JiraIssueDetail,
  JiraIssueRemoteLink,
  JiraIssueSummary,
  JiraIssueTransition,
} from "./types.js";

export function formatConnectionStatus(status: JiraConnectionStatus): string {
  if (status.connected) {
    const cloudName = status.cloudName ?? "Unknown Jira";
    const cloudId = status.cloudId ?? "unknown-cloud";
    const suffix = status.usable ? "" : " (refresh required)";
    return `Connected to ${cloudName} (${cloudId})${suffix}`;
  }

  return "Not connected to Jira.";
}

export function formatIssues(issues: readonly JiraIssueSummary[]): string {
  return issues.length > 0
    ? issues.map(formatIssueSummaryLine).join("\n")
    : "No Jira issues found.";
}

export function formatIssueDetail(detail: JiraIssueDetail): string {
  const description = detail.descriptionText.length > 0 ? detail.descriptionText : "(no description)";
  return [
    `${detail.key} ${detail.summary}`,
    `Type: ${detail.issueType}`,
    `Status: ${detail.status}`,
    `Priority: ${detail.priority ?? "None"}`,
    `Assignee: ${detail.assigneeDisplayName ?? "Unassigned"}`,
    `Updated: ${detail.updated}`,
    "",
    description,
    "",
    `Comments: ${detail.comments.length.toString()}`,
    `Attachments: ${detail.attachments.length.toString()}`,
    formatIssueImages(detail),
    `Clone links: ${detail.linkedCloneIssues.length.toString()}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function formatIssueLinks(links: readonly JiraIssueRemoteLink[]): string {
  return links.length > 0
    ? links
        .map((link) => `${link.relationship}: ${link.title}\n${link.url}`)
        .join("\n\n")
    : "No Jira remote links found.";
}

export function formatIssueTransitions(
  transitions: readonly JiraIssueTransition[],
): string {
  return transitions.length > 0
    ? transitions
        .map((transition) => `${transition.id}\t${transition.name} -> ${transition.toStatus}`)
        .join("\n")
    : "No Jira transitions found.";
}

function formatIssueSummaryLine(issue: JiraIssueSummary): string {
  const priority = issue.priority ?? "No priority";
  return `${issue.key}\t[${issue.status}]\t${priority}\t${issue.summary}`;
}

function formatIssueImages(detail: JiraIssueDetail): string {
  return detail.images.length === 0
    ? ""
    : `Images:\n${detail.images.map((image) => `${image.filename}: ${image.fileUrl}`).join("\n")}`;
}
