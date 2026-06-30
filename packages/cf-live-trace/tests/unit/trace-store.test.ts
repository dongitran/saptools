import { randomUUID } from "node:crypto";
import { readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTraceSession,
  listTraceEvents,
  listTraceSessions,
  pruneTraceSessions,
  readTraceEvent,
  visitTraceEvents,
  writeTraceEvent,
} from "../../src/trace-store.js";
import type { CfLiveTraceTarget, LiveTraceEvent } from "../../src/types.js";

describe("trace store", () => {
  it("writes each event as a private per-request JSON file without target credentials", async () => {
    const root = join(tmpdir(), `cf-live-trace-store-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const now = new Date("2026-06-30T01:00:00.000Z");
    const session = await createTraceSession(
      { target: createTarget() },
      { saptoolsRoot, now: () => now, sessionId: "s12345678" },
    );

    try {
      const record = await writeTraceEvent(session, createEvent(), {
        now: () => now,
        requestId: () => "r12345678",
      });
      const stored = await readTraceEvent("s12345678", "r12345678", { saptoolsRoot, now: () => now });
      const raw = await readFile(record.backupPath, "utf8");
      const directoryMode = (await stat(session.directory)).mode & 0o777;
      const fileMode = (await stat(record.backupPath)).mode & 0o777;

      expect(record.expiresAt).toBe("2026-06-30T03:00:00.000Z");
      expect(record.backupPath).toContain("ap10-sample-org-dev-orders-api-s12345678-r12345678-20260630T010000000Z.json");
      expect(stored.requestId).toBe("r12345678");
      expect(raw).toContain("\"appId\": \"orders-api\"");
      expect(raw).toContain("\"authorization\": \"Bearer raw-token\"");
      expect(raw).not.toContain("secret-password");
      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes event files after their two-hour ttl", async () => {
    const root = join(tmpdir(), `cf-live-trace-prune-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const createdAt = new Date("2026-06-30T01:00:00.000Z");
    const expiredAt = new Date("2026-06-30T03:00:01.000Z");
    const session = await createTraceSession(
      { target: createTarget() },
      { saptoolsRoot, now: () => createdAt, sessionId: "s12345678" },
    );

    try {
      await writeTraceEvent(session, createEvent(), {
        now: () => createdAt,
        requestId: () => "r12345678",
      });

      expect(await listTraceEvents("s12345678", { saptoolsRoot, now: () => createdAt })).toHaveLength(1);
      expect(await pruneTraceSessions({ saptoolsRoot, now: () => expiredAt })).toBe(1);
      expect(await listTraceEvents("s12345678", { saptoolsRoot, now: () => expiredAt })).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates collision-resistant session and request ids", async () => {
    const root = join(tmpdir(), `cf-live-trace-identifiers-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const session = await createTraceSession({ target: createTarget() }, { saptoolsRoot });

    try {
      const record = await writeTraceEvent(session, createEvent());

      expect(session.sessionId).toMatch(/^s[0-9a-f]{16}$/);
      expect(record.requestId).toMatch(/^r[0-9a-f]{16}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed stored event fields instead of returning an unsafe record", async () => {
    const root = join(tmpdir(), `cf-live-trace-validation-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const now = new Date("2026-06-30T01:00:00.000Z");
    const session = await createTraceSession(
      { target: createTarget() },
      { saptoolsRoot, now: () => now, sessionId: "s12345678" },
    );

    try {
      const record = await writeTraceEvent(session, createEvent(), {
        now: () => now,
        requestId: () => "r12345678",
      });
      await writeFile(record.backupPath, JSON.stringify({
        ...record,
        event: { ...record.event, responseHeaders: 42 },
      }), "utf8");

      await expect(readTraceEvent("s12345678", "r12345678", {
        saptoolsRoot,
        now: () => now,
      })).rejects.toThrow("not found or expired");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("visits events chronologically and stops without loading the remaining files", async () => {
    const root = join(tmpdir(), `cf-live-trace-visit-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const firstAt = new Date("2026-06-30T01:00:00.000Z");
    const secondAt = new Date("2026-06-30T01:00:01.000Z");
    const session = await createTraceSession(
      { target: createTarget() },
      { saptoolsRoot, now: () => firstAt, sessionId: "s12345678" },
    );
    await writeTraceEvent(session, createEvent(), {
      now: () => secondAt,
      requestId: () => "r22222222",
    });
    await writeTraceEvent(session, createEvent(), {
      now: () => firstAt,
      requestId: () => "r11111111",
    });
    const visited: string[] = [];

    try {
      await visitTraceEvents("s12345678", (record) => {
        visited.push(record.requestId);
        return false;
      }, { saptoolsRoot, now: () => firstAt });

      expect(visited).toEqual(["r11111111"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates a pruned manifest before writing a later event", async () => {
    const root = join(tmpdir(), `cf-live-trace-manifest-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const createdAt = new Date("2026-06-30T01:00:00.000Z");
    const laterAt = new Date("2026-06-30T03:00:01.000Z");
    const session = await createTraceSession(
      { target: createTarget() },
      { saptoolsRoot, now: () => createdAt, sessionId: "s12345678" },
    );

    try {
      await unlink(session.manifestPath);
      await writeTraceEvent(session, createEvent(), {
        now: () => laterAt,
        requestId: () => "r12345678",
      });

      expect(await listTraceSessions({ saptoolsRoot, now: () => laterAt })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds backup filenames when CF target names are long", async () => {
    const root = join(tmpdir(), `cf-live-trace-filename-${randomUUID()}`);
    const saptoolsRoot = join(root, ".saptools");
    const target: CfLiveTraceTarget = {
      apiEndpoint: `https://${"api".repeat(30)}.example.com`,
      email: "user@example.com",
      password: "secret-password",
      org: "o".repeat(100),
      space: "s".repeat(100),
      app: "a".repeat(100),
      instanceIndex: 0,
    };
    const session = await createTraceSession({ target }, {
      saptoolsRoot,
      sessionId: "s12345678",
    });

    try {
      const record = await writeTraceEvent(session, createEvent(), {
        requestId: () => "r12345678",
      });

      expect(Buffer.byteLength(basename(record.backupPath))).toBeLessThanOrEqual(240);
      expect(record.backupPath).toContain("-s12345678-r12345678-");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createTarget(): CfLiveTraceTarget {
  return {
    region: "ap10",
    email: "user@example.com",
    password: "secret-password",
    org: "sample-org",
    space: "dev",
    app: "orders-api",
    instanceIndex: 0,
  };
}

function createEvent(): LiveTraceEvent {
  return {
    id: "runtime-1",
    timestamp: "2026-06-30T01:00:00.000Z",
    appId: "orders-api",
    instance: "0",
    method: "POST",
    path: "/orders",
    url: "/orders",
    normalizedUrl: "/orders",
    status: 201,
    durationMs: 42,
    requestBytes: 16,
    responseBytes: 32,
    requestHeaders: { authorization: "Bearer raw-token" },
    responseHeaders: { "content-type": "application/json" },
    requestBodyPreview: "{\"sku\":\"A-100\"}",
    responseBodyPreview: "{\"ok\":true,\"data\":{\"name\":\"alpha\"}}",
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    droppedBeforeEvent: 0,
    source: "runtime-http",
    traceId: "runtime-1",
    correlationId: null,
  };
}
