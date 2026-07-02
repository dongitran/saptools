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

function createTokens(): JiraTokensFixture {
  return {
    accessToken: "e2e-access-token",
    refreshToken: "e2e-refresh-token",
    expiresIn: 3600,
    scope: "read:jira-work write:jira-work offline_access",
    tokenType: "Bearer",
    cloudId: "cloud-1",
    cloudName: "E2E Jira",
    issuedAt: Date.now(),
  };
}

async function prepareCliContext(): Promise<CliContext> {
  const home = await mkdtemp(join(tmpdir(), "saptools-jira-e2e-"));
  const tokenPath = join(home, ".jira-oauth", "tokens.json");
  const fakeJira = await startFakeJiraServer();
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(createTokens(), null, 2)}\n`, {
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

async function startFakeJiraServer(): Promise<FakeJiraServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void handleFakeJiraRequest(request, response, requests);
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
): Promise<void> {
  const body = await readRequestBody(request);
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  requests.push({
    authorization: request.headers.authorization,
    body,
    method,
    url,
  });


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
        attachment: [{ id: "20001", filename: "deployment.png", mimeType: "image/png", size: 8 }],
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

  if (method === "GET" && url === "/ex/jira/cloud-1/rest/api/3/attachment/content/20001") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(IMAGE_BYTES);
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

  if (method === "POST" && url === "/ex/jira/cloud-1/rest/api/3/issue/OPS-500/worklog") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("nope");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
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
        readonly attachments: readonly Record<string, unknown>[];
        readonly comments: readonly Record<string, unknown>[];
        readonly descriptionText: string;
        readonly images: readonly { readonly filePath: string; readonly fileUrl: string }[];
      };
      expect(parsedDetail).toMatchObject({ descriptionText: "Deploy safely" });
      expect(parsedDetail.attachments[0]).toEqual({
        filename: "deployment.png",
        id: "20001",
        mimeType: "image/png",
        size: 8,
      });
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "localPath")).toBe(false);
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "fileUrl")).toBe(false);
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "byteLength")).toBe(false);
      expect(Object.hasOwn(parsedDetail.comments[0] ?? {}, "images")).toBe(false);
      expect(parsedDetail.images[0]?.fileUrl).toMatch(/^file:\/\//u);
      await expect(readFile(parsedDetail.images[0]?.filePath ?? "")).resolves.toEqual(
        Buffer.from(IMAGE_BYTES),
      );
      expect(JSON.parse(links.stdout)).toEqual([expect.objectContaining({ title: "Docs" })]);
      expect(JSON.parse(transitions.stdout)).toEqual([expect.objectContaining({ id: "31" })]);
    } finally {
      await ctx.cleanup();
    }
  });


  test("User can read issue details without downloading images", async () => {
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
        readonly attachments: readonly Record<string, unknown>[];
        readonly images: readonly unknown[];
      };

      expect(parsedDetail.images).toEqual([]);
      expect(parsedDetail.attachments[0]).toEqual({
        filename: "deployment.png",
        id: "20001",
        mimeType: "image/png",
        size: 8,
      });
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "localPath")).toBe(false);
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "fileUrl")).toBe(false);
      expect(Object.hasOwn(parsedDetail.attachments[0] ?? {}, "byteLength")).toBe(false);
      expect(ctx.fakeJira.requests().some((entry) => entry.url.includes("/attachment/content/20001"))).toBe(false);
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
      const jsonIssues = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "issues", "--json"]);
      const parsedJsonIssues: unknown = JSON.parse(jsonIssues.stdout);
      expect(parsedJsonIssues).toBeDefined();
      expect(jsonIssues.stdout).not.toContain("Updatable custom fields");

      const update = await ctx.run(["--api-root", ctx.fakeJira.apiRoot, "fields", "update", "OPS-123", "--field", "Custom text A=First value", "--field", "Custom text B=Second=value"]);
      expect(update.stdout).toContain("Updated custom fields on OPS-123: Custom text A, Custom text B.");
      expect(update.stdout).not.toContain("First value");
      const put = ctx.fakeJira.requests().find((entry) => entry.method === "PUT");
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
