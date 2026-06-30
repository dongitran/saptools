import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTraceSession,
  listTraceEvents,
  pruneTraceSessions,
  readTraceEvent,
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
