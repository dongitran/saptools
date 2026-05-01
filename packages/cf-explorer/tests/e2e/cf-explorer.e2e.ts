import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  PACKAGE_DIR,
  type Scenario,
  createEnv,
  prepareCase,
  readLog,
  runCli,
} from "./helpers.js";

function scenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "demo-org",
            spaces: [
              {
                name: "dev",
                apps: [
                  {
                    name: "demo-app",
                    sshEnabled: false,
                    instances: [
                      { index: 0, state: "running" },
                      { index: 1, state: "running" },
                    ],
                    files: {
                      "/workspace/app/package.json": "{\"name\":\"demo-app\"}\n",
                      "/workspace/app/src/connect.js": [
                        "function ping() {",
                        "  return 'needle-api';",
                        "}",
                        "",
                      ].join("\n"),
                      "/workspace/app/src/other.ts": "export const value = 'needle-api';\n",
                      "/workspace/app/README.md": "demo\n",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const targetArgs = [
  "--region",
  "ap10",
  "--org",
  "demo-org",
  "--space",
  "dev",
  "--app",
  "demo-app",
] as const;

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(join(PACKAGE_DIR, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { readonly version?: unknown };
  const version = parsed.version;
  expect(typeof version).toBe("string");
  if (typeof version !== "string") {
    throw new Error("Package version must be a string.");
  }
  return version;
}

test("User can inspect the installed CLI version", async () => {
  const version = await readPackageVersion();

  const result = await runCli(process.env, ["--version"]);

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(version);
});

test("User can discover roots, instances, files, content, and line context", async () => {
  const paths = await prepareCase("discovery", scenario());
  const env = createEnv(paths);

  const roots = await runCli(env, ["roots", ...targetArgs]);
  expect(roots.code).toBe(0);
  expect(JSON.parse(roots.stdout).roots).toContain("/workspace/app");

  const list = await runCli(env, ["ls", ...targetArgs, "--path", "/workspace/app"]);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).entries.map((entry: { name: string }) => entry.name)).toEqual(
    expect.arrayContaining(["README.md", "package.json", "src"]),
  );

  const instances = await runCli(env, ["instances", ...targetArgs]);
  expect(instances.code).toBe(0);
  expect(JSON.parse(instances.stdout).instances).toHaveLength(2);

  const find = await runCli(env, [
    "find",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--name",
    "connect",
  ]);
  expect(find.code).toBe(0);
  expect(JSON.parse(find.stdout).matches[0].path).toBe("/workspace/app/src/connect.js");

  const grep = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
  ]);
  expect(grep.code).toBe(0);
  expect(JSON.parse(grep.stdout).matches[0].line).toBe(2);

  const view = await runCli(env, [
    "view",
    ...targetArgs,
    "--file",
    "/workspace/app/src/connect.js",
    "--line",
    "2",
    "--context",
    "1",
  ]);
  expect(view.code).toBe(0);
  expect(JSON.parse(view.stdout).lines.map((line: { text: string }) => line.text)).toContain(
    "  return 'needle-api';",
  );
});

test("User can inspect candidates and aggregate all running instances", async () => {
  const paths = await prepareCase("inspect", scenario());
  const env = createEnv(paths);

  const inspect = await runCli(env, [
    "inspect-candidates",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
  ]);
  expect(inspect.code).toBe(0);
  expect(JSON.parse(inspect.stdout).suggestedBreakpoints[0].bp).toContain("connect.js");

  const all = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--all-instances",
  ]);
  expect(all.code).toBe(0);
  expect(JSON.parse(all.stdout).instances).toHaveLength(2);
});

test("User must confirm lifecycle commands that change app state", async () => {
  const paths = await prepareCase("lifecycle", scenario());
  const env = createEnv(paths);

  const blocked = await runCli(env, ["enable-ssh", ...targetArgs]);
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toContain("LIFECYCLE_CONFIRMATION_REQUIRED");

  const enabled = await runCli(env, ["enable-ssh", ...targetArgs, "--yes"]);
  expect(enabled.code).toBe(0);
  expect(JSON.parse(enabled.stdout).changed).toBe(true);

  const logs = await readLog(paths.logPath);
  expect(logs.map((entry) => entry.command)).toContain("enable-ssh");
});

test("User can reuse a persistent session through the broker", async () => {
  const paths = await prepareCase("session", scenario());
  const env = createEnv(paths);

  const started = await runCli(env, ["session", "start", ...targetArgs]);
  expect(started.code).toBe(0);
  const sessionId = JSON.parse(started.stdout).sessionId as string;

  const listed = await runCli(env, ["session", "list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).sessions[0].sessionId).toBe(sessionId);

  const roots = await runCli(env, ["session", "roots", "--session-id", sessionId]);
  expect(roots.code).toBe(0);
  expect(JSON.parse(roots.stdout).roots).toContain("/workspace/app");

  const list = await runCli(env, [
    "session",
    "ls",
    "--session-id",
    sessionId,
    "--path",
    "/workspace/app",
    "--timeout",
    "30",
    "--max-bytes",
    "1048576",
  ]);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).entries.map((entry: { name: string }) => entry.name)).toEqual(
    expect.arrayContaining(["README.md", "package.json", "src"]),
  );

  const grep = await runCli(env, [
    "session",
    "grep",
    "--session-id",
    sessionId,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--timeout",
    "30",
    "--max-bytes",
    "1048576",
  ]);
  expect(grep.code).toBe(0);
  expect(JSON.parse(grep.stdout).matches[0].path).toContain("connect.js");

  const rejected = await runCli(env, [
    "session",
    "grep",
    "--session-id",
    sessionId,
    "--root",
    "/workspace/app",
    "--text",
    "force-session-error",
  ]);
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("SESSION_PROTOCOL_ERROR");

  const recovered = await runCli(env, ["session", "roots", "--session-id", sessionId]);
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.stdout).roots).toContain("/workspace/app");

  const view = await runCli(env, [
    "session",
    "view",
    "--session-id",
    sessionId,
    "--file",
    "/workspace/app/src/connect.js",
    "--line",
    "2",
    "--timeout",
    "30",
    "--max-bytes",
    "1048576",
  ]);
  expect(view.code).toBe(0);
  expect(JSON.parse(view.stdout).lines.map((line: { text: string }) => line.text)).toContain(
    "  return 'needle-api';",
  );

  const stopped = await runCli(env, ["session", "stop", "--session-id", sessionId]);
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.stdout)).toEqual({ stopped: 1 });
});

test("User can tune persistent session timers", async () => {
  const paths = await prepareCase("session-timers", scenario());
  const env = createEnv(paths);

  const started = await runCli(env, [
    "session",
    "start",
    ...targetArgs,
    "--idle-timeout",
    "1",
    "--max-lifetime",
    "10",
  ]);
  expect(started.code).toBe(0);
  const sessionId = JSON.parse(started.stdout).sessionId as string;

  await expect.poll(async () => {
    const listed = await runCli(env, ["session", "list"]);
    expect(listed.code).toBe(0);
    return (JSON.parse(listed.stdout) as { readonly sessions: readonly unknown[] }).sessions.length;
  }, {
    intervals: [250, 500, 1_000],
    timeout: 5_000,
  }).toBe(0);

  const status = await runCli(env, ["session", "status", "--session-id", sessionId]);
  expect(status.code).not.toBe(0);
  expect(status.stderr).toContain("SESSION_NOT_FOUND");
});
