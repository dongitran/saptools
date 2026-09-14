import type { Command } from "commander";

import { uploadJiraIssueAttachments } from "./attachment-upload.js";
import { toIssueRequestOptions, writeOutputWithOptionalHint } from "./cli-shared.js";
import { addJiraIssueComment, updateJiraIssueDescription } from "./client.js";
import { formatJiraAttachmentEmbed, formatJiraAttachmentsUploaded } from "./format.js";
import { buildInlineMediaAdfNode, resolveJiraAttachmentMediaId } from "./media-embed.js";
import type { JiraInlineMediaEmbedTarget, JiraIssueAttachment, JiraRequestOptions } from "./types.js";

interface AttachFlags {
  readonly embed?: string;
  readonly json?: boolean;
}

interface EmbedOutcome {
  readonly commentId?: string;
  readonly resolved: boolean;
  readonly target: JiraInlineMediaEmbedTarget;
  readonly warning?: string;
}

interface AttachCliResult {
  readonly attachments: readonly JiraIssueAttachment[];
  readonly embed?: EmbedOutcome;
  readonly issueKey: string;
}

export function addAttachCommand(program: Command): void {
  program
    .command("attach")
    .description("Upload one or more local files as Jira issue attachments")
    .argument("<key>", "Jira issue key")
    .argument("<files...>", "Local file paths to upload")
    .option(
      "--embed <comment|description>",
      "Best-effort: also try to render the uploaded image inline in a new comment or the description. Undocumented Jira behavior, not guaranteed to work or to keep working.",
    )
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, files: string[], flags: AttachFlags): Promise<void> => {
      const embedTarget = parseEmbedTarget(flags.embed, files.length);
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const attachments = await uploadJiraIssueAttachments({ ...requestOptions, filePaths: files });
      const embed = embedTarget === null
        ? null
        : await tryEmbedUploadedAttachment(requestOptions, attachments, embedTarget);
      const result = toAttachResult(issueKey, attachments, embed);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatAttachHumanOutput(issueKey, attachments, embed),
        flags.json === true,
      );
    });
}

function parseEmbedTarget(raw: string | undefined, fileCount: number): JiraInlineMediaEmbedTarget | null {
  if (raw === undefined) {
    return null;
  }
  if (raw !== "comment" && raw !== "description") {
    throw new Error("--embed <comment|description> must be comment or description");
  }
  if (fileCount !== 1) {
    throw new Error("--embed requires exactly one file: embed images one at a time.");
  }
  return raw;
}

async function tryEmbedUploadedAttachment(
  requestOptions: JiraRequestOptions & { readonly issueKey: string },
  attachments: readonly JiraIssueAttachment[],
  target: JiraInlineMediaEmbedTarget,
): Promise<EmbedOutcome> {
  const attachment = attachments[0];
  if (attachment === undefined) {
    return { resolved: false, target, warning: "No attachment was uploaded." };
  }

  const resolution = await resolveJiraAttachmentMediaId({ ...requestOptions, attachmentId: attachment.id });
  if (resolution.mediaId === null) {
    return { resolved: false, target, warning: resolution.reason };
  }

  const adf = buildInlineMediaAdfNode(resolution.mediaId, { alt: attachment.filename });
  if (target === "comment") {
    const comment = await addJiraIssueComment({ ...requestOptions, body: adf });
    return { commentId: comment.id, resolved: true, target };
  }

  await updateJiraIssueDescription({ ...requestOptions, description: adf, inputKind: "adf", mode: "append" });
  return { resolved: true, target };
}

function toAttachResult(
  issueKey: string,
  attachments: readonly JiraIssueAttachment[],
  embed: EmbedOutcome | null,
): AttachCliResult {
  return { attachments, issueKey, ...(embed === null ? {} : { embed }) };
}

function formatAttachHumanOutput(
  issueKey: string,
  attachments: readonly JiraIssueAttachment[],
  embed: EmbedOutcome | null,
): string {
  const lines = [formatJiraAttachmentsUploaded(issueKey, attachments)];
  if (embed !== null) {
    lines.push(formatJiraAttachmentEmbed(embed));
  }
  return lines.join("\n");
}
