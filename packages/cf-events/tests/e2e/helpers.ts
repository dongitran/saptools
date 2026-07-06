import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface ScenarioApp {
  readonly guid: string;
  readonly app?: Record<string, unknown>;
  readonly sshEnabled?: Record<string, unknown>;
  readonly stats?: Record<string, unknown>;
  readonly events?: readonly Record<string, unknown>[];
}

export interface Scenario {
  readonly regionKey: string;
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly apps: Readonly<Record<string, ScenarioApp>>;
  readonly auditEventsError?: Record<string, unknown>;
}

export interface CasePaths {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly scenarioPath: string;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function fakeAuditEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "event-guid",
    type: "audit.app.start",
    created_at: "2026-05-22T10:00:00Z",
    updated_at: "2026-05-22T10:00:00Z",
    actor: { guid: "actor-1", type: "user", name: "alice@example.com" },
    target: { guid: "target-1", type: "app", name: "orders-srv" },
    data: {},
    space: { guid: "space-1" },
    organization: { guid: "org-1" },
    ...overrides,
  };
}

function buildStructure(scenario: Scenario): unknown {
  return {
    syncedAt: "2026-05-22T00:00:00.000Z",
    regions: [
      {
        key: scenario.regionKey,
        label: "Test region",
        apiEndpoint: scenario.apiEndpoint,
        accessible: true,
        orgs: [
          {
            name: scenario.org,
            spaces: [
              {
                name: scenario.space,
                apps: Object.keys(scenario.apps).map((name) => ({ name })),
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function prepareCase(
  rootName: string,
  caseName: string,
  scenario: Scenario,
): Promise<CasePaths> {
  const caseRoot = join(tmpdir(), rootName, caseName);
  const homeDir = join(caseRoot, "home");
  const scenarioPath = join(caseRoot, "scenario.json");
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(join(homeDir, ".saptools"), { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), "utf8");
  await writeFile(
    join(homeDir, ".saptools", "cf-structure.json"),
    JSON.stringify(buildStructure(scenario), null, 2),
    "utf8",
  );
  return { caseRoot, homeDir, scenarioPath };
}

export function createEnv(paths: CasePaths): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  return {
    ...env,
    HOME: paths.homeDir,
    SAP_EMAIL: "tester@example.com",
    SAP_PASSWORD: "test-password",
    CF_EVENTS_CF_BIN: FAKE_CF_BIN,
    CF_EVENTS_FAKE_SCENARIO: paths.scenarioPath,
  };
}

export async function runCli(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly message: string;
    };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message,
    };
  }
}

export async function runWatchCli(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  runMs: number,
): Promise<RunResult> {
  const child = spawn("node", [CLI_PATH, ...args], { env });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, runMs);
  });
  child.kill("SIGTERM");

  const code = await new Promise<number | null>((resolveCode) => {
    child.once("close", resolveCode);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
