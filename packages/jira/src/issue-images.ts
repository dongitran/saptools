import {
  createJiraIssueImageOutputDir,
  isLikelyJiraImageAttachment,
  saveJiraIssueImageFile,
} from "./image-files.js";
import type {
  FetchJiraIssueDetailOptions,
  JiraIssueAttachment,
  JiraIssueComment,
  JiraIssueDetail,
  JiraIssueImageFile,
  JiraIssueImageSource,
} from "./types.js";

const DEFAULT_JIRA_ISSUE_IMAGE_LIMIT = 20;
const IMAGE_TAG_PATTERN = /<img\b[^>]*>/giu;
const DATA_ATTACHMENT_ID_PATTERN =
  /\bdata-(?:attachment-id|linked-resource-id)=["']?(\d+)/iu;
const ATTACHMENT_URL_ID_PATTERN =
  /\/(?:rest\/api\/[23]\/attachment\/(?:content|thumbnail)|secure\/(?:attachment|thumbnail))\/(\d+)(?=[/?#"' >]|$)/iu;

export interface JiraIssueImageReference {
  readonly attachmentIdHint: string | null;
  readonly commentId?: string;
  readonly filename: string;
  readonly mediaId: string;
  readonly source: JiraIssueImageSource;
}

interface JiraIssueImageTask {
  readonly attachment: JiraIssueAttachment;
  readonly reference: JiraIssueImageReference;
}

export async function hydrateIssueImages(
  detail: JiraIssueDetail,
  references: readonly JiraIssueImageReference[],
  options: FetchJiraIssueDetailOptions,
): Promise<JiraIssueDetail> {
  const tasks = selectIssueImageTasks(detail, references);
  if (tasks.length === 0) {
    return detail;
  }

  const outputDir = options.imageOutputDir ?? createJiraIssueImageOutputDir(options.issueKey);
  const maxImages = Math.max(0, options.maxImages ?? DEFAULT_JIRA_ISSUE_IMAGE_LIMIT);
  const images: JiraIssueImageFile[] = [];
  for (const task of tasks.slice(0, maxImages)) {
    const image = await saveJiraIssueImageFile({
      accessToken: options.accessToken,
      attachment: task.attachment,
      cloudId: options.cloudId,
      issueKey: options.issueKey,
      outputDir,
      source: task.reference.source,
      ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.maxImageBytes === undefined ? {} : { maxBytes: options.maxImageBytes }),
      ...(task.reference.commentId === undefined ? {} : { commentId: task.reference.commentId }),
    });
    if (image !== null) {
      images.push(image);
    }
  }

  return withIssueImageFiles(detail, images);
}

export function collectDescriptionImageReferences(
  description: unknown,
  renderedDescriptionHtml: string,
): JiraIssueImageReference[] {
  const references = collectAdfMediaReferences(description, "description");
  const attachmentIds = extractRenderedDescriptionImageAttachmentIds(renderedDescriptionHtml);
  if (references.length === 0) {
    return attachmentIds.map((attachmentIdHint) => ({
      attachmentIdHint,
      filename: "",
      mediaId: "",
      source: "description",
    }));
  }

  return references.map((reference, index) => {
    const attachmentIdHint = attachmentIds[index] ?? reference.attachmentIdHint;
    return attachmentIdHint === reference.attachmentIdHint ? reference : { ...reference, attachmentIdHint };
  });
}

export function collectAdfMediaReferences(
  value: unknown,
  source: JiraIssueImageSource,
  commentId?: string,
): JiraIssueImageReference[] {
  if (!isRecord(value)) {
    return [];
  }

  const current = value["type"] === "media" ? [toAdfMediaReference(value, source, commentId)] : [];
  const content = value["content"];
  return Array.isArray(content)
    ? [...current, ...content.flatMap((child: unknown) => collectAdfMediaReferences(child, source, commentId))]
    : current;
}

function selectIssueImageTasks(
  detail: JiraIssueDetail,
  references: readonly JiraIssueImageReference[],
): JiraIssueImageTask[] {
  const attachments = detail.attachments.filter(isLikelyJiraImageAttachment);
  const usedAttachmentIds = new Set<string>();
  const assignments = references.map((reference) =>
    findDirectImageAttachment(reference, attachments, usedAttachmentIds),
  );
  assignRemainingImageAttachments(assignments, attachments, usedAttachmentIds);
  return assignments.flatMap((attachment, index) => {
    const reference = references[index];
    return attachment === null || reference === undefined ? [] : [{ attachment, reference }];
  });
}

function findDirectImageAttachment(
  reference: JiraIssueImageReference,
  attachments: readonly JiraIssueAttachment[],
  usedAttachmentIds: Set<string>,
): JiraIssueAttachment | null {
  return (
    findImageAttachmentById(reference.attachmentIdHint, attachments, usedAttachmentIds) ??
    findImageAttachmentById(reference.mediaId, attachments, usedAttachmentIds) ??
    findImageAttachmentByFilename(reference.filename, attachments, usedAttachmentIds)
  );
}

function findImageAttachmentById(
  id: string | null,
  attachments: readonly JiraIssueAttachment[],
  usedAttachmentIds: Set<string>,
): JiraIssueAttachment | null {
  if (id === null || id.trim().length === 0) {
    return null;
  }

  const attachment = attachments.find((candidate) => candidate.id === id && !usedAttachmentIds.has(candidate.id));
  return markAttachmentUsed(attachment ?? null, usedAttachmentIds);
}

function findImageAttachmentByFilename(
  filename: string,
  attachments: readonly JiraIssueAttachment[],
  usedAttachmentIds: Set<string>,
): JiraIssueAttachment | null {
  const normalizedFilename = normalizeMediaFilename(filename);
  if (normalizedFilename.length === 0) {
    return null;
  }

  const attachment = attachments.find((candidate) => {
    return normalizeMediaFilename(candidate.filename) === normalizedFilename && !usedAttachmentIds.has(candidate.id);
  });
  return markAttachmentUsed(attachment ?? null, usedAttachmentIds);
}

function assignRemainingImageAttachments(
  assignments: (JiraIssueAttachment | null)[],
  attachments: readonly JiraIssueAttachment[],
  usedAttachmentIds: Set<string>,
): void {
  const unresolvedIndexes = assignments.flatMap((assignment, index) => (assignment === null ? [index] : []));
  const unusedAttachments = attachments.filter((attachment) => !usedAttachmentIds.has(attachment.id));
  if (unresolvedIndexes.length !== unusedAttachments.length) {
    return;
  }

  for (const [attachmentIndex, assignmentIndex] of unresolvedIndexes.entries()) {
    const attachment = unusedAttachments[attachmentIndex];
    if (attachment !== undefined) {
      assignments[assignmentIndex] = markAttachmentUsed(attachment, usedAttachmentIds);
    }
  }
}

function markAttachmentUsed(
  attachment: JiraIssueAttachment | null,
  usedAttachmentIds: Set<string>,
): JiraIssueAttachment | null {
  if (attachment !== null) {
    usedAttachmentIds.add(attachment.id);
  }

  return attachment;
}

function withIssueImageFiles(
  detail: JiraIssueDetail,
  images: readonly JiraIssueImageFile[],
): JiraIssueDetail {
  const imagesByAttachmentId = new Map(images.map((image) => [image.attachmentId, image]));
  return {
    ...detail,
    attachments: detail.attachments.map((attachment) =>
      withAttachmentImageFile(attachment, imagesByAttachmentId.get(attachment.id) ?? null),
    ),
    comments: detail.comments.map((comment) => withCommentImageFiles(comment, images)),
    images,
  };
}

function withAttachmentImageFile(
  attachment: JiraIssueAttachment,
  image: JiraIssueImageFile | null,
): JiraIssueAttachment {
  return image === null
    ? attachment
    : {
        ...attachment,
        byteLength: image.byteLength,
        fileUrl: image.fileUrl,
        localPath: image.filePath,
      };
}

function withCommentImageFiles(
  comment: JiraIssueComment,
  images: readonly JiraIssueImageFile[],
): JiraIssueComment {
  const commentImages = images.filter((image) => image.commentId === comment.id);
  return commentImages.length === 0 ? comment : { ...comment, images: commentImages };
}

function toAdfMediaReference(
  node: Record<string, unknown>,
  source: JiraIssueImageSource,
  commentId?: string,
): JiraIssueImageReference {
  const attrs = isRecord(node["attrs"]) ? node["attrs"] : null;
  const reference = {
    attachmentIdHint: null,
    filename: getString(attrs, "alt"),
    mediaId: getString(attrs, "id"),
    source,
  };
  return commentId === undefined ? reference : { ...reference, commentId };
}

function extractRenderedDescriptionImageAttachmentIds(value: string): string[] {
  const attachmentIds: string[] = [];
  for (const match of value.matchAll(IMAGE_TAG_PATTERN)) {
    const attachmentId = extractAttachmentIdFromHtml(match[0]);
    if (attachmentId !== null) {
      attachmentIds.push(attachmentId);
    }
  }
  return attachmentIds;
}

function extractAttachmentIdFromHtml(value: string): string | null {
  const dataMatch = DATA_ATTACHMENT_ID_PATTERN.exec(value);
  if (dataMatch?.[1] !== undefined) {
    return dataMatch[1];
  }

  const urlMatch = ATTACHMENT_URL_ID_PATTERN.exec(value);
  return urlMatch?.[1] ?? null;
}

function normalizeMediaFilename(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(node: Record<string, unknown> | null, key: string): string {
  const value = node?.[key];
  return typeof value === "string" ? value : "";
}
