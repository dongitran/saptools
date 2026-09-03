import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
});

test.afterAll(async () => {
  await fakeOpenSearch.close();
});

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

test("sample dumps full unfiltered documents end to end", async () => {
  const result = await runCli(["sample", "--service", "service-b", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const docs: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(docs[0]).toMatchObject({ traceId: "trace-findable", serviceName: "service-b" });
});

test("find locates a trace by service and name pattern end to end", async () => {
  const result = await runCli(
    ["find", "--service", "service-b", "--name", "*SyncBatchAction*", "--format", "json", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(rows[0]).toMatchObject({ TRACE_ID: "trace-findable" });
});

test("mapping reports a real keyword field's type end to end", async () => {
  const result = await runCli(["mapping", "--field", "serviceName", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ FIELD: "serviceName", TYPE: "keyword", IGNORE_ABOVE: 256 }]);
});

test("prints the resolved-target notice to stderr for an explicit target", async () => {
  const result = await runCli(["count", "--service", "service-b", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("cf-otel: target eu10/example-org/space-demo (explicit)");
});

test("fails clearly with a non-zero exit code on an invalid --format", async () => {
  const result = await runCli(["find", "--service", "service-b", "--format", "yaml", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Invalid --format");
});

test("--save then result show round-trips the exact same rows end to end", async () => {
  // CF_OTEL_RESULTS_ROOT keeps this test from touching the real ~/.saptools
  // directory (mirrors CF_OTEL_CF_BIN's test-only override for the cf binary).
  const resultsRoot = await mkdtemp(join(tmpdir(), "cf-otel-results-"));
  try {
    const saveEnv = { ...env(), CF_OTEL_RESULTS_ROOT: resultsRoot };
    const saved = await runCli(["find", "--service", "service-b", "--format", "json", "--save", ...targetArgs()], saveEnv);
    expect(saved.exitCode).toBe(0);
    const ref = saved.stdout.trim().replace(/^ref=/, "");
    expect(ref).toMatch(/^[0-9a-f]{8}$/);

    const shown = await runCli(["result", "show", ref, "--format", "json"], saveEnv);
    expect(shown.exitCode).toBe(0);
    const rows: readonly Record<string, unknown>[] = JSON.parse(shown.stdout);
    expect(rows[0]).toMatchObject({ TRACE_ID: "trace-findable" });

    const listed = await runCli(["result", "list"], saveEnv);
    expect(listed.stdout).toContain(ref);

    const cleared = await runCli(["result", "clear"], saveEnv);
    expect(cleared.stdout.trim()).toBe("removed=1");
  } finally {
    await rm(resultsRoot, { recursive: true, force: true });
  }
});

/**
 * A server that accepts the connection and then never answers — the exact
 * failure `CF_OTEL_HTTP_TIMEOUT_MS` exists for, and one that no mock inside
 * the process can reproduce faithfully.
 */
async function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(() => {
    // Deliberately never responds.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

test("rejects a free-text --since with a message naming the flag, not a bare RangeError", async () => {
  const result = await runCli(["count", "--since", "yesterday", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('cf-otel: --since "yesterday" is not a valid time bound');
  expect(result.stderr).toContain("units s, m, h, d");
});

test("rejects a relative --since too large to resolve, which used to surface as 'Invalid time value'", async () => {
  const result = await runCli(["count", "--since", "999999999d", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--since");
  expect(result.stderr).toContain("smaller relative duration");
  expect(result.stderr).not.toContain("Invalid time value");
});

test("rejects a calendar date OpenSearch would refuse", async () => {
  const result = await runCli(["count", "--since", "2026-02-30", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not a real calendar date");
  expect(result.stderr).toContain("has 28 days");
});

test("rejects a swapped --since/--until range instead of reporting an empty result", async () => {
  const result = await runCli(["count", "--since", "1h", "--until", "2h", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("is after --until");
  expect(result.stdout).not.toContain("0");
});

test("fails a malformed --since without invoking cf at all, so it costs no login", async () => {
  const traceFile = join(tmpdir(), `cf-otel-since-early-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(
      ["count", "--since", "garbage", ...targetArgs()],
      { ...env(), CF_OTEL_FAKE_CF_TRACE_FILE: traceFile },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not a valid time bound");
    // The query is normally built inside withOpenSearchClient, i.e. after a
    // real `cf api`/`cf auth`/`cf services` sequence. An empty trace proves
    // the bound is now checked before any of that runs.
    await expect(readFile(traceFile, "utf8")).rejects.toThrow();
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("accepts a valid --since/--until pair end to end", async () => {
  const result = await runCli(
    ["count", "--since", "30d", "--until", "1s", "--format", "json", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
});

test("rejects an unknown spans --fields name instead of printing empty rows", async () => {
  const result = await runCli(["spans", "trace-small", "--fields", "duration", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('unknown field "duration"');
  expect(result.stderr).toContain("durationInNanos");
  expect(result.stdout).toBe("");
});

/**
 * Sends the response headers immediately and then stalls mid-payload. This is
 * where a deadline actually lands on a wide aggregation, and it is a different
 * code path from a request that never answers at all: the abort surfaces on the
 * body read, not on `fetch`.
 */
async function startStalledBodyServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"count":');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

test("names the timeout when it fires while the response body is still streaming", async () => {
  const stalled = await startStalledBodyServer();
  try {
    const result = await runCli(
      ["count", "--since", "1h", "--format", "json", ...targetArgs()],
      { ...env(), CF_OTEL_FAKE_DASHBOARDS_URL: stalled.url, CF_OTEL_HTTP_TIMEOUT_MS: "1500" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("timed out after 1500ms");
    expect(result.stderr).toContain("CF_OTEL_HTTP_TIMEOUT_MS");
    // The bare abort message is what escaped before the body read was wrapped.
    expect(result.stderr).not.toMatch(/^cf-otel: The operation was aborted/m);
  } finally {
    await stalled.close();
  }
});

test("ignores a malformed CF_OTEL_HTTP_TIMEOUT_MS instead of failing the query", async () => {
  const result = await runCli(
    ["count", "--since", "1h", "--format", "json", ...targetArgs()],
    { ...env(), CF_OTEL_HTTP_TIMEOUT_MS: "1.5" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("out of range");
});

test("rejects a February 30th that Date.parse would roll into March", async () => {
  const result = await runCli(["count", "--since", "2026-02-30", ...targetArgs()], env());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("month 02 of 2026 has 28 days");
});

test("accepts a real leap-year February 29th", async () => {
  const result = await runCli(["count", "--since", "2024-02-29", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
});

test("times out a Dashboards endpoint that never answers instead of hanging forever", async () => {
  const hanging = await startHangingServer();
  try {
    const result = await runCli(
      ["count", "--format", "json", ...targetArgs()],
      { ...env(), CF_OTEL_FAKE_DASHBOARDS_URL: hanging.url, CF_OTEL_HTTP_TIMEOUT_MS: "1500" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("timed out after 1500ms");
    expect(result.stderr).toContain("CF_OTEL_HTTP_TIMEOUT_MS");
  } finally {
    await hanging.close();
  }
});
