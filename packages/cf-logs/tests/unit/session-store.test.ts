import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendCompactSessionRows,
  clearCompactSessions,
  createCompactSession,
  formatCompactRowRef,
  listCompactSessions,
  parseCompactRowRef,
  pruneExpiredCompactSessions,
  readCompactSessionRef,
} from "../../src/session-store.js";
import type { ParsedLogRow } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
  tempDirs.length = 0;
});

async function makeSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cf-logs-sessions-"));
  tempDirs.push(dir);
  return dir;
}

function createRow(id: number, message: string): ParsedLogRow {
  return {
    id,
    timestamp: "09:00:00",
    timestampRaw: "2026-04-12T09:00:00.00+0700",
    source: "APP/PROC/WEB/0",
    stream: "OUT",
    format: "text",
    level: "info",
    logger: "unit.service",
    component: "",
    org: "",
    space: "",
    host: "app",
    method: "",
    request: message,
    status: "",
    latency: "",
    tenant: "",
    clientIp: "",
    requestId: "",
    message,
    rawBody: message,
    jsonPayload: null,
    searchableText: message.toLowerCase(),
  };
}

describe("compact session store", () => {
  it("formats and parses row refs", () => {
    const ref = formatCompactRowRef("abc123ef", 42);

    expect(ref).toBe("abc123ef:42");
    expect(parseCompactRowRef(ref)).toEqual({ sessionId: "abc123ef", rowId: 42 });
    expect(() => parseCompactRowRef("bad-ref")).toThrow("Invalid log row ref.");
  });

  it("creates a session and reads a full row by ref", async () => {
    const sessionsDir = await makeSessionsDir();
    const session = await createCompactSession({
      sessionsDir,
      sessionId: "abc123ef",
      now: () => new Date("2026-04-12T00:00:00.000Z"),
      rows: [createRow(1, "full body content")],
      target: {
        apiEndpoint: "https://api.example.test",
        org: "neutral-org",
        space: "dev",
        app: "neutral-app",
      },
    });

    const result = await readCompactSessionRef("abc123ef:1", {
      sessionsDir,
      now: () => new Date("2026-04-12T00:30:00.000Z"),
    });

    expect(session.expiresAt).toBe("2026-04-12T01:00:00.000Z");
    expect(result.row.message).toBe("full body content");
    expect(result.session.target?.app).toBe("neutral-app");
  });

  it("appends rows, bounds saved rows, and prunes expired sessions", async () => {
    const sessionsDir = await makeSessionsDir();
    await createCompactSession({
      sessionsDir,
      sessionId: "abc123ef",
      now: () => new Date("2026-04-12T00:00:00.000Z"),
      ttlMinutes: 60,
      rows: [createRow(1, "first")],
    });

    await appendCompactSessionRows({
      sessionsDir,
      sessionId: "abc123ef",
      now: () => new Date("2026-04-12T00:10:00.000Z"),
      logLimit: 2,
      rows: [createRow(2, "second"), createRow(3, "third")],
    });

    const activeSessions = await listCompactSessions({
      sessionsDir,
      now: () => new Date("2026-04-12T00:20:00.000Z"),
    });
    expect(activeSessions).toEqual([
      expect.objectContaining({ sessionId: "abc123ef", rowCount: 2 }),
    ]);
    await expect(
      readCompactSessionRef("abc123ef:1", {
        sessionsDir,
        now: () => new Date("2026-04-12T00:20:00.000Z"),
      }),
    ).rejects.toThrow("Saved log row not found or expired.");

    const pruned = await pruneExpiredCompactSessions({
      sessionsDir,
      now: () => new Date("2026-04-12T01:11:00.000Z"),
    });
    expect(pruned).toBe(1);
    expect(await listCompactSessions({ sessionsDir })).toEqual([]);
  });

  it("clears every compact session", async () => {
    const sessionsDir = await makeSessionsDir();
    await createCompactSession({ sessionsDir, sessionId: "abc123ef", rows: [createRow(1, "one")] });
    await createCompactSession({ sessionsDir, sessionId: "def456ab", rows: [createRow(2, "two")] });

    const removed = await clearCompactSessions({ sessionsDir });

    expect(removed).toBe(2);
    expect(await listCompactSessions({ sessionsDir })).toEqual([]);
  });

  it("prunes malformed session files without listing them", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeFile(join(sessionsDir, "abc123ef.json"), "{\"version\":2}\n", "utf8");

    const removed = await pruneExpiredCompactSessions({ sessionsDir });

    expect(removed).toBe(1);
    expect(await listCompactSessions({ sessionsDir })).toEqual([]);
  });
});
