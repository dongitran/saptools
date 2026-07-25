import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ATTACHMENT_BYTES = new TextEncoder().encode("<values><value>Example</value></values>");

interface JiraTokensFixture {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
  readonly tokenType: string;
  readonly cloudId: string;
  readonly cloudName: string;
  readonly issuedAt: number;
}

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly backupExistsAtReceipt?: boolean;
  readonly body: string;
  readonly method: string;
  readonly url: string;
}

interface FakeJiraServer {
  readonly apiRoot: string;
  readonly close: () => Promise<void>;
  readonly requests: () => readonly RecordedRequest[];
}

interface CliContext {
  readonly cleanup: () => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly fakeJira: FakeJiraServer;
  readonly home: string;
  readonly run: (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

function createTokens(overrides: Partial<JiraTokensFixture> = {}): JiraTokensFixture {
  return {
    accessToken: "e2e-access-token",
    refreshToken: "e2e-refresh-token",
    expiresIn: 3600,
    scope: "read:jira-work write:jira-work offline_access",
    tokenType: "Bearer",
    cloudId: "cloud-1",
    cloudName: "E2E Jira",
    issuedAt: Date.now(),
    ...overrides,
  };
}

async function prepareCliContext(
  tokenOverrides: Partial<JiraTokensFixture> = {},
): Promise<CliContext> {
  const home = await mkdtemp(join(tmpdir(), "saptools-jira-e2e-"));
  const tokenPath = join(home, ".jira-oauth", "tokens.json");
  const fakeJira = await startFakeJiraServer(home);
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(createTokens(tokenOverrides), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  Reflect.deleteProperty(env, "FORCE_COLOR");
  Reflect.deleteProperty(env, "NO_COLOR");

  return {
    env,
    fakeJira,
    home,
    run: async (args) => {
      const { stderr, stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
        env,
        timeout: 30_000,
      });
      return {
        stderr: normalizeOutput(stderr),
        stdout: normalizeOutput(stdout),
      };
    },
    cleanup: async () => {
      await fakeJira.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function startFakeJiraServer(home: string): Promise<FakeJiraServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void handleFakeJiraRequest(request, response, requests, home);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fake Jira server did not expose a TCP port");
  }

  return {
    apiRoot: `http://127.0.0.1:${address.port.toString()}/ex/jira`,
    close: async () => {
      await closeServer(server);
    },
    requests: () => requests,
  };
}

async function handleFakeJiraRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: RecordedRequest[],
  home: string,
): Promise<void> {
  const body = await readRequestBody(request);
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  const backupExistsAtReceipt = method === "DELETE"
    ? await commentBackupExists(home, url)
    : undefined;
  requests.push({
    authorization: request.headers.authorization,
    ...(backupExistsAtReceipt === undefined ? {} : { backupExistsAtReceipt }),
    body,
    method,
    url,
  });

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/myself") {
    writeJson(response, {
      accountId: "account-me",
      active: true,
      displayName: "Current User",
      emailAddress: "current.user@example.com",
    });
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-no-email/rest/api/3/myself") {
    writeJson(response, { accountId: "account-private", active: true, displayName: "Private User" });
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-malformed/rest/api/3/myself") {
    writeJson(response, { accountId: "account-malformed" });
    return;
  }

  if (method === "GET" && url.startsWith("/ex/jira/cloud-1/rest/api/3/user/assignable/search?")) {
    handleAssignableSearch(url, response);
    return;
  }

  if (method === "PUT" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-ASSIGN/assignee") {
    if (body.includes("permission-denied")) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden sensitive detail");
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/field/search?type=custom&startAt=0&maxResults=50") {
    writeJson(response, {
      startAt: 0, maxResults: 50, total: 2, isLast: true,
      values: [
        { id: "customfield_10101", key: "customfield_10101", name: "Custom text A", custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ["Custom text A"], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 } },
        { id: "customfield_10102", key: "customfield_10102", name: "Custom text B", custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ["Custom text B"], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10102 } },
      ],
    });
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/editmeta") {
    writeJson(response, { fields: {
      description: { name: "Description", required: false, schema: { type: "string" } },
      summary: { name: "Summary", required: true, schema: { type: "string" } },
      customfield_10101: { name: "Custom text A", required: false, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 } },
      customfield_10102: { name: "Custom text B", required: false, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10102 } },
    } });
    return;
  }

  if (method === "PUT" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/search/jql") {
    writeJson(response, {
      issues: [
        {
          key: "OPS-123",
          fields: {
            summary: "Stabilize deployment",
            status: { name: "In Progress", statusCategory: { name: "In Progress" } },
            priority: { name: "High" },
            assignee: { displayName: "Current User" },
            issuetype: { name: "Bug" },
            updated: "2026-05-01T08:20:00.000+0000",
          },
        },
      ],
    });
    return;
  }

  if (method === "GET" && url.startsWith("/ex/jira/cloud-1/rest/api/3/issue/OPS-123?")) {
    writeJson(response, {
      key: "OPS-123",
      renderedFields: {
        description: '<p><img src="/rest/api/3/attachment/content/20001" /></p>',
      },
      fields: {
        summary: "Stabilize deployment",
        status: { name: "In Progress", statusCategory: { name: "In Progress" } },
        priority: null,
        assignee: null,
        issuetype: { name: "Task" },
        updated: "2026-05-01T08:20:00.000+0000",
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Deploy safely" }] },
            {
              type: "mediaSingle",
              content: [
                {
                  type: "media",
                  attrs: { alt: "deployment.png", id: "media-platform-id", type: "file" },
                },
              ],
            },
          ],
        },
        comment: { comments: [] },
        attachment: [
          { id: "20001", filename: "deployment.png", mimeType: "image/png", size: 8 },
          {
            id: "20002",
            filename: "values.xml",
            mimeType: "application/xml",
            size: ATTACHMENT_BYTES.byteLength,
          },
        ],
        issuelinks: [],
      },
    });
    return;
  }

  if (method === "GET" && url.startsWith("/ex/jira/cloud-1/rest/api/3/issue/OPS-ATTACHMENTS?")) {
    writeJson(response, {
      key: "OPS-ATTACHMENTS",
      fields: {
        summary: "Attachment failures",
        status: { name: "Open", statusCategory: { name: "To Do" } },
        priority: null,
        assignee: null,
        issuetype: { name: "Task" },
        updated: "2026-07-24T00:00:00.000+0000",
        description: null,
        comment: { comments: [] },
        attachment: [
          { id: "21001", filename: "failed.xml", mimeType: "application/xml", size: 0 },
          { id: "21002", filename: "empty.xml", mimeType: "application/xml", size: 0 },
          {
            id: "21003",
            filename: "success.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: ATTACHMENT_BYTES.byteLength,
          },
        ],
        issuelinks: [],
      },
    });
    return;
  }

  if (method === "GET" && url.startsWith("/ex/jira/cloud-1/rest/api/3/issue/OPS-EMPTY?")) {
    writeJson(response, { fields: { description: null } });
    return;
  }

  if (method === "GET" && url.startsWith("/ex/jira/cloud-1/rest/api/3/issue/OPS-STRUCTURED?")) {
    writeJson(response, {
      key: "OPS-STRUCTURED",
      fields: {
        summary: "Structured description rendering",
        status: { name: "Open", statusCategory: { name: "To Do" } },
        priority: null,
        assignee: null,
        issuetype: { name: "Task" },
        updated: "2026-07-24T00:00:00.000+0000",
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Expected Result" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "The dashboard should load" },
                { type: "hardBreak" },
                { type: "text", text: "within two seconds." },
              ],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Region: us-east-1" }] }],
                },
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Service: checkout" }] }],
                },
              ],
            },
            { type: "rule" },
            {
              type: "mediaSingle",
              content: [{ type: "media", attrs: { alt: "diagram.png", id: "structured-media-id", type: "file" } }],
            },
          ],
        },
        comment: { comments: [] },
        attachment: [],
        issuelinks: [],
      },
    });
    return;
  }

  if (
    method === "GET" &&
    url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/comment?startAt=0&maxResults=100"
  ) {
    writeJson(response, {
      comments: [],
      maxResults: 100,
      startAt: 0,
      total: 0,
    });
    return;
  }

  if (
    method === "GET" &&
    url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-ATTACHMENTS/comment?startAt=0&maxResults=100"
  ) {
    writeJson(response, { comments: [], maxResults: 100, startAt: 0, total: 0 });
    return;
  }

  if (
    method === "GET" &&
    url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-STRUCTURED/comment?startAt=0&maxResults=100"
  ) {
    writeJson(response, {
      comments: [
        {
          id: "40001",
          author: { displayName: "Reviewer" },
          body: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Verified on staging." }] },
              {
                type: "orderedList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Deploy build 42" }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Run smoke tests" }] }],
                  },
                ],
              },
            ],
          },
          created: "2026-07-24T01:00:00.000+0000",
        },
      ],
      isLast: true,
      maxResults: 100,
      startAt: 0,
      total: 1,
    });
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/20001") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(IMAGE_BYTES);
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/20002") {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(ATTACHMENT_BYTES);
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/21001") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("private failure detail");
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/21002") {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end();
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/21003") {
    response.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    response.end(ATTACHMENT_BYTES);
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/remotelink") {
    writeJson(response, [
      {
        id: 10001,
        relationship: "Runbook",
        object: { title: "Docs", url: "https://docs.example.com" },
      },
    ]);
    return;
  }

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/transitions") {
    writeJson(response, { transitions: [{ id: "31", name: "Start Review", to: { name: "Review" } }] });
    return;
  }

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/transitions") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/worklog") {
    writeJson(response, { id: "30001" }, 201);
    return;
  }

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-123/comment") {
    writeJson(response, {
      id: "40001",
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Created comment" }] }],
      },
    }, 201);
    return;
  }

  const commentMatch = /^\/ex\/jira\/cloud-1\/rest\/api\/3\/issue\/([^/]+)\/comment\/([^/?]+)$/u.exec(url);
  if (method === "GET" && commentMatch !== null) {
    const issueKey = decodeURIComponent(commentMatch[1] ?? "");
    const commentId = decodeURIComponent(commentMatch[2] ?? "");
    if (issueKey === "OPS-NOTFOUND") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("private missing detail");
      return;
    }
    writeJson(response, fakeComment(commentId));
    return;
  }

  if (method === "DELETE" && commentMatch !== null) {
    const issueKey = decodeURIComponent(commentMatch[1] ?? "");
    if (issueKey === "OPS-DELETE-FAIL") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("private delete detail");
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-500/worklog") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("nope");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function fakeComment(commentId: string): Record<string, unknown> {
  return {
    author: {
      accountId: "synthetic-reviewer",
      displayName: "Synthetic Reviewer",
    },
    body: {
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: `Recover comment ${commentId}` }],
      }],
    },
    created: "2026-07-24T08:00:00.000+0000",
    id: commentId,
    updated: "2026-07-24T09:00:00.000+0000",
  };
}

async function commentBackupExists(home: string, requestUrl: string): Promise<boolean> {
  const matched = /^\/ex\/jira\/([^/]+)\/rest\/api\/3\/issue\/([^/]+)\/comment\/([^/?]+)$/u.exec(requestUrl);
  if (matched === null) {
    return false;
  }
  const cloudId = decodeURIComponent(matched[1] ?? "");
  const issueKey = decodeURIComponent(matched[2] ?? "");
  const commentId = decodeURIComponent(matched[3] ?? "");
  const path = join(
    home,
    ".saptools",
    "jira",
    "clouds",
    cloudId,
    "comments",
    issueKey,
    `${commentId}.json`,
  );
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) && value["id"] === commentId && isRecord(value["body"]);
  } catch {
    return false;
  }
}

function handleAssignableSearch(url: string, response: ServerResponse): void {
  const parsed = new URL(url, "http://127.0.0.1");
  expect(parsed.searchParams.get("issueKey")).toBe("OPS-ASSIGN");
  expect(parsed.searchParams.get("maxResults")).toBe("1000");
  const accountId = parsed.searchParams.get("accountId");
  if (accountId === "account-me") {
    writeJson(response, [{ accountId: "account-me", active: true, displayName: "Current User" }]);
    return;
  }
  if (accountId === "account-known") {
    writeJson(response, [{ accountId: "account-known", active: true, displayName: "Known User" }]);
    return;
  }
  if (accountId === "permission-denied") {
    writeJson(response, [{ accountId: "permission-denied", active: true, displayName: "Permission Denied" }]);
    return;
  }
  const query = parsed.searchParams.get("query");
  if (query === "Fuzzy") {
    writeJson(response, [{ accountId: "account-fuzzy", active: true, displayName: "Fuzzy Match" }]);
    return;
  }
  if (query === "Example Tran") {
    writeJson(response, [
      { accountId: "account-exact", active: true, displayName: "Example Tran" },
      { accountId: "account-another", active: true, displayName: "Another Tran" },
      { accountId: "account-third", active: true, displayName: "Third Tran" },
    ]);
    return;
  }
  if (query === "Exam Tran") {
    writeJson(response, [
      { accountId: "account-example", active: true, displayName: "Example Tran" },
      { accountId: "account-another", active: true, displayName: "Another Tran" },
    ]);
    return;
  }
  if (query === "Duplicate Name") {
    writeJson(response, [
      { accountId: "account-dup-1", active: true, displayName: "Duplicate Name" },
      { accountId: "account-dup-2", active: true, displayName: "Duplicate Name" },
    ]);
    return;
  }
  writeJson(response, []);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

function normalizeOutput(output: string | Uint8Array): string {
  return typeof output === "string" ? output : Buffer.from(output).toString("utf8");
}

function hasMediaId(value: unknown, mediaId: string): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const attrs = value["attrs"];
  if (isRecord(attrs) && attrs["id"] === mediaId) {
    return true;
  }

  const content = value["content"];
  return Array.isArray(content) && content.some((child) => hasMediaId(child, mediaId));
}

function findTopLevelNodeWithMedia(
  document: { readonly content?: readonly unknown[] },
  mediaId: string,
): unknown {
  const node = document.content?.find((candidate) => hasMediaId(candidate, mediaId));
  if (node === undefined) {
    throw new Error(`Expected printed ADF to include media node ${mediaId}`);
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test.describe("Jira CLI", () => {
  test("User can inspect the installed CLI version", async () => {
    const { stdout } = await execFileAsync("node", [CLI_PATH, "--version"], {
      timeout: 30_000,
    });

    expect(normalizeOutput(stdout)).toMatch(/^\d+\.\d+\.\d+\n$/u);
  });

  test("User can inspect shared JiraOps token status", async () => {
    const ctx = await prepareCliContext();
    try {
      const result = await ctx.run(["status", "--json"]);
      const status = JSON.parse(result.stdout) as {
        readonly cloudId: string;
        readonly connected: boolean;
      };

      expect(status).toMatchObject({ cloudId: "cloud-1", connected: true });
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can inspect the connected Jira account without exposing a token", async () => {
    const ctx = await prepareCliContext();
    try {
      const human = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "whoami"]);
      const json = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "whoami", "--json"]);

      expect(human.stdout).toContain("Display name: Current User");
      expect(human.stdout).toContain("Account ID: account-me");
      expect(human.stdout).toContain("Email: current.user@example.com");
      expect(human.stdout).toContain("Status: Active");
      expect(human.stdout).not.toContain("e2e-access-token");
      expect(JSON.parse(json.stdout)).toEqual({
        accountId: "account-me",
        active: true,
        displayName: "Current User",
        emailAddress: "current.user@example.com",
      });
      expect(json.stdout).not.toContain("e2e-access-token");
    } finally {
      await ctx.cleanup();
    }
  });

  test("Whoami handles private email and neutral auth or response failures", async () => {
    const privateCtx = await prepareCliContext({ cloudId: "cloud-no-email" });
    try {
      const result = await privateCtx.run([
        "--api-root",
        privateCtx.fakeJira.apiRoot,
        "whoami",
        "--json",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        accountId: "account-private",
        emailAddress: null,
      });
    } finally {
      await privateCtx.cleanup();
    }

    const malformedCtx = await prepareCliContext({ cloudId: "cloud-malformed" });
    try {
      await expect(malformedCtx.run([
        "--api-root",
        malformedCtx.fakeJira.apiRoot,
        "whoami",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Jira current user profile response was not valid."),
      });
    } finally {
      await malformedCtx.cleanup();
    }

    const missingTokenCtx = await prepareCliContext();
    try {
      await rm(join(missingTokenCtx.home, ".jira-oauth"), { recursive: true, force: true });
      await expect(missingTokenCtx.run([
        "--api-root",
        missingTokenCtx.fakeJira.apiRoot,
        "whoami",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Jira token is required."),
      });
      expect(missingTokenCtx.fakeJira.requests()).toHaveLength(0);
    } finally {
      await missingTokenCtx.cleanup();
    }
  });

  test("User can list assigned issues using the shared token store", async () => {
    const ctx = await prepareCliContext();
    try {
      const result = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "issues", "--json"]);
      const issues = JSON.parse(result.stdout) as readonly { readonly key: string }[];

      expect(issues).toEqual([expect.objectContaining({ key: "OPS-123" })]);
      expect(ctx.fakeJira.requests()[0]).toMatchObject({
        authorization: "Bearer e2e-access-token",
        method: "POST",
        url: "/ex/jira/cloud-1/rest/api/3/search/jql",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can read issue details, links, and transitions", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "issue", "OPS-123", "--json"]);
      const links = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "links", "OPS-123", "--json"]);
      const transitions = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "transitions",
        "OPS-123",
        "--json",
      ]);

      const parsedDetail = JSON.parse(detail.stdout) as {
        readonly attachments: readonly {
          readonly downloadError?: string;
          readonly fileUrl?: string;
          readonly id: string;
          readonly localPath?: string;
        }[];
        readonly comments: readonly Record<string, unknown>[];
        readonly descriptionAdf: unknown;
        readonly descriptionText: string;
        readonly images: readonly { readonly filePath: string; readonly fileUrl: string }[];
      };
      expect(parsedDetail).toMatchObject({
        descriptionText: "Deploy safely\n\n[image: deployment.png]",
      });
      expect(hasMediaId(parsedDetail.descriptionAdf, "media-platform-id")).toBe(true);
      expect(parsedDetail.attachments).toHaveLength(2);
      expect(parsedDetail.attachments[0]).toMatchObject({
        fileUrl: expect.stringMatching(/^file:\/\//u),
        id: "20001",
        localPath: parsedDetail.images[0]?.filePath,
      });
      expect(parsedDetail.attachments[1]).toMatchObject({
        fileUrl: expect.stringMatching(/^file:\/\//u),
        id: "20002",
        localPath: expect.stringContaining("20002-values.xml"),
      });
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "byteLength")).toBe(false);
      expect(Object.hasOwn(parsedDetail.comments[0] ?? {}, "images")).toBe(false);
      expect(parsedDetail.images[0]?.fileUrl).toMatch(/^file:\/\//u);
      await expect(readFile(parsedDetail.images[0]?.filePath ?? "")).resolves.toEqual(
        Buffer.from(IMAGE_BYTES),
      );
      await expect(readFile(parsedDetail.attachments[1]?.localPath ?? "")).resolves.toEqual(
        Buffer.from(ATTACHMENT_BYTES),
      );
      const imageFetches = ctx.fakeJira.requests().filter((request) => {
        return request.url.endsWith("/attachment/content/20001");
      });
      expect(imageFetches).toHaveLength(1);
      expect(JSON.parse(links.stdout)).toEqual([expect.objectContaining({ title: "Docs" })]);
      expect(JSON.parse(transitions.stdout)).toEqual([expect.objectContaining({ id: "31" })]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can read a structure-preserving description and comment body", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "issue",
        "OPS-STRUCTURED",
        "--json",
      ]);
      const parsedDetail = JSON.parse(detail.stdout) as {
        readonly comments: readonly { readonly bodyText: string }[];
        readonly descriptionText: string;
      };

      expect(parsedDetail.descriptionText).toBe(
        [
          "Expected Result",
          "",
          "The dashboard should load\nwithin two seconds.",
          "",
          "- Region: us-east-1",
          "- Service: checkout",
          "",
          "---",
          "",
          "[image: diagram.png]",
        ].join("\n"),
      );
      expect(parsedDetail.comments[0]?.bodyText).toBe(
        ["Verified on staging.", "", "1. Deploy build 42", "2. Run smoke tests"].join("\n"),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can print current description ADF and round-trip an edited document with media intact", async () => {
    const ctx = await prepareCliContext();
    try {
      const printed = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--print",
      ]);
      const printedAdf = JSON.parse(printed.stdout) as {
        readonly content?: readonly unknown[];
        readonly type?: unknown;
        readonly version?: unknown;
      };
      expect(printedAdf).toMatchObject({ type: "doc", version: 1 });
      expect(hasMediaId(printedAdf, "media-platform-id")).toBe(true);

      const envelope = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--print",
        "--json",
      ]);
      const parsedEnvelope = JSON.parse(envelope.stdout) as {
        readonly description: unknown;
        readonly issueKey: string;
      };
      expect(parsedEnvelope.issueKey).toBe("OPS-123");
      expect(hasMediaId(parsedEnvelope.description, "media-platform-id")).toBe(true);

      const mediaNode = findTopLevelNodeWithMedia(printedAdf, "media-platform-id");
      const editedAdf = {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Deploy safely after review" }] },
          mediaNode,
        ],
      };
      const adfPath = join(ctx.home, "round-trip-description.json");
      await writeFile(adfPath, JSON.stringify(editedAdf), "utf8");

      const updated = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--adf-file",
        adfPath,
        "--json",
      ]);
      expect(JSON.parse(updated.stdout)).toEqual({ issueKey: "OPS-123", updated: ["description"] });
      const roundTripPut = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "PUT" && entry.body.includes("Deploy safely after review");
      });
      const putBody = JSON.parse(roundTripPut?.body ?? "{}") as {
        readonly fields?: { readonly description?: unknown };
      };
      expect(putBody.fields?.description).toEqual(editedAdf);
      expect(hasMediaId(putBody.fields?.description, "media-platform-id")).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  test("User gets explicit null-description behavior when printing current ADF", async () => {
    const ctx = await prepareCliContext();
    try {
      const envelope = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-EMPTY",
        "--print",
        "--json",
      ]);
      expect(JSON.parse(envelope.stdout)).toEqual({ issueKey: "OPS-EMPTY", description: null });

      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-EMPTY",
        "--print",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("has no description ADF to print"),
      });
    } finally {
      await ctx.cleanup();
    }
  });


  test("No-images skips inline image hydration but still downloads all attachments", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--no-images",
      ]);
      const parsedDetail = JSON.parse(detail.stdout) as {
        readonly attachments: readonly {
          readonly id: string;
          readonly localPath?: string;
        }[];
        readonly images: readonly unknown[];
      };

      expect(parsedDetail.images).toEqual([]);
      expect(parsedDetail.attachments).toEqual([
        expect.objectContaining({ id: "20001", localPath: expect.any(String) }),
        expect.objectContaining({ id: "20002", localPath: expect.any(String) }),
      ]);
      expect(ctx.fakeJira.requests().filter((entry) => {
        return entry.url.includes("/attachment/content/");
      })).toHaveLength(2);
    } finally {
      await ctx.cleanup();
    }
  });

  test("No-attachments remains independent from inline image hydration", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--no-attachments",
      ]);
      const parsedDetail = JSON.parse(detail.stdout) as {
        readonly attachments: readonly Record<string, unknown>[];
        readonly images: readonly unknown[];
      };

      expect(parsedDetail.images).toHaveLength(1);
      expect(parsedDetail.attachments).toHaveLength(2);
      expect(parsedDetail.attachments.every((attachment) => {
        return !Object.hasOwn(attachment, "localPath") && !Object.hasOwn(attachment, "fileUrl");
      })).toBe(true);
      expect(ctx.fakeJira.requests().filter((entry) => {
        return entry.url.includes("/attachment/content/");
      }).map((entry) => entry.url)).toEqual([
        "/ex/jira/cloud-1/rest/api/3/attachment/content/20001",
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("No-images and no-attachments together skip all attachment content requests", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--no-images",
        "--no-attachments",
      ]);
      const parsedDetail = JSON.parse(detail.stdout) as {
        readonly attachments: readonly Record<string, unknown>[];
        readonly images: readonly unknown[];
      };

      expect(parsedDetail.images).toEqual([]);
      expect(parsedDetail.attachments).toHaveLength(2);
      expect(ctx.fakeJira.requests().some((entry) => {
        return entry.url.includes("/attachment/content/");
      })).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Attachment output, byte, and count controls degrade per file", async () => {
    const customDirCtx = await prepareCliContext();
    try {
      const attachmentDir = join(customDirCtx.home, "controlled-attachments");
      const detail = await customDirCtx.run([
        "--api-root",
        customDirCtx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--no-images",
        "--attachment-dir",
        attachmentDir,
      ]);
      const parsed = JSON.parse(detail.stdout) as {
        readonly attachments: readonly { readonly localPath?: string }[];
      };
      expect(parsed.attachments.every((attachment) => {
        return attachment.localPath?.startsWith(attachmentDir) === true;
      })).toBe(true);
    } finally {
      await customDirCtx.cleanup();
    }

    const capCtx = await prepareCliContext();
    try {
      const countLimited = await capCtx.run([
        "--api-root",
        capCtx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--max-attachments",
        "1",
      ]);
      const countAttachments = (JSON.parse(countLimited.stdout) as {
        readonly attachments: readonly {
          readonly downloadError?: string;
          readonly id: string;
        }[];
      }).attachments;
      expect(countAttachments[0]).toMatchObject({ id: "20001" });
      expect(countAttachments[1]?.downloadError).toContain("1 attachment limit");
      expect(capCtx.fakeJira.requests().some((entry) => {
        return entry.url.endsWith("/attachment/content/20002");
      })).toBe(false);
    } finally {
      await capCtx.cleanup();
    }

    const byteCtx = await prepareCliContext();
    try {
      const byteLimited = await byteCtx.run([
        "--api-root",
        byteCtx.fakeJira.apiRoot,
        "issue",
        "OPS-123",
        "--json",
        "--max-attachment-bytes",
        "3",
      ]);
      const byteAttachments = (JSON.parse(byteLimited.stdout) as {
        readonly attachments: readonly { readonly downloadError?: string; readonly id: string }[];
      }).attachments;
      expect(byteAttachments[1]?.downloadError).toContain("3 byte download limit");
      expect(byteCtx.fakeJira.requests().some((entry) => {
        return entry.url.endsWith("/attachment/content/20002");
      })).toBe(false);
    } finally {
      await byteCtx.cleanup();
    }
  });

  test("One failed or empty attachment does not abort remaining downloads", async () => {
    const ctx = await prepareCliContext();
    try {
      const detail = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "issue",
        "OPS-ATTACHMENTS",
        "--json",
      ]);
      const attachments = (JSON.parse(detail.stdout) as {
        readonly attachments: readonly {
          readonly downloadError?: string;
          readonly id: string;
          readonly localPath?: string;
          readonly mimeType: string;
        }[];
      }).attachments;

      expect(attachments[0]?.downloadError).toContain("HTTP 500");
      expect(attachments[1]?.downloadError).toContain("empty body");
      expect(attachments[2]).toMatchObject({
        id: "21003",
        localPath: expect.any(String),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      await expect(readFile(attachments[2]?.localPath ?? "")).resolves.toEqual(
        Buffer.from(ATTACHMENT_BYTES),
      );
      expect(ctx.fakeJira.requests().filter((entry) => {
        return entry.url.includes("/attachment/content/210");
      })).toHaveLength(3);
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can transition an issue and add worklog time", async () => {
    const ctx = await prepareCliContext();
    try {
      const transition = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "transition",
        "OPS-123",
        "--id",
        "31",
      ]);
      const worklog = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "worklog",
        "OPS-123",
        "--minutes",
        "30",
        "--comment",
        "Focused review",
        "--started",
        "2026-05-01T08:20:00.000+0000",
      ]);

      expect(transition.stdout).toContain("Transition applied");
      expect(worklog.stdout).toContain("Worklog added");
      const writeBodies = ctx.fakeJira
        .requests()
        .filter((entry) => entry.method === "POST")
        .map((entry) => entry.body);
      expect(writeBodies[0]).toBe(JSON.stringify({ transition: { id: "31" } }));
      expect(writeBodies[1]).toContain("Focused review");
      expect(writeBodies[1]).toContain("2026-05-01T08:20:00.000+0000");
      const history = await readFile(join(ctx.home, ".saptools", "jira", "worklog-history", "202605.md"), "utf8");
      expect(history).toContain("# Jira Worklog History 202605");
      expect(history).toContain("| 2026-05-01T08:20:00.000+0000 | OPS-123 | 30 | 0.50 | Focused review |");

      const daySummary = await ctx.run(["worklogs", "--day", "2026-05-01", "--json"]);
      expect(JSON.parse(daySummary.stdout)).toMatchObject({
        groups: [{ key: "OPS-123", minutes: 30 }],
        minutes: 30,
      });
      const issueSummary = await ctx.run(["worklogs", "--issue", "OPS-123", "--month", "202605", "--json"]);
      expect(JSON.parse(issueSummary.stdout)).toMatchObject({ minutes: 30 });
      const humanSummary = await ctx.run(["worklogs", "--month", "202605", "--group-by", "issue"]);
      expect(humanSummary.stdout).toContain("OPS-123\t30 minutes\t0.50 hours");
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can update descriptions without silently dropping existing media", async () => {
    const ctx = await prepareCliContext();
    try {
      const forced = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--text",
        "Forced replacement",
        "--force",
      ]);
      expect(forced.stdout).toContain("Description updated on OPS-123.");
      const forcedPut = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "PUT" && entry.body.includes("Forced replacement");
      });
      expect(JSON.parse(forcedPut?.body ?? "{}")).toEqual({
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Forced replacement" }] }],
          },
        },
      });

      const adfPath = join(ctx.home, "description.adf.json");
      const rawAdf = {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Raw ADF description" }] },
          {
            type: "mediaSingle",
            content: [{ type: "media", attrs: { id: "media-platform-id", type: "file" } }],
          },
        ],
      };
      await writeFile(adfPath, JSON.stringify(rawAdf), "utf8");
      const raw = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--adf-file",
        adfPath,
        "--json",
      ]);
      expect(JSON.parse(raw.stdout)).toEqual({ issueKey: "OPS-123", updated: ["description"] });
      const rawPut = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "PUT" && entry.body.includes("Raw ADF description");
      });
      expect(JSON.parse(rawPut?.body ?? "{}")).toEqual({ fields: { description: rawAdf } });

      const requestCountBeforeRefusal = ctx.fakeJira.requests().length;
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--text",
        "Unsafe replacement",
      ])).rejects.toMatchObject({ stderr: expect.stringContaining("contains media") });
      const refusalRequests = ctx.fakeJira.requests().slice(requestCountBeforeRefusal);
      expect(refusalRequests.some((entry) => entry.method === "PUT")).toBe(false);

      const appended = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "describe",
        "OPS-123",
        "--text",
        "Appended note",
        "--append",
        "--json",
      ]);
      expect(JSON.parse(appended.stdout)).toEqual({ issueKey: "OPS-123", updated: ["description"] });
      const appendPut = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "PUT" && entry.body.includes("Appended note");
      });
      const appendBody = JSON.parse(appendPut?.body ?? "{}") as {
        readonly fields: { readonly description: { readonly content: readonly unknown[] } };
      };
      expect(appendBody.fields.description.content).toHaveLength(3);
      expect(JSON.stringify(appendBody.fields.description)).toContain("media-platform-id");
      expect(JSON.stringify(appendBody.fields.description)).toContain("Appended note");
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can update summaries and add comments", async () => {
    const ctx = await prepareCliContext();
    try {
      const summary = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "summary",
        "OPS-123",
        "Updated title",
        "--json",
      ]);
      expect(JSON.parse(summary.stdout)).toEqual({ issueKey: "OPS-123", updated: ["summary"] });
      const summaryPut = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "PUT" && entry.body.includes("Updated title");
      });
      expect(JSON.parse(summaryPut?.body ?? "{}")).toEqual({
        fields: { summary: "Updated title" },
      });

      const comment = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment",
        "OPS-123",
        "--text",
        "Review note",
      ]);
      expect(comment.stdout).toContain("Comment added to OPS-123.");
      const commentPost = ctx.fakeJira.requests().find((entry) => {
        return entry.method === "POST" && entry.url.endsWith("/issue/OPS-123/comment");
      });
      expect(JSON.parse(commentPost?.body ?? "{}")).toEqual({
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Review note" }] }],
        },
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test("Comment deletion writes a full backup before every DELETE request", async () => {
    const ctx = await prepareCliContext();
    try {
      const human = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment-delete",
        "OPS-DELETE",
        "10098",
      ]);
      const humanBackupPath = join(
        ctx.home,
        ".saptools",
        "jira",
        "clouds",
        "cloud-1",
        "comments",
        "OPS-DELETE",
        "10098.json",
      );
      expect(human.stdout).toContain(
        `Deleted comment 10098 on OPS-DELETE. Backup saved to ${humanBackupPath}`,
      );
      expect(JSON.parse(await readFile(humanBackupPath, "utf8"))).toEqual({
        authorDisplayName: "Synthetic Reviewer",
        body: {
          type: "doc",
          version: 1,
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Recover comment 10098" }],
          }],
        },
        created: "2026-07-24T08:00:00.000+0000",
        id: "10098",
        updated: "2026-07-24T09:00:00.000+0000",
      });

      const json = await ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment-delete",
        "OPS-DELETE",
        "10099",
        "--json",
      ]);
      const jsonBackupPath = join(dirname(humanBackupPath), "10099.json");
      expect(JSON.parse(json.stdout)).toEqual({
        backupPath: jsonBackupPath,
        commentId: "10099",
        deleted: true,
        issueKey: "OPS-DELETE",
      });
      const deleteRequests = ctx.fakeJira.requests().filter((entry) => entry.method === "DELETE");
      expect(deleteRequests).toHaveLength(2);
      expect(deleteRequests.every((entry) => entry.backupExistsAtReceipt === true)).toBe(true);
      expect(deleteRequests.map((entry) => entry.url)).toEqual([
        "/ex/jira/cloud-1/rest/api/3/issue/OPS-DELETE/comment/10098",
        "/ex/jira/cloud-1/rest/api/3/issue/OPS-DELETE/comment/10099",
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Comment deletion never calls DELETE when the backup write fails", async () => {
    const ctx = await prepareCliContext();
    try {
      const issueBackupDirectory = join(
        ctx.home,
        ".saptools",
        "jira",
        "clouds",
        "cloud-1",
        "comments",
        "OPS-BACKUP-FAIL",
      );
      await mkdir(dirname(issueBackupDirectory), { recursive: true });
      await writeFile(issueBackupDirectory, "blocking file", "utf8");

      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment-delete",
        "OPS-BACKUP-FAIL",
        "10098",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Error:"),
        stdout: "",
      });
      const requests = ctx.fakeJira.requests();
      expect(requests.some((entry) => entry.method === "GET" && entry.url.includes("OPS-BACKUP-FAIL"))).toBe(true);
      expect(requests.some((entry) => entry.method === "DELETE")).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Missing comments fail before backup and DELETE", async () => {
    const ctx = await prepareCliContext();
    try {
      const backupPath = join(
        ctx.home,
        ".saptools",
        "jira",
        "clouds",
        "cloud-1",
        "comments",
        "OPS-NOTFOUND",
        "40400.json",
      );
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment-delete",
        "OPS-NOTFOUND",
        "40400",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Jira issue comment could not be loaded."),
        stdout: "",
      });
      await expect(readFile(backupPath, "utf8")).rejects.toBeInstanceOf(Error);
      expect(ctx.fakeJira.requests().some((entry) => entry.method === "DELETE")).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A failed Jira DELETE keeps the backup and is not retried", async () => {
    const ctx = await prepareCliContext();
    try {
      const backupPath = join(
        ctx.home,
        ".saptools",
        "jira",
        "clouds",
        "cloud-1",
        "comments",
        "OPS-DELETE-FAIL",
        "50000.json",
      );
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "comment-delete",
        "OPS-DELETE-FAIL",
        "50000",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Jira issue comment could not be deleted."),
        stdout: "",
      });
      expect(JSON.parse(await readFile(backupPath, "utf8"))).toMatchObject({
        id: "50000",
        authorDisplayName: "Synthetic Reviewer",
      });
      const deleteRequests = ctx.fakeJira.requests().filter((entry) => entry.method === "DELETE");
      expect(deleteRequests).toHaveLength(1);
      expect(deleteRequests[0]?.backupExistsAtReceipt).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can safely assign issues through deterministic selectors", async () => {
    const ctx = await prepareCliContext();
    try {
      const me = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "assign", "OPS-ASSIGN", "--me", "--json"]);
      expect(JSON.parse(me.stdout)).toMatchObject({ assignee: { accountId: "account-me" }, resolution: "me" });

      const fuzzy = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "assign", "OPS-ASSIGN", "--to", "Fuzzy", "--json"]);
      expect(JSON.parse(fuzzy.stdout)).toMatchObject({ assignee: { accountId: "account-fuzzy" }, resolution: "single-fuzzy" });

      const exact = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "assign", "OPS-ASSIGN", "--to", "Example Tran"]);
      expect(exact.stdout).toContain("Assigned OPS-ASSIGN to Example Tran.");

      const known = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "assign", "OPS-ASSIGN", "--account-id", "account-known", "--json"]);
      expect(JSON.parse(known.stdout)).toMatchObject({ assignee: { accountId: "account-known" }, resolution: "account-id" });

      const puts = ctx.fakeJira.requests().filter((entry) => entry.method === "PUT" && entry.url.endsWith("/assignee"));
      expect(puts.map((entry) => JSON.parse(entry.body) as Record<string, string>)).toEqual([
        { accountId: "account-me" },
        { accountId: "account-fuzzy" },
        { accountId: "account-exact" },
        { accountId: "account-known" },
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Assignment selector validation fails before Jira requests", async () => {
    const ctx = await prepareCliContext();
    try {
      const invalidSelectors: readonly (readonly string[])[] = [
        ["assign", "OPS-ASSIGN"],
        ["assign", "OPS-ASSIGN", "--me", "--to", "Example"],
        ["assign", "OPS-ASSIGN", "--me", "--account-id", "account-known"],
        ["assign", "OPS-ASSIGN", "--to", "Example", "--account-id", "account-known"],
        ["assign", "OPS-ASSIGN", "--to", "   "],
        ["assign", "OPS-ASSIGN", "--account-id", "   "],
      ];
      for (const args of invalidSelectors) {
        await expect(ctx.run(["--api-root", ctx.fakeJira.apiRoot, ...args])).rejects.toMatchObject({
          stderr: expect.stringContaining("Error:"),
        });
      }
      expect(ctx.fakeJira.requests()).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Ambiguous assignment candidates are returned without a write", async () => {
    const ctx = await prepareCliContext();
    try {
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "assign",
        "OPS-ASSIGN",
        "--to",
        "Exam Tran",
        "--json",
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("\"error\": \"ambiguous_assignee\""),
      });
      expect(ctx.fakeJira.requests().some((entry) => entry.method === "PUT")).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Duplicate exact assignment names and permission failures do not retry writes", async () => {
    const ctx = await prepareCliContext();
    try {
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "assign",
        "OPS-ASSIGN",
        "--to",
        "Duplicate Name",
      ])).rejects.toMatchObject({ stderr: expect.stringContaining("no assignment was changed") });
      expect(ctx.fakeJira.requests().some((entry) => entry.method === "PUT")).toBe(false);

      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "assign",
        "OPS-ASSIGN",
        "--account-id",
        "permission-denied",
      ])).rejects.toMatchObject({ stderr: expect.stringContaining("Jira issue assignee could not be updated") });
      const puts = ctx.fakeJira.requests().filter((entry) => entry.method === "PUT");
      expect(puts).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Local worklog summaries do not need tokens or Jira network calls", async () => {
    const ctx = await prepareCliContext();
    try {
      await rm(join(ctx.home, ".jira-oauth"), { recursive: true, force: true });
      const summary = await ctx.run(["worklogs", "--month", "202607", "--json"]);
      expect(JSON.parse(summary.stdout)).toMatchObject({ entries: [], groups: [], minutes: 0 });
      expect(ctx.fakeJira.requests()).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("Failed Jira worklog writes do not append local history", async () => {
    const ctx = await prepareCliContext();
    try {
      await expect(ctx.run([
        "--api-root",
        ctx.fakeJira.apiRoot,
        "worklog",
        "OPS-500",
        "--minutes",
        "30",
        "--started",
        "2026-07-02T06:20:14.000+0000",
      ])).rejects.toThrow("Jira worklog could not be added");
      await expect(readFile(join(ctx.home, ".saptools", "jira", "worklog-history", "202607.md"), "utf8")).rejects.toThrow();
    } finally {
      await ctx.cleanup();
    }
  });


  test("User can discover, pin, search, hint, and update custom fields", async () => {
    const ctx = await prepareCliContext();
    try {
      const discover = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "fields", "discover", "--search", "text A"]);
      expect(discover.stdout).toContain("Discovered 2 Jira custom fields");
      expect(discover.stdout).toContain("customfield_10101");
      const snapshotRaw = await readFile(join(ctx.home, ".saptools", "jira", "clouds", "cloud-1", "fields.json"), "utf8");
      expect(snapshotRaw).toContain("customfield_10102");
      expect(snapshotRaw).not.toContain("e2e-access-token");

      const search = await ctx.run(["fields", "search", "textarea", "--json"]);
      expect(JSON.parse(search.stdout)).toEqual([expect.objectContaining({ name: "Custom text A" })]);
      await ctx.run(["fields", "pin", "Custom text A"]);
      await ctx.run(["fields", "pin", "Custom text B"]);
      const pinned = await ctx.run(["fields", "pinned"]);
      expect(pinned.stdout).toContain("Custom text A");
      expect(pinned.stdout).not.toContain("customfield_");

      const issues = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "issues"]);
      expect(issues.stdout).toContain("Updatable custom fields: Custom text A, Custom text B");
      expect(issues.stdout).not.toContain("customfield_");
      const status = await ctx.run(["status"]);
      expect(status.stdout).toContain("Updatable custom fields: Custom text A, Custom text B");
      const noHints = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "--no-hints", "issues"]);
      expect(noHints.stdout).not.toContain("Updatable custom fields");
      const jsonIssues = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "issues", "--json"]);
      const parsedJsonIssues: unknown = JSON.parse(jsonIssues.stdout);
      expect(parsedJsonIssues).toBeDefined();
      expect(jsonIssues.stdout).not.toContain("Updatable custom fields");

      const update = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "fields", "update", "OPS-123", "--field", "Custom text A=First value", "--field", "Custom text B=Second=value"]);
      expect(update.stdout).toContain("Updated custom fields on OPS-123: Custom text A, Custom text B.");
      expect(update.stdout).not.toContain("First value");
      const put = ctx.fakeJira.requests().find((entry) => entry.method === "PUT");
      const discoverHelp = await ctx.run(["fields", "discover", "--help"]);
      expect(discoverHelp.stdout).not.toContain("--refresh");
      expect(JSON.parse(put?.body ?? "{}")).toEqual({ fields: {
        customfield_10101: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "First value" }] }] },
        customfield_10102: "Second=value",
      } });
    } finally {
      await ctx.cleanup();
    }
  });

  test("User can log out by clearing the shared token store", async () => {
    const ctx = await prepareCliContext();
    try {
      const logout = await ctx.run(["logout"]);
      const status = await ctx.run(["status", "--json"]);

      expect(logout.stdout).toBe("Logged out from Jira.\n");
      expect(JSON.parse(status.stdout)).toMatchObject({ connected: false, usable: false });
    } finally {
      await ctx.cleanup();
    }
  });
});
