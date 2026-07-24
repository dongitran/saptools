import {
  createJiraIssueAttachmentOutputDir,
  saveJiraIssueAttachmentFile,
} from "./attachment-files.js";
import type {
  FetchJiraIssueDetailOptions,
  JiraIssueAttachment,
  JiraIssueDetail,
  JiraIssueImageFile,
} from "./types.js";

export const DEFAULT_JIRA_ISSUE_ATTACHMENT_LIMIT = 20;

export async function hydrateIssueAttachments(
  detail: JiraIssueDetail,
  options: FetchJiraIssueDetailOptions,
): Promise<JiraIssueDetail> {
  if (detail.attachments.length === 0) {
    return detail;
  }

  const outputDir = options.attachmentOutputDir
    ?? createJiraIssueAttachmentOutputDir(options.issueKey);
  const maxAttachments = Math.max(
    0,
    options.maxAttachments ?? DEFAULT_JIRA_ISSUE_ATTACHMENT_LIMIT,
  );
  const attachments: JiraIssueAttachment[] = [];
  for (const [index, attachment] of detail.attachments.entries()) {
    attachments.push(index >= maxAttachments
      ? withAttachmentLimitError(attachment, maxAttachments)
      : await hydrateOneAttachment(attachment, detail.images, options, outputDir));
  }
  return { ...detail, attachments };
}

async function hydrateOneAttachment(
  attachment: JiraIssueAttachment,
  images: readonly JiraIssueImageFile[],
  options: FetchJiraIssueDetailOptions,
  outputDir: string,
): Promise<JiraIssueAttachment> {
  const savedImage = images.find((image) => image.attachmentId === attachment.id);
  if (savedImage !== undefined) {
    return {
      ...attachment,
      fileUrl: savedImage.fileUrl,
      localPath: savedImage.filePath,
    };
  }

  const saved = await saveJiraIssueAttachmentFile({
    accessToken: options.accessToken,
    attachment,
    cloudId: options.cloudId,
    issueKey: options.issueKey,
    outputDir,
    ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.maxAttachmentBytes === undefined
      ? {}
      : { maxBytes: options.maxAttachmentBytes }),
  });
  return saved.localPath === null
    ? { ...attachment, downloadError: saved.error }
    : { ...attachment, fileUrl: saved.fileUrl, localPath: saved.localPath };
}

function withAttachmentLimitError(
  attachment: JiraIssueAttachment,
  limit: number,
): JiraIssueAttachment {
  return {
    ...attachment,
    downloadError: `Attachment was not downloaded because the ${limit.toString()} attachment limit was reached.`,
  };
}
