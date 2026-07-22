import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  PACKAGE_DIR,
  type RunResult,
  type Scenario,
  createEnv,
  prepareCase,
  readLog,
  runCli,
  targetFakeCf,
} from "./helpers.js";

const DEFAULT_FILES: Record<string, string> = {
  "/workspace/app/package.json": "{\"name\":\"demo-app\"}\n",
  "/workspace/app/src/connect.js": [
    "function ping() {",
    "  return 'needle-api';",
    "}",
    "",
  ].join("\n"),
  "/workspace/app/src/other.ts": "export const value = 'needle-api';\n",
  "/workspace/app/README.md": "readme-only\n",
};

const TRUNCATION_WARNING =
  "Warning: Results may be incomplete; increase --max-files, --max-matches, or --max-bytes and retry.\n";

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

interface OutputFlagCase {
  readonly label: string;
  readonly helpArgs: readonly string[];
  readonly runArgs: readonly string[];
}

const outputFlagCases: readonly OutputFlagCase[] = [
  { label: "roots", helpArgs: ["roots"], runArgs: ["roots", ...targetArgs] },
  { label: "instances", helpArgs: ["instances"], runArgs: ["instances", ...targetArgs] },
  {
    label: "ls",
    helpArgs: ["ls"],
    runArgs: ["ls", ...targetArgs, "--path", "/workspace/app"],
  },
  {
    label: "find",
    helpArgs: ["find"],
    runArgs: ["find", ...targetArgs, "--root", "/workspace/app", "--name", "connect"],
  },
  {
    label: "grep",
    helpArgs: ["grep"],
    runArgs: ["grep", ...targetArgs, "--root", "/workspace/app", "--text", "needle-api"],
  },
  {
    label: "view",
    helpArgs: ["view"],
    runArgs: ["view", ...targetArgs, "--file", "/workspace/app/src/connect.js", "--line", "2"],
  },
  {
    label: "inspect-candidates",
    helpArgs: ["inspect-candidates"],
    runArgs: ["inspect-candidates", ...targetArgs, "--text", "needle-api"],
  },
  {
    label: "session start",
    helpArgs: ["session", "start"],
    runArgs: ["session", "start", ...targetArgs],
  },
  { label: "session list", helpArgs: ["session", "list"], runArgs: ["session", "list"] },
  {
    label: "session status",
    helpArgs: ["session", "status"],
    runArgs: ["session", "status", "--session-id", "missing"],
  },
  {
    label: "session stop",
    helpArgs: ["session", "stop"],
    runArgs: ["session", "stop", "--all"],
  },
  {
    label: "session roots",
    helpArgs: ["session", "roots"],
    runArgs: ["session", "roots", "--session-id", "missing"],
  },
  {
    label: "session ls",
    helpArgs: ["session", "ls"],
    runArgs: ["session", "ls", "--session-id", "missing", "--path", "/workspace/app"],
  },
  {
    label: "session find",
    helpArgs: ["session", "find"],
    runArgs: [
      "session",
      "find",
      "--session-id",
      "missing",
      "--root",
      "/workspace/app",
      "--name",
      "connect",
    ],
  },
  {
    label: "session grep",
    helpArgs: ["session", "grep"],
    runArgs: [
      "session",
      "grep",
      "--session-id",
      "missing",
      "--root",
      "/workspace/app",
      "--text",
      "needle-api",
    ],
  },
  {
    label: "session view",
    helpArgs: ["session", "view"],
    runArgs: [
      "session",
      "view",
      "--session-id",
      "missing",
      "--file",
      "/workspace/app/src/connect.js",
      "--line",
      "2",
    ],
  },
  {
    label: "session inspect-candidates",
    helpArgs: ["session", "inspect-candidates"],
    runArgs: ["session", "inspect-candidates", "--session-id", "missing", "--text", "needle-api"],
  },
];

function scenario(files: Record<string, string> = DEFAULT_FILES): Scenario {
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
                    files,
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

function limitScenario(): Scenario {
  return scenario({
    ...DEFAULT_FILES,
    "/workspace/app/src/third.js": "export const third = 'needle-api';\n",
    "/opt/app/package.json": "{\"name\":\"secondary-app\"}\n",
  });
}

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

function sessionIdFrom(result: RunResult): string {
  const sessionId = /^sessionId:\s*(\S+)/m.exec(result.stdout)?.[1];
  expect(sessionId).toBeTruthy();
  if (sessionId === undefined) {
    throw new Error("Session start output did not contain a session id.");
  }
  return sessionId;
}

function expectCapped(result: RunResult): void {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe(TRUNCATION_WARNING);
}

function expectUncapped(result: RunResult): void {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
}

test("User can inspect the installed CLI version", async () => {
  const version = await readPackageVersion();

  const result = await runCli(process.env, ["--version"]);

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(version);
});

for (const outputFlagCase of outputFlagCases) {
  test(`${outputFlagCase.label} exposes only human output`, async () => {
    const help = await runCli(process.env, [...outputFlagCase.helpArgs, "--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).not.toContain("--json");
    expect(help.stdout).not.toContain("--no-json");

    for (const removedFlag of ["--json", "--no-json"] as const) {
      const rejected = await runCli(process.env, [...outputFlagCase.runArgs, removedFlag]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(`error: unknown option '${removedFlag}'`);
    }
  });
}

test("User can discover roots, instances, files, content, and line context", async () => {
  const paths = await prepareCase("discovery", scenario());
  const env = createEnv(paths);

  const roots = await runCli(env, ["roots", ...targetArgs]);
  expectUncapped(roots);
  expect(roots.stdout).toBe("/workspace/app\n");

  const list = await runCli(env, ["ls", ...targetArgs, "--path", "/workspace/app"]);
  expectUncapped(list);
  expect(list.stdout).toBe([
    "#0\t[file]\tpackage.json\t/workspace/app/package.json",
    "#0\t[file]\tREADME.md\t/workspace/app/README.md",
    "#0\t[directory]\tsrc\t/workspace/app/src",
    "",
  ].join("\n"));

  const filteredList = await runCli(env, [
    "ls",
    ...targetArgs,
    "--path",
    "/workspace/app",
    "--pattern",
    "*json",
  ]);
  expectUncapped(filteredList);
  expect(filteredList.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const instances = await runCli(env, ["instances", ...targetArgs]);
  expectUncapped(instances);
  expect(instances.stdout).toBe("#0\trunning\ttoday\n#1\trunning\ttoday\n");

  const find = await runCli(env, [
    "find",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--name",
    "connect",
  ]);
  expectUncapped(find);
  expect(find.stdout).toBe("#0\t/workspace/app/src/connect.js[file]\n");

  const grep = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-matches",
    "10",
    "--include-files",
    "--follow-symlinks",
  ]);
  expectUncapped(grep);
  expect(grep.stdout).toBe([
    "#0\t/workspace/app/src/connect.js:2",
    "#0\t/workspace/app/src/other.ts:1",
    "",
  ].join("\n"));

  const view = await runCli(env, [
    "view",
    ...targetArgs,
    "--file",
    "/workspace/app/src/connect.js",
    "--line",
    "2",
    "--context",
    "140",
  ]);
  expectUncapped(view);
  expect(view.stdout).toBe([
    "# /workspace/app/src/connect.js",
    "    1  function ping() {",
    "    2    return 'needle-api';",
    "    3  }",
    "    4  ",
    "",
  ].join("\n"));
});

test("User can discover roots from the current CF target", async () => {
  const paths = await prepareCase("current-target", scenario());
  const env = createEnv(paths);
  await targetFakeCf(env, "https://api.cf.ap10.hana.ondemand.com", "demo-org", "dev");

  const roots = await runCli(env, ["roots", "--app", "demo-app"]);

  expectUncapped(roots);
  expect(roots.stdout).toBe("/workspace/app\n");
});

test("User can inspect compact candidates and explicit instances", async () => {
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
  expectUncapped(inspect);
  expect(inspect.stdout).toBe([
    "Roots:",
    "  /workspace/app",
    "",
    "Matches:",
    "  /workspace/app/src/connect.js:2",
    "  /workspace/app/src/other.ts:1",
    "",
    "Suggested breakpoints:",
    "  [high] /workspace/app/src/connect.js:2",
    "  [medium] /workspace/app/src/other.ts:1",
    "",
  ].join("\n"));

  const explicit = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--instance",
    "1",
  ]);
  expectUncapped(explicit);
  expect(explicit.stdout).toBe([
    "#1\t/workspace/app/src/connect.js:2",
    "#1\t/workspace/app/src/other.ts:1",
    "",
  ].join("\n"));
});

test("SSH-backed commands automatically enable SSH when needed", async () => {
  const paths = await prepareCase("auto-ssh", scenario());
  const env = createEnv(paths);

  const roots = await runCli(env, ["roots", ...targetArgs]);
  expectUncapped(roots);
  expect(roots.stdout).toBe("/workspace/app\n");

  const logs = await readLog(paths.logPath);
  expect(logs.map((entry) => entry.command)).toEqual(
    expect.arrayContaining(["ssh-enabled", "enable-ssh", "restart", "ssh"]),
  );
});

test("Lifecycle commands are not exposed by the CLI", async () => {
  const paths = await prepareCase("lifecycle-hidden", scenario());
  const env = createEnv(paths);

  const blocked = await runCli(env, ["enable-ssh", ...targetArgs, "--yes"]);
  expect(blocked.code).not.toBe(0);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr).toContain("unknown command");
});

test("User can reuse every persistent session command through the broker", async () => {
  const paths = await prepareCase("session", scenario());
  const env = createEnv(paths);

  const started = await runCli(env, ["session", "start", ...targetArgs]);
  expectUncapped(started);
  expect(started.stdout).toMatch(
    /^sessionId: \S+\nstatus: ready\nbrokerPid: \d+\nsocketPath: \S+\n$/,
  );
  const sessionId = sessionIdFrom(started);

  const listed = await runCli(env, ["session", "list"]);
  expectUncapped(listed);
  expect(listed.stdout).toBe(`${sessionId}\tready\tdemo-app\n`);

  const status = await runCli(env, ["session", "status", "--session-id", sessionId]);
  expectUncapped(status);
  expect(status.stdout).toBe([
    `sessionId: ${sessionId}`,
    "status: ready",
    "brokerAlive: true",
    "sshAlive: true",
    "socketAlive: true",
    "",
  ].join("\n"));

  const roots = await runCli(env, ["session", "roots", "--session-id", sessionId]);
  expectUncapped(roots);
  expect(roots.stdout).toBe("/workspace/app\n");

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
    "--pattern",
    "*json",
  ]);
  expectUncapped(list);
  expect(list.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const find = await runCli(env, [
    "session",
    "find",
    "--session-id",
    sessionId,
    "--root",
    "/workspace/app",
    "--name",
    "connect",
  ]);
  expectUncapped(find);
  expect(find.stdout).toBe("#0\t/workspace/app/src/connect.js[file]\n");

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
    "--max-matches",
    "10",
    "--include-files",
    "--follow-symlinks",
  ]);
  expectUncapped(grep);
  expect(grep.stdout).toBe([
    "#0\t/workspace/app/src/connect.js:2",
    "#0\t/workspace/app/src/other.ts:1",
    "",
  ].join("\n"));

  const view = await runCli(env, [
    "session",
    "view",
    "--session-id",
    sessionId,
    "--file",
    "/workspace/app/src/connect.js",
    "--line",
    "2",
    "--context",
    "1",
  ]);
  expectUncapped(view);
  expect(view.stdout).toBe([
    "# /workspace/app/src/connect.js",
    "    1  function ping() {",
    "    2    return 'needle-api';",
    "    3  }",
    "",
  ].join("\n"));

  const inspect = await runCli(env, [
    "session",
    "inspect-candidates",
    "--session-id",
    sessionId,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
  ]);
  expectUncapped(inspect);
  expect(inspect.stdout).toContain("Roots:\n  /workspace/app\n\nMatches:");
  expect(inspect.stdout).toContain("Suggested breakpoints:\n  [high] /workspace/app/src/connect.js:2");

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
  expect(rejected.stdout).toBe("");
  expect(rejected.stderr).toContain("SESSION_PROTOCOL_ERROR");

  const recovered = await runCli(env, ["session", "roots", "--session-id", sessionId]);
  expectUncapped(recovered);
  expect(recovered.stdout).toBe("/workspace/app\n");

  const stopped = await runCli(env, ["session", "stop", "--session-id", sessionId]);
  expectUncapped(stopped);
  expect(stopped.stdout).toBe("stopped: 1\n");
});

test("One-shot discovery distinguishes capped and uncapped result windows", async () => {
  const paths = await prepareCase("one-shot-limits", limitScenario());
  const env = createEnv(paths);

  const cappedRoots = await runCli(env, ["roots", ...targetArgs, "--max-files", "1"]);
  expectCapped(cappedRoots);
  expect(cappedRoots.stdout).toBe("/opt/app\n");

  const uncappedRoots = await runCli(env, ["roots", ...targetArgs, "--max-files", "10000"]);
  expectUncapped(uncappedRoots);
  expect(uncappedRoots.stdout).toBe("/opt/app\n/workspace/app\n");

  const cappedLs = await runCli(env, [
    "ls",
    ...targetArgs,
    "--path",
    "/workspace/app",
    "--max-files",
    "1",
  ]);
  expectCapped(cappedLs);
  expect(cappedLs.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const uncappedFilteredLs = await runCli(env, [
    "ls",
    ...targetArgs,
    "--path",
    "/workspace/app",
    "--pattern",
    "*json",
    "--max-files",
    "1",
  ]);
  expectUncapped(uncappedFilteredLs);
  expect(uncappedFilteredLs.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const cappedFind = await runCli(env, [
    "find",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--name",
    "*",
    "--max-files",
    "1",
  ]);
  expectCapped(cappedFind);
  expect(cappedFind.stdout).toBe("#0\t/workspace/app/package.json[file]\n");

  const uncappedFind = await runCli(env, [
    "find",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--name",
    "connect",
    "--max-files",
    "10",
  ]);
  expectUncapped(uncappedFind);
  expect(uncappedFind.stdout).toBe("#0\t/workspace/app/src/connect.js[file]\n");

  const cappedGrep = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-matches",
    "1",
  ]);
  expectCapped(cappedGrep);
  expect(cappedGrep.stdout).toBe("#0\t/workspace/app/src/connect.js:2\n");

  const uncappedGrep = await runCli(env, [
    "grep",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "readme-only",
    "--max-matches",
    "10",
  ]);
  expectUncapped(uncappedGrep);
  expect(uncappedGrep.stdout).toBe("#0\t/workspace/app/README.md:1\n");

  const cappedDynamicInspect = await runCli(env, [
    "inspect-candidates",
    ...targetArgs,
    "--text",
    "needle-api",
    "--max-files",
    "1",
    "--max-matches",
    "10",
  ]);
  expectCapped(cappedDynamicInspect);
  expect(cappedDynamicInspect.stdout).toContain("Roots:\n  /opt/app");

  const cappedExplicitInspect = await runCli(env, [
    "inspect-candidates",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-files",
    "10",
    "--max-matches",
    "1",
  ]);
  expectCapped(cappedExplicitInspect);
  expect(cappedExplicitInspect.stdout).toContain("Matches:\n  /workspace/app/src/connect.js:2");
  expect(cappedExplicitInspect.stdout).not.toContain("other.ts");

  const uncappedInspect = await runCli(env, [
    "inspect-candidates",
    ...targetArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-files",
    "10",
    "--max-matches",
    "10",
  ]);
  expectUncapped(uncappedInspect);
  expect(uncappedInspect.stdout).toContain("  /workspace/app/src/third.js:1");
});

test("Persistent discovery distinguishes capped and uncapped result windows", async () => {
  const paths = await prepareCase("session-limits", limitScenario());
  const env = createEnv(paths);

  const started = await runCli(env, ["session", "start", ...targetArgs]);
  expectUncapped(started);
  const sessionId = sessionIdFrom(started);
  const sessionArgs = ["--session-id", sessionId] as const;

  const cappedRoots = await runCli(env, ["session", "roots", ...sessionArgs, "--max-files", "1"]);
  expectCapped(cappedRoots);
  expect(cappedRoots.stdout).toBe("/opt/app\n");

  const uncappedRoots = await runCli(env, ["session", "roots", ...sessionArgs, "--max-files", "10000"]);
  expectUncapped(uncappedRoots);
  expect(uncappedRoots.stdout).toBe("/opt/app\n/workspace/app\n");

  const cappedLs = await runCli(env, [
    "session",
    "ls",
    ...sessionArgs,
    "--path",
    "/workspace/app",
    "--max-files",
    "1",
  ]);
  expectCapped(cappedLs);
  expect(cappedLs.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const uncappedFilteredLs = await runCli(env, [
    "session",
    "ls",
    ...sessionArgs,
    "--path",
    "/workspace/app",
    "--pattern",
    "*json",
    "--max-files",
    "1",
  ]);
  expectUncapped(uncappedFilteredLs);
  expect(uncappedFilteredLs.stdout).toBe("#0\t[file]\tpackage.json\t/workspace/app/package.json\n");

  const cappedFind = await runCli(env, [
    "session",
    "find",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--name",
    "*",
    "--max-files",
    "1",
  ]);
  expectCapped(cappedFind);
  expect(cappedFind.stdout).toBe("#0\t/workspace/app/package.json[file]\n");

  const uncappedFind = await runCli(env, [
    "session",
    "find",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--name",
    "connect",
    "--max-files",
    "10",
  ]);
  expectUncapped(uncappedFind);
  expect(uncappedFind.stdout).toBe("#0\t/workspace/app/src/connect.js[file]\n");

  const cappedGrep = await runCli(env, [
    "session",
    "grep",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-matches",
    "1",
  ]);
  expectCapped(cappedGrep);
  expect(cappedGrep.stdout).toBe("#0\t/workspace/app/src/connect.js:2\n");

  const uncappedGrep = await runCli(env, [
    "session",
    "grep",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--text",
    "readme-only",
    "--max-matches",
    "10",
  ]);
  expectUncapped(uncappedGrep);
  expect(uncappedGrep.stdout).toBe("#0\t/workspace/app/README.md:1\n");

  const cappedDynamicInspect = await runCli(env, [
    "session",
    "inspect-candidates",
    ...sessionArgs,
    "--text",
    "needle-api",
    "--max-files",
    "1",
    "--max-matches",
    "10",
  ]);
  expectCapped(cappedDynamicInspect);
  expect(cappedDynamicInspect.stdout).toContain("Roots:\n  /opt/app");

  const cappedExplicitInspect = await runCli(env, [
    "session",
    "inspect-candidates",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-files",
    "10",
    "--max-matches",
    "1",
  ]);
  expectCapped(cappedExplicitInspect);
  expect(cappedExplicitInspect.stdout).toContain("Matches:\n  /workspace/app/src/connect.js:2");
  expect(cappedExplicitInspect.stdout).not.toContain("other.ts");

  const uncappedInspect = await runCli(env, [
    "session",
    "inspect-candidates",
    ...sessionArgs,
    "--root",
    "/workspace/app",
    "--text",
    "needle-api",
    "--max-files",
    "10",
    "--max-matches",
    "10",
  ]);
  expectUncapped(uncappedInspect);
  expect(uncappedInspect.stdout).toContain("  /workspace/app/src/third.js:1");

  const stopped = await runCli(env, ["session", "stop", "--session-id", sessionId]);
  expectUncapped(stopped);
  expect(stopped.stdout).toBe("stopped: 1\n");
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
  expectUncapped(started);
  const sessionId = sessionIdFrom(started);

  await expect.poll(async () => {
    const listed = await runCli(env, ["session", "list"]);
    expectUncapped(listed);
    return listed.stdout;
  }, {
    intervals: [250, 500, 1_000],
    timeout: 5_000,
  }).toBe("No persistent sessions.\n");

  const status = await runCli(env, ["session", "status", "--session-id", sessionId]);
  expect(status.code).not.toBe(0);
  expect(status.stdout).toBe("");
  expect(status.stderr).toContain("SESSION_NOT_FOUND");
});
