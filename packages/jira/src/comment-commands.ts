import type { Command } from "commander";

import { readJiraAdfBodyInput } from "./adf.js";
import { toIssueRequestOptions, writeOutputWithOptionalHint } from "./cli-shared.js";
import { addJiraIssueComment } from "./client.js";
import { writeJiraCommentBackup } from "./comment-backup.js";
import {
  formatJiraIssueCommentAdded,
  formatJiraIssueCommentDeleted,
} from "./format.js";
import { deleteJiraIssueComment, fetchJiraIssueComment } from "./issue-comments.js";

interface CommentFlags {
  readonly adfFile?: string;
  readonly json?: boolean;
  readonly text?: string;
  readonly textFile?: string;
}

interface CommentDeleteFlags {
  readonly json?: boolean;
}

export function addCommentCommands(program: Command): void {
  addCommentCommand(program);
  addCommentDeleteCommand(program);
}

function addCommentCommand(program: Command): void {
  program
    .command("comment")
    .description("Add a Jira issue comment from plain text or raw ADF")
    .argument("<key>", "Jira issue key")
    .option("--text <text>", "Plain text comment body")
    .option("--text-file <path>", "Read a plain text comment body from a file")
    .option("--adf-file <path>", "Read a raw ADF JSON comment body from a file")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: CommentFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const bodyInput = await readJiraAdfBodyInput(flags);
      const comment = await addJiraIssueComment({
        ...requestOptions,
        body: bodyInput.document,
      });
      const result = { issueKey, commentId: comment.id };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatJiraIssueCommentAdded(issueKey),
        flags.json === true,
      );
    });
}

function addCommentDeleteCommand(program: Command): void {
  program
    .command("comment-delete")
    .description("Delete one Jira comment after saving a durable local backup")
    .argument("<key>", "Jira issue key")
    .argument("<comment-id>", "Jira comment ID")
    .option("--json", "Print JSON output", false)
    .action(async (
      issueKey: string,
      commentId: string,
      flags: CommentDeleteFlags,
    ): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const commentOptions = { ...requestOptions, commentId };
      const comment = await fetchJiraIssueComment(commentOptions);
      const backupPath = await writeJiraCommentBackup(
        requestOptions.cloudId,
        issueKey,
        comment,
      );
      await deleteJiraIssueComment(commentOptions);
      const result = { backupPath, commentId, deleted: true, issueKey };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true
          ? result
          : formatJiraIssueCommentDeleted(issueKey, commentId, backupPath),
        flags.json === true,
      );
    });
}
