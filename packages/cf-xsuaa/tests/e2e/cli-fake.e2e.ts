import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import type { XsuaaStore } from "../../src/types.js";

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const refArgs = ["--region", "ap10", "--org", "org", "--space", "space", "--app", "app"] as const;

interface ExecFileError extends Error {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | string;
}

interface FakeUaa {
  readonly url: string;
  readonly requestCount: () => number;
  readonly lastAuthorization: () => string | undefined;
  readonly close: () => Promise<void>;
}

interface CliContext {
  readonly home: string;
  readonly cfLog: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run: (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly cleanup: () => Promise<void>;
  readonly uaa: FakeUaa;
}

function normalizeOutput(output: string | Uint8Array): string {
  return typeof output === "string" ? output : Buffer.from(output).toString("utf8");
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolvePromise();
    });
  });
}

async function startFakeUaa(): Promise<FakeUaa> {
  let count = 0;
  let authorization: string | undefined;
  const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const server = createServer((req, res) => {
    count++;
    authorization = req.headers.authorization;
    if (req.method !== "POST" || req.url !== "/oauth/token") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: token, token_type: "bearer", expires_in: 3600 }));
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fake UAA server did not expose a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port.toString()}`,
    requestCount: () => count,
    lastAuthorization: () => authorization,
    close: async () => {
      await closeServer(server);
    },
  };
}

function fakeCfSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env["FAKE_CF_LOG"];
if (logPath) {
  appendFileSync(logPath, JSON.stringify(args) + "\\n");
}

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

if (args[0] === "api") {
  process.stdout.write("api ok\\n");
} else if (args[0] === "auth") {
  if (!args[1] || !args[2]) {
    fail("missing auth");
  }
  process.stdout.write("auth ok\\n");
} else if (args[0] === "target") {
  process.stdout.write("target ok\\n");
} else if (args[0] === "env") {
  const url = process.env["FAKE_UAA_URL"];
  if (!url) {
    fail("missing fake UAA URL");
  }
  process.stdout.write([
    "System-Provided:",
    "VCAP_SERVICES: " + JSON.stringify({
      xsuaa: [
        {
          name: "uaa-binding",
          credentials: {
            clientid: "client",
            clientsecret: "secret",
            url,
            xsappname: "app-name",
          },
        },
      ],
    }),
    "VCAP_APPLICATION: {}",
  ].join("\\n"));
} else {
  fail("unsupported cf command: " + args.join(" "));
}
`;
}

async function createCliContext(): Promise<CliContext> {
  const home = await mkdtemp(join(tmpdir(), "saptools-xsuaa-e2e-"));
  const cfPath = join(home, "fake-cf.mjs");
  const cfLog = join(home, "cf-calls.log");
  const uaa = await startFakeUaa();
  await writeFile(cfPath, fakeCfSource(), "utf8");
  await chmod(cfPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CF_SYNC_CF_BIN: cfPath,
    FAKE_CF_LOG: cfLog,
    FAKE_UAA_URL: uaa.url,
    HOME: home,
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "password",
  };

  return {
    home,
    cfLog,
    env,
    run: async (args) => {
      const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], { env, timeout: 60_000 });
      return {
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(stderr),
      };
    },
    cleanup: async () => {
      await uaa.close();
      await rm(home, { recursive: true, force: true });
    },
    uaa,
  };
}

async function readStore(home: string): Promise<XsuaaStore> {
  const raw = await readFile(join(home, ".saptools", "xsuaa-data.json"), "utf8");
  return JSON.parse(raw) as XsuaaStore;
}

async function readCfCalls(path: string): Promise<readonly (readonly string[])[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as readonly string[]);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function expectFailure(ctx: CliContext, args: readonly string[]): Promise<ExecFileError> {
  try {
    await ctx.run(args);
  } catch (err: unknown) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected CLI command to fail");
}

test.describe("fake-backed CLI workflow", () => {
  test("shows help without requiring CF credentials", async () => {
    const ctx = await createCliContext();
    try {
      const { stdout } = await ctx.run(["--help"]);
      expect(stdout).toContain("fetch-secret");
      expect(stdout).toContain("get-token");
      expect(await readCfCalls(ctx.cfLog)).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("fetch-secret stores credentials and does not print the client secret", async () => {
    const ctx = await createCliContext();
    try {
      const { stdout } = await ctx.run(["fetch-secret", ...refArgs]);
      const store = await readStore(ctx.home);

      expect(stdout).toContain("Secret stored");
      expect(stdout).toContain("client");
      expect(stdout).not.toContain("secret");
      expect(store.entries[0]?.credentials).toMatchObject({
        clientId: "client",
        clientSecret: "secret",
        url: ctx.uaa.url,
      });
      expect(await readCfCalls(ctx.cfLog)).toEqual([
        ["api", "https://api.cf.ap10.hana.ondemand.com"],
        ["auth", "user@example.com", "password"],
        ["target", "-o", "org", "-s", "space"],
        ["env", "app"],
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("get-token auto-fetches a cold secret and stores token metadata", async () => {
    const ctx = await createCliContext();
    try {
      const { stdout } = await ctx.run(["get-token", ...refArgs]);
      const token = stdout.trim();
      const store = await readStore(ctx.home);

      expect(token.split(".")).toHaveLength(3);
      expect(store.entries[0]?.token?.accessToken).toBe(token);
      expect(store.entries[0]?.token?.expiresAt).toMatch(/T/);
      expect(ctx.uaa.requestCount()).toBe(1);
      expect(ctx.uaa.lastAuthorization()).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
    } finally {
      await ctx.cleanup();
    }
  });

  test("get-token-cached reuses a valid token without calling CF or UAA again", async () => {
    const ctx = await createCliContext();
    try {
      const first = await ctx.run(["get-token-cached", ...refArgs]);
      const callsAfterFirst = await readCfCalls(ctx.cfLog);
      const second = await ctx.run(["get-token-cached", ...refArgs]);
      const callsAfterSecond = await readCfCalls(ctx.cfLog);

      expect(first.stdout.trim()).toBeTruthy();
      expect(second.stdout.trim()).toBe(first.stdout.trim());
      expect(ctx.uaa.requestCount()).toBe(1);
      expect(callsAfterSecond).toEqual(callsAfterFirst);
    } finally {
      await ctx.cleanup();
    }
  });

  test("invalid region fails before invoking CF", async () => {
    const ctx = await createCliContext();
    try {
      const error = await expectFailure(ctx, [
        "fetch-secret",
        "--region",
        "invalid",
        "--org",
        "org",
        "--space",
        "space",
        "--app",
        "app",
      ]);

      expect(error.stderr).toContain("Unknown region");
      expect(await readCfCalls(ctx.cfLog)).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  test("missing required app option fails before invoking CF", async () => {
    const ctx = await createCliContext();
    try {
      const error = await expectFailure(ctx, [
        "fetch-secret",
        "--region",
        "ap10",
        "--org",
        "org",
        "--space",
        "space",
      ]);

      expect(error.stderr).toContain("required option");
      expect(error.stderr).toContain("--app");
      expect(await readCfCalls(ctx.cfLog)).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });
});
