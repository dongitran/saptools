import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createJiraIssueImageOutputDir,
  isLikelyJiraImageAttachment,
  saveJiraIssueImageFile,
} from "../../src/image-files.js";
import type { JiraIssueAttachment } from "../../src/types.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    }),
  );
  tempDirs.length = 0;
});

describe("Jira issue image files", () => {
  it("creates sanitized issue image output directories under the OS temp folder", () => {
    const directory = createJiraIssueImageOutputDir("OPS/123:bad key");

    expect(directory).toContain(join(tmpdir(), "saptools-jira", "issue-images"));
    expect(directory).toContain("OPS_123_bad_key");
  });

  it("sanitizes adversarial issue keys within a bounded time", () => {
    const issueKey = `OPS${"_".repeat(50_000)}123`;
    const startedAt = performance.now();
    const directory = createJiraIssueImageOutputDir(issueKey);

    expect(directory).toContain(issueKey);
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it("saves direct image responses with file URLs", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(
        new Response(pngBytes, {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        }),
      );
    });

    const saved = await saveJiraIssueImageFile({
      accessToken: "secret-access-token",
      apiRoot: "https://jira-api.example.com/ex/jira",
      attachment: attachment({ filename: "preview" }),
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxBytes: 64,
      outputDir,
      source: "description",
    });

    expect(saved).toEqual(
      expect.objectContaining({
        attachmentId: "10001",
        byteLength: pngBytes.byteLength,
        fileUrl: expect.stringMatching(/^file:\/\//u),
        filename: "preview",
        mimeType: "image/png",
      }),
    );
    await expect(readFile(saved?.filePath ?? "")).resolves.toEqual(Buffer.from(pngBytes));
  });

  it("falls back to thumbnail responses when content is not an image", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput) => {
      return requestUrl(input).includes("/content/")
        ? await Promise.resolve(new Response("not image", { status: 200 }))
        : await Promise.resolve(
            new Response(gifBytes, {
              headers: { "Content-Type": "application/octet-stream" },
              status: 200,
            }),
          );
    });

    const saved = await saveJiraIssueImageFile({
      accessToken: "secret-access-token",
      attachment: attachment({ filename: "fallback.gif", mimeType: "text/plain" }),
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxBytes: 64,
      outputDir,
      source: "description",
    });

    expect(saved).toMatchObject({
      filename: "fallback.gif",
      mimeType: "image/gif",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not forward authorization to signed media redirects", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = requestUrl(input);
      if (url.includes("/content/")) {
        return await Promise.resolve(
          new Response(null, {
            headers: { Location: "../signed/media.png" },
            status: 302,
          }),
        );
      }

      return await Promise.resolve(
        new Response(pngBytes, {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      );
    });

    await expect(
      saveJiraIssueImageFile({
        accessToken: "secret-access-token",
        attachment: attachment(),
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
        maxBytes: 64,
        outputDir,
        source: "comment",
      }),
    ).resolves.toMatchObject({ mimeType: "image/png", source: "comment" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/signed/media.png",
      { headers: { Accept: "image/*" } },
    );
  });

  it("returns null for unavailable redirects and oversized image responses", async () => {
    const outputDir = await createTempDir();
    const redirectFetch = vi.fn(async () => {
      return await Promise.resolve(new Response(null, { status: 302 }));
    });
    const oversizedFetch = vi.fn(async () => {
      return await Promise.resolve(
        new Response(pngBytes, {
          headers: {
            "Content-Length": pngBytes.byteLength.toString(),
            "Content-Type": "image/png",
          },
          status: 200,
        }),
      );
    });

    await expect(
      saveJiraIssueImageFile({
        accessToken: "secret-access-token",
        attachment: attachment(),
        cloudId: "cloud-1",
        fetchImpl: redirectFetch,
        issueKey: "OPS-123",
        outputDir,
        source: "description",
      }),
    ).resolves.toBeNull();
    await expect(
      saveJiraIssueImageFile({
        accessToken: "secret-access-token",
        attachment: attachment(),
        cloudId: "cloud-1",
        fetchImpl: oversizedFetch,
        issueKey: "OPS-123",
        maxBytes: 3,
        outputDir,
        source: "description",
      }),
    ).resolves.toBeNull();
  });

  it("handles WebP sniffing and invalid redirect locations safely", async () => {
    const outputDir = await createTempDir();
    const webpFetch = vi.fn(async () => {
      return await Promise.resolve(
        new Response(webpBytes, {
          headers: { "Content-Type": "application/octet-stream" },
          status: 200,
        }),
      );
    });
    const invalidRedirectFetch = vi.fn(async () => {
      return await Promise.resolve(
        new Response(null, {
          headers: { Location: "https://[" },
          status: 302,
        }),
      );
    });

    await expect(
      saveJiraIssueImageFile({
        accessToken: "secret-access-token",
        attachment: attachment({ filename: "preview" }),
        cloudId: "cloud-1",
        fetchImpl: webpFetch,
        issueKey: "OPS-123",
        outputDir,
        source: "description",
      }),
    ).resolves.toMatchObject({ mimeType: "image/webp" });
    await expect(
      saveJiraIssueImageFile({
        accessToken: "secret-access-token",
        attachment: attachment(),
        cloudId: "cloud-1",
        fetchImpl: invalidRedirectFetch,
        issueKey: "OPS-123",
        outputDir,
        source: "description",
      }),
    ).resolves.toBeNull();
  });

  it("detects likely image attachments from MIME type or filename", () => {
    expect(isLikelyJiraImageAttachment(attachment({ mimeType: "image/webp" }))).toBe(true);
    expect(isLikelyJiraImageAttachment(attachment({ filename: "diagram.png", mimeType: "text/plain" }))).toBe(true);
    expect(isLikelyJiraImageAttachment(attachment({ filename: "diagram.jpeg" }))).toBe(true);
    expect(isLikelyJiraImageAttachment(attachment({ filename: "diagram.gif", mimeType: "text/plain" }))).toBe(true);
    expect(isLikelyJiraImageAttachment(attachment({ filename: "notes.txt", mimeType: "text/plain" }))).toBe(
      false,
    );
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saptools-jira-image-files-test-"));
  tempDirs.push(dir);
  return dir;
}

function attachment(overrides: Partial<JiraIssueAttachment> = {}): JiraIssueAttachment {
  return {
    filename: "preview.png",
    id: "10001",
    mimeType: "image/png",
    size: 8,
    ...overrides,
  };
}

function requestUrl(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
