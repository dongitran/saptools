import type { CommitPortResult, ConflictReport } from "./types.js";

export interface DraftDescriptionInput {
  readonly sourceRepo: string;
  readonly destRepo: string;
  readonly sourceMergeRequestIid: number;
  readonly sourceMergeRequestTitle: string;
  readonly baseBranch: string;
  readonly portBranch: string;
  readonly runId: string;
  readonly commits: readonly CommitPortResult[];
  readonly conflicts: readonly ConflictReport[];
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function fence(value: string): string {
  return value.split("```").join("` ` `");
}

function renderCommitRows(commits: readonly CommitPortResult[]): string {
  if (commits.length === 0) {
    return "- No commits were ported.";
  }
  return commits
    .map((commit) => `- \`${shortSha(commit.sha)}\` ${commit.status}: ${commit.title}`)
    .join("\n");
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
  return [
    "## Draft MR created by Gitport",
    "",
    `- Source MR: !${input.sourceMergeRequestIid.toString()} ${input.sourceMergeRequestTitle}`,
    `- Source repo: \`${input.sourceRepo}\``,
    `- Destination repo: \`${input.destRepo}\``,
    `- Base branch: \`${input.baseBranch}\``,
    `- Port branch: \`${input.portBranch}\``,
    `- Run ID: \`${input.runId}\``,
    "- Strategy: sequential `git cherry-pick -x`; conflicts choose incoming after capture.",
    "",
    "## Ported commits",
    "",
    renderCommitRows(input.commits),
    "",
    "## Auto-resolved conflicts",
    "",
    renderConflicts(input.conflicts),
    "",
    "Review this Draft MR before marking it ready.",
  ].join("\n");
}

export function buildReportMarkdown(input: DraftDescriptionInput): string {
  return buildDraftMergeRequestDescription(input);
}
