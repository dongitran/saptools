import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_JIRA_ISSUE_ATTACHMENT_LIMIT,
  hydrateIssueAttachments,
} from "../../src/issue-attachments.js";
import type { JiraIssueAttachment, JiraIssueDetail } from "../../src/types.js";

const fileBytes = new TextEncoder().encode("attachment body");
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
  }));
  tempDirs.length = 0;
});

describe("Jira issue attachment hydration", () => {
  it("reuses saved inline images and fetches each remaining physical attachment once", async () => {
    const outputDir = await createTempDir();
    const imagePath = join(outputDir, "inline.png");
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) => {
      return await Promise.resolve(new Response(fileBytes));
    });
    const detail = issueDetail([
      attachment("10001", "inline.png", "image/png"),
      attachment("20001", "values.xml", "application/xml"),
    ], [{
      attachmentId: "10001",
      byteLength: 8,
      filePath: imagePath,
      fileUrl: "file:///saved/inline.png",
      filename: "inline.png",
      mimeType: "image/png",
      source: "description",
    }]);

    const hydrated = await hydrateIssueAttachments(detail, {
      accessToken: "secret-access-token",
      attachmentOutputDir: outputDir,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxAttachmentBytes: 100,
    });

    expect(hydrated.attachments).toEqual([
      expect.objectContaining({
        fileUrl: "file:///saved/inline.png",
        id: "10001",
        localPath: imagePath,
      }),
      expect.objectContaining({
        fileUrl: expect.stringMatching(/^file:\/\//u),
        id: "20001",
        localPath: expect.stringContaining("20001-values.xml"),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toContain("/attachment/content/20001");
    await expect(readFile(hydrated.attachments[1]?.localPath ?? "")).resolves.toEqual(
      Buffer.from(fileBytes),
    );
  });

  it("applies the attachment count cap without failing the issue read", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response(fileBytes)));
    const detail = issueDetail([
      attachment("1", "one.xml"),
      attachment("2", "two.xml"),
      attachment("3", "three.xml"),
    ]);

    const hydrated = await hydrateIssueAttachments(detail, {
      accessToken: "secret-access-token",
      attachmentOutputDir: outputDir,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxAttachments: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hydrated.attachments[0]).toHaveProperty("localPath");
    expect(hydrated.attachments[1]?.downloadError).toContain("1 attachment limit");
    expect(hydrated.attachments[2]?.downloadError).toContain("1 attachment limit");
    expect(DEFAULT_JIRA_ISSUE_ATTACHMENT_LIMIT).toBe(20);
  });

  it("continues after HTTP, empty-body, and oversized attachment failures", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = requestUrl(input);
      if (url.endsWith("/1")) {
        return await Promise.resolve(new Response("private failure", { status: 500 }));
      }
      if (url.endsWith("/2")) {
        return await Promise.resolve(new Response(null, { status: 200 }));
      }
      return await Promise.resolve(new Response(fileBytes, { status: 200 }));
    });
    const detail = issueDetail([
      attachment("1", "failed.xml", "application/xml", 0),
      attachment("2", "empty.xml", "application/xml", 0),
      attachment("3", "large.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 101),
      attachment("4", "success.xml", "application/xml", 0),
    ]);

    const hydrated = await hydrateIssueAttachments(detail, {
      accessToken: "secret-access-token",
      attachmentOutputDir: outputDir,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxAttachmentBytes: 100,
    });

    expect(hydrated.attachments[0]?.downloadError).toContain("HTTP 500");
    expect(hydrated.attachments[1]?.downloadError).toContain("empty body");
    expect(hydrated.attachments[2]?.downloadError).toContain("100 byte");
    expect(hydrated.attachments[3]).toHaveProperty("localPath");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns issue details unchanged when no attachments exist", async () => {
    const detail = issueDetail([]);
    await expect(hydrateIssueAttachments(detail, {
      accessToken: "secret-access-token",
      cloudId: "cloud-1",
      issueKey: "OPS-123",
    })).resolves.toBe(detail);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saptools-jira-issue-attachments-test-"));
  tempDirs.push(dir);
  return dir;
}

function attachment(
  id: string,
  filename: string,
  mimeType = "application/xml",
  size = fileBytes.byteLength,
): JiraIssueAttachment {
  return { filename, id, mimeType, size };
}

function issueDetail(
  attachments: readonly JiraIssueAttachment[],
  images: JiraIssueDetail["images"] = [],
): JiraIssueDetail {
  return {
    assigneeDisplayName: null,
    attachments,
    comments: [],
    descriptionAdf: null,
    descriptionText: "",
    images,
    issueType: "Task",
    key: "OPS-123",
    linkedCloneIssues: [],
    priority: null,
    status: "Open",
    statusCategory: "To Do",
    summary: "Attachment test",
    updated: "2026-07-24T00:00:00.000+0000",
  };
}

function requestUrl(input: FetchInput | undefined): string {
  if (input === undefined) {
    return "";
  }
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
