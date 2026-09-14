import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";

import { assertJiraResponseOk, uploadJiraHeaders } from "./jira-http.js";
import type { JiraIssueAttachment, UploadJiraIssueAttachmentsOptions } from "./types.js";
import { buildJiraIssueAttachmentsUploadUrl } from "./urls.js";

export const DEFAULT_JIRA_ATTACHMENT_UPLOAD_MAX_BYTES = 10_000_000;

const UploadedAttachmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().nonnegative().optional(),
});

const UploadResponseSchema = z.array(UploadedAttachmentSchema);

export async function uploadJiraIssueAttachments(
  options: UploadJiraIssueAttachmentsOptions,
): Promise<JiraIssueAttachment[]> {
  if (options.filePaths.length === 0) {
    throw new Error("At least one file path is required to upload an attachment.");
  }

  const maxBytes = options.maxBytesPerFile ?? DEFAULT_JIRA_ATTACHMENT_UPLOAD_MAX_BYTES;
  const form = new FormData();
  for (const filePath of options.filePaths) {
    form.append("file", await readAttachmentPart(filePath, maxBytes));
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildJiraIssueAttachmentsUploadUrl(options.baseUrl, options.issueKey),
    { body: form, headers: uploadJiraHeaders(options.authorization), method: "POST" },
  );
  assertJiraResponseOk(response, `Attachment upload to ${options.issueKey} failed.`);
  const parsed = UploadResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Jira attachment upload response was not valid.");
  }
  return parsed.data.map(toJiraIssueAttachment);
}

async function readAttachmentPart(filePath: string, maxBytes: number): Promise<File> {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    throw new Error("Attachment file path must not be empty.");
  }

  const stats = await stat(trimmed).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`Attachment file not found: ${trimmed}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `Attachment file exceeds the ${maxBytes.toString()} byte upload limit: ${trimmed}`,
    );
  }

  const bytes = await readFile(trimmed);
  return new File([bytes], basename(trimmed));
}

function toJiraIssueAttachment(attachment: z.infer<typeof UploadedAttachmentSchema>): JiraIssueAttachment {
  return {
    filename: attachment.filename,
    id: String(attachment.id),
    mimeType: attachment.mimeType,
    size: attachment.size ?? 0,
  };
}
