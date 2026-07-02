import type { CustomFieldSnapshot, NormalizedCustomField, PinnedCustomFieldConfig } from "./custom-fields.js";
import { customFieldTypeSuffix } from "./custom-fields.js";
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


export function formatCustomFieldRows(fields: readonly NormalizedCustomField[]): string {
  return fields.length === 0
    ? "No matching Jira custom fields found."
    : fields.map((field) => `${field.id}	${field.name}	${field.schema.type}	${customFieldTypeSuffix(field)}`).join("\n");
}

export function formatCustomFieldDiscovery(snapshot: CustomFieldSnapshot, displayedFields: readonly NormalizedCustomField[]): string {
  return [
    `Discovered ${snapshot.fetched.toString()} Jira custom fields for ${snapshot.cloudName} (${snapshot.cloudId}).`,
    displayedFields.length === snapshot.fields.length ? "" : `Matches: ${displayedFields.length.toString()}`,
    formatCustomFieldRows(displayedFields),
  ].filter((line) => line.length > 0).join("\n");
}

export function formatPinnedCustomFields(config: PinnedCustomFieldConfig | null): string {
  const fields = config?.fields ?? [];
  return fields.length === 0 ? "No pinned Jira custom fields." : fields.map((field) => field.name).join("\n");
}

export function formatPinnedCustomFieldHint(config: PinnedCustomFieldConfig | null): string {
  const names = (config?.fields ?? []).map((field) => field.name);
  return names.length === 0
    ? ""
    : `Updatable custom fields: ${names.join(", ")}. Use: jira fields update <KEY> --field 'FIELD NAME=value'`;
}
