import type { ConflictReport } from "./types.js";

export interface DraftDescriptionInput {
  readonly sourceMergeRequestIid: number;
  readonly sourceMergeRequestTitle: string;
  readonly sourceMergeRequestUrl: string;
  readonly conflicts: readonly ConflictReport[];
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function fence(value: string): string {
  return value.split("```").join("` ` `");
}

function renderConflict(conflict: ConflictReport): string {
  const files = conflict.files
    .map(
      (file) =>
        `#### \`${file.path}\`\n\n` +
        `Destination-side code before incoming resolution:\n\n` +
        `\`\`\`text\n${fence(file.oursExcerpt)}\n\`\`\`\n\n` +
        `Incoming code used by Gitport:\n\n` +
        `\`\`\`text\n${fence(file.theirsExcerpt)}\n\`\`\``,
    )
    .join("\n\n");
  return `### \`${shortSha(conflict.commitSha)}\` ${conflict.commitTitle}\n\n${files}`;
}

function renderConflicts(conflicts: readonly ConflictReport[]): string {
  if (conflicts.length === 0) {
    return "No cherry-pick conflicts were detected.";
  }
  return conflicts.map((conflict) => renderConflict(conflict)).join("\n\n");
}

export function buildDraftMergeRequestDescription(input: DraftDescriptionInput): string {
  const sourceMergeRequestLine =
    `- Source MR: !${input.sourceMergeRequestIid.toString()} ${input.sourceMergeRequestTitle} ` +
    `([MR Link](${input.sourceMergeRequestUrl}))`;
  return [
    sourceMergeRequestLine,
    "",
    "## Auto-resolved conflicts",
    "",
    renderConflicts(input.conflicts),
  ].join("\n");
}

export function buildReportMarkdown(input: DraftDescriptionInput): string {
  return buildDraftMergeRequestDescription(input);
}
