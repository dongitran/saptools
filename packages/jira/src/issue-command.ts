import type { Command } from "commander";

import {
  parseOptionalPositiveInteger,
  toIssueRequestOptions,
  writeOutputWithOptionalHint,
} from "./cli-shared.js";
import { fetchJiraIssueDetail } from "./client.js";
import { formatIssueDetail } from "./format.js";
import type { FetchJiraIssueDetailOptions } from "./types.js";

interface IssueFlags {
  readonly attachmentDir?: string;
  readonly attachments?: boolean;
  readonly imageDir?: string;
  readonly images?: boolean;
  readonly json?: boolean;
  readonly maxAttachmentBytes?: string;
  readonly maxAttachments?: string;
  readonly maxImageBytes?: string;
  readonly maxImages?: string;
}

export function addIssueCommand(program: Command): void {
  program
    .command("issue")
    .description("Show one Jira issue")
    .argument("<key>", "Jira issue key")
    .option("--json", "Print JSON output", false)
    .option("--no-images", "Do not download inline Jira images")
    .option("--image-dir <path>", "Directory for saved inline Jira images")
    .option("--max-image-bytes <number>", "Maximum bytes per saved Jira image")
    .option("--max-images <number>", "Maximum inline Jira images to save")
    .option("--no-attachments", "Do not download Jira issue attachments")
    .option("--attachment-dir <path>", "Directory for saved Jira issue attachments")
    .option("--max-attachment-bytes <number>", "Maximum bytes per saved Jira attachment")
    .option("--max-attachments <number>", "Maximum Jira issue attachments to save")
    .action(async (issueKey: string, flags: IssueFlags): Promise<void> => {
      const requestOptions = await toIssueDetailOptions(program, issueKey, flags);
      const detail = await fetchJiraIssueDetail(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? detail : formatIssueDetail(detail),
        flags.json === true,
      );
    });
}

async function toIssueDetailOptions(
  program: Command,
  issueKey: string,
  flags: IssueFlags,
): Promise<FetchJiraIssueDetailOptions> {
  const requestOptions = await toIssueRequestOptions(program, issueKey);
  const maxAttachmentBytes = parseOptionalPositiveInteger(
    flags.maxAttachmentBytes,
    "--max-attachment-bytes <number>",
  );
  const maxAttachments = parseOptionalPositiveInteger(
    flags.maxAttachments,
    "--max-attachments <number>",
  );
  const maxImageBytes = parseOptionalPositiveInteger(
    flags.maxImageBytes,
    "--max-image-bytes <number>",
  );
  const maxImages = parseOptionalPositiveInteger(flags.maxImages, "--max-images <number>");
  return {
    ...requestOptions,
    downloadAttachments: flags.attachments !== false,
    downloadImages: flags.images !== false,
    ...(flags.attachmentDir === undefined ? {} : { attachmentOutputDir: flags.attachmentDir }),
    ...(flags.imageDir === undefined ? {} : { imageOutputDir: flags.imageDir }),
    ...(maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes }),
    ...(maxAttachments === undefined ? {} : { maxAttachments }),
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
    ...(maxImages === undefined ? {} : { maxImages }),
  };
}
