import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadJiraIssueAttachments } from "../../src/attachment-upload.js";

const authorization = "Bearer secret-access-token";
const baseUrl = "https://jira-api.example.com/ex/jira/cloud-1";
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
  }));
  tempDirs.length = 0;
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saptools-jira-attachment-upload-test-"));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("Jira attachment upload", () => {
  it("uploads a single file with the correct URL, headers, and multipart body", async () => {
    const filePath = await tempFile("note.txt", "hello attachment");
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) => await Promise.resolve(jsonResponse([
      { id: 20001, filename: "note.txt", mimeType: "text/plain", size: 17 },
    ])));

    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [filePath],
      issueKey: "OPS-123",
    })).resolves.toEqual([{ filename: "note.txt", id: "20001", mimeType: "text/plain", size: 17 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [FetchInput, RequestInit];
    expect(url).toBe(`${baseUrl}/rest/api/3/issue/OPS-123/attachments`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: authorization,
      "X-Atlassian-Token": "no-check",
    });

    const form = init.body;
    if (!(form instanceof FormData)) {
      throw new Error("Expected a FormData body");
    }
    const parts = form.getAll("file");
    expect(parts).toHaveLength(1);
    const uploaded = parts[0];
    if (!(uploaded instanceof File)) {
      throw new Error("Expected a File part");
    }
    expect(uploaded.name).toBe("note.txt");
    await expect(uploaded.text()).resolves.toBe("hello attachment");
  });

  it("uploads multiple files as separate parts of a single request", async () => {
    const first = await tempFile("a.txt", "AAA");
    const second = await tempFile("b.txt", "BBBB");
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) => await Promise.resolve(jsonResponse([
      { id: 1, filename: "a.txt", mimeType: "text/plain", size: 3 },
      { id: 2, filename: "b.txt", mimeType: "text/plain", size: 4 },
    ])));

    const result = await uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [first, second],
      issueKey: "OPS-123",
    });

    expect(result).toEqual([
      { filename: "a.txt", id: "1", mimeType: "text/plain", size: 3 },
      { filename: "b.txt", id: "2", mimeType: "text/plain", size: 4 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [FetchInput, RequestInit];
    const form = init.body as FormData;
    expect(form.getAll("file")).toHaveLength(2);
  });

  it("rejects with no fetch call when no file paths are given", async () => {
    const fetchMock = vi.fn();
    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [],
      issueKey: "OPS-123",
    })).rejects.toThrow("At least one file path is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing file before calling Jira", async () => {
    const fetchMock = vi.fn();
    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: ["/nonexistent/path/does-not-exist.txt"],
      issueKey: "OPS-123",
    })).rejects.toThrow("Attachment file not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a file over the configured byte limit before calling Jira", async () => {
    const filePath = await tempFile("big.txt", "0123456789");
    const fetchMock = vi.fn();
    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [filePath],
      issueKey: "OPS-123",
      maxBytesPerFile: 5,
    })).rejects.toThrow("exceeds the 5 byte upload limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an HTTP failure without leaking the response body", async () => {
    const filePath = await tempFile("note.txt", "hello");
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response("private detail", { status: 413 })));

    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [filePath],
      issueKey: "OPS-123",
    })).rejects.toThrow(`Attachment upload to OPS-123 failed. (HTTP 413`);
  });

  it("rejects a malformed upload response", async () => {
    const filePath = await tempFile("note.txt", "hello");
    const fetchMock = vi.fn(async () => await Promise.resolve(jsonResponse({ not: "an array" })));

    await expect(uploadJiraIssueAttachments({
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      filePaths: [filePath],
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira attachment upload response was not valid.");
  });
});
