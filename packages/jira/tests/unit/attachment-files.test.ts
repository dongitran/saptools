import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createJiraIssueAttachmentOutputDir,
  fetchJiraAttachmentContent,
  saveJiraIssueAttachmentFile,
} from "../../src/attachment-files.js";
import type { JiraIssueAttachment } from "../../src/types.js";

const fileBytes = new TextEncoder().encode("<values><value>Example</value></values>");
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
  }));
  tempDirs.length = 0;
});

describe("Jira issue attachment files", () => {
  it("creates a sibling attachment directory under the OS temp folder", () => {
    const directory = createJiraIssueAttachmentOutputDir("OPS/123:bad key");

    expect(directory).toContain(join(tmpdir(), "saptools-jira", "issue-attachments"));
    expect(directory).toContain("OPS_123_bad_key");
  });

  it("downloads and saves non-image attachment content with bounded requests", async () => {
    const outputDir = await createTempDir();
    const fetchMock = vi.fn(async () => await Promise.resolve(
      new Response(fileBytes, {
        headers: { "content-type": "application/xml" },
        status: 200,
      }),
    ));

    const saved = await saveJiraIssueAttachmentFile({
      accessToken: "secret-access-token",
      apiRoot: "https://jira-api.example.com/ex/jira",
      attachment: attachment(),
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      maxBytes: 100,
      outputDir,
    });

    expect(saved).toMatchObject({
      error: null,
      fileUrl: expect.stringMatching(/^file:\/\//u),
      localPath: expect.stringContaining("20001-values.xml"),
    });
    await expect(readFile(saved.localPath ?? "")).resolves.toEqual(Buffer.from(fileBytes));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/attachment/content/20001",
      {
        headers: {
          Accept: "*/*",
          Authorization: "Bearer secret-access-token",
          Range: "bytes=0-100",
        },
        redirect: "manual",
      },
    );
  });

  it("follows cross-host signed redirects without forwarding authorization", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      return requestUrl(input).startsWith("https://jira-api.example.com/")
        ? await Promise.resolve(new Response(null, {
            headers: { location: "https://media.example.net/signed/values.xml" },
            status: 303,
          }))
        : await Promise.resolve(new Response(fileBytes, { status: 200 }));
    });

    await expect(fetchJiraAttachmentContent({
      accessToken: "secret-access-token",
      apiRoot: "https://jira-api.example.com/ex/jira",
      attachment: attachment(),
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      maxBytes: 100,
    })).resolves.toMatchObject({ bytes: fileBytes, error: null });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://media.example.net/signed/values.xml",
      {
        headers: {
          Accept: "*/*",
          Range: "bytes=0-100",
        },
      },
    );
    expect(JSON.stringify(fetchMock.mock.calls[1]?.[1])).not.toContain("Authorization");
    expect(JSON.stringify(fetchMock.mock.calls[1]?.[1])).not.toContain("secret-access-token");
  });

  it("rejects metadata and response bodies over the configured byte limit", async () => {
    const metadataFetch = vi.fn(async () => await Promise.resolve(new Response(fileBytes)));
    await expect(fetchJiraAttachmentContent({
      accessToken: "secret-access-token",
      attachment: attachment({ size: 101 }),
      cloudId: "cloud-1",
      fetchImpl: metadataFetch,
      maxBytes: 100,
    })).resolves.toMatchObject({
      bytes: null,
      error: "Attachment exceeds the 100 byte download limit.",
    });
    expect(metadataFetch).not.toHaveBeenCalled();

    const headerFetch = vi.fn(async () => await Promise.resolve(new Response(fileBytes, {
      headers: { "content-length": "101" },
      status: 200,
    })));
    await expect(fetchJiraAttachmentContent({
      accessToken: "secret-access-token",
      attachment: attachment({ size: 0 }),
      cloudId: "cloud-1",
      fetchImpl: headerFetch,
      maxBytes: 100,
    })).resolves.toMatchObject({
      bytes: null,
      error: "Attachment response exceeded the 100 byte download limit.",
    });

    const streamedFetch = vi.fn(async () => await Promise.resolve(
      new Response(new Uint8Array(101), { status: 200 }),
    ));
    await expect(fetchJiraAttachmentContent({
      accessToken: "secret-access-token",
      attachment: attachment({ size: 0 }),
      cloudId: "cloud-1",
      fetchImpl: streamedFetch,
      maxBytes: 100,
    })).resolves.toMatchObject({
      bytes: null,
      error: "Attachment response exceeded the 100 byte download limit.",
    });
  });

  it("returns neutral per-file errors for HTTP, empty, redirect, and network failures", async () => {
    const cases = [
      {
        expected: "Attachment download returned HTTP 404.",
        fetchImpl: vi.fn(async () => await Promise.resolve(new Response("private body", { status: 404 }))),
      },
      {
        expected: "Attachment download returned an empty body.",
        fetchImpl: vi.fn(async () => await Promise.resolve(new Response(null, { status: 200 }))),
      },
      {
        expected: "Attachment download redirect was not valid.",
        fetchImpl: vi.fn(async () => await Promise.resolve(new Response(null, { status: 303 }))),
      },
      {
        expected: "Attachment download failed.",
        fetchImpl: vi.fn(async () => await Promise.reject(new Error("secret-access-token"))),
      },
    ];

    for (const testCase of cases) {
      await expect(fetchJiraAttachmentContent({
        accessToken: "secret-access-token",
        attachment: attachment({ size: 0 }),
        cloudId: "cloud-1",
        fetchImpl: testCase.fetchImpl,
        maxBytes: 100,
      })).resolves.toEqual({ bytes: null, error: testCase.expected });
    }
  });

  it("reports local write failures without exposing raw filesystem errors", async () => {
    const root = await createTempDir();
    const blockedPath = join(root, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response(fileBytes)));

    await expect(saveJiraIssueAttachmentFile({
      accessToken: "secret-access-token",
      attachment: attachment(),
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      outputDir: join(blockedPath, "nested"),
    })).resolves.toEqual({
      error: "Attachment could not be saved locally.",
      fileUrl: null,
      localPath: null,
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saptools-jira-attachment-files-test-"));
  tempDirs.push(dir);
  return dir;
}

function attachment(overrides: Partial<JiraIssueAttachment> = {}): JiraIssueAttachment {
  return {
    filename: "values.xml",
    id: "20001",
    mimeType: "application/xml",
    size: fileBytes.byteLength,
    ...overrides,
  };
}

function requestUrl(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
