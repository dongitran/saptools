import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  tryCreateResultSession,
} from "../../src/result-store.js";
import type { HanaClientInfo, QueryResult } from "../../src/types.js";

let rootDir: string;

const info: HanaClientInfo = {
  selector: "eu10/neutral-org/dev/neutral-app",
  appName: "neutral-app",
  host: "hana.example.internal",
  schema: "APP_SCHEMA",
  role: "runtime",
  driver: "fake",
  credentialSource: "live",
};

function sampleResult(): QueryResult {
  return {
    rows: [
      {
        ID: 1,
        CONTENT: "full\ntext",
        PAYLOAD: '{"items":[{"name":"Alpha"}]}',
        DATA: Buffer.from([0, 1, 255]),
        WHEN: new Date("2026-06-25T00:00:00.000Z"),
        ACTIVE: true,
        EMPTY: null,
      },
    ],
    columns: [
      { name: "ID", typeName: "INTEGER" },
      { name: "CONTENT", typeName: "NCLOB" },
      { name: "PAYLOAD", typeName: "NCLOB" },
      { name: "DATA", typeName: "BLOB" },
      { name: "WHEN", typeName: "TIMESTAMP" },
      { name: "ACTIVE", typeName: "BOOLEAN" },
      { name: "EMPTY", typeName: "NVARCHAR" },
    ],
    rowCount: 1,
    statement: "select",
    truncated: true,
    elapsedMs: 5,
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "cf-hana-results-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("result store", () => {
  it("round-trips exact typed result values", async () => {
    const created = await createResultSession(
      { result: sampleResult(), info, ttlMinutes: 60 },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    const loaded = await readResultSession("qabc12345", {
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T00:30:00.000Z"),
    });

    expect(created.expiresAt).toBe("2026-06-25T01:00:00.000Z");
    expect(loaded.result).toEqual(sampleResult());
    expect(loaded.info).toEqual(info);
  });

  it("defaults saved result refs to a seven-day TTL", async () => {
    const created = await createResultSession(
      { result: sampleResult(), info },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    expect(created.ttlMinutes).toBe(10_080);
    expect(created.expiresAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("creates restricted result directories and files", async () => {
    const session = await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qabc12345" },
    );

    const directoryMode = (await stat(session.directory)).mode & 0o777;
    const fileMode = (await stat(session.path)).mode & 0o777;

    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("rejects duplicate display names before saving", async () => {
    const result: QueryResult = {
      ...sampleResult(),
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "ID", typeName: "INTEGER" },
      ],
    };

    await expect(
      createResultSession({ result, info }, { saptoolsRoot: rootDir }),
    ).rejects.toThrow(/unique SQL aliases/);
  });

  it("rejects a session that exceeds its byte ceiling", async () => {
    await expect(
      createResultSession(
        { result: sampleResult(), info },
        { saptoolsRoot: rootDir, maxBytes: 10 },
      ),
    ).rejects.toThrow(/storage limit/);
  });

  it("fails soft when an automatic result save exceeds its byte ceiling", async () => {
    await expect(
      tryCreateResultSession(
        { result: sampleResult(), info },
        { saptoolsRoot: rootDir, maxBytes: 10 },
      ),
    ).resolves.toBeUndefined();
    await expect(listResultSessions({ saptoolsRoot: rootDir })).resolves.toEqual([]);
  });

  it("lists active sessions and prunes expired sessions", async () => {
    await createResultSession(
      { result: sampleResult(), info, ttlMinutes: 60 },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    const active = await listResultSessions({
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T00:30:00.000Z"),
    });
    const removed = await pruneResultSessions({
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T01:01:00.000Z"),
    });

    expect(active).toEqual([
      expect.objectContaining({ ref: "qabc12345", rowCount: 1 }),
    ]);
    expect(removed).toBe(1);
    await expect(
      readResultSession("qabc12345", { saptoolsRoot: rootDir }),
    ).rejects.toThrow(/not found or expired/);
  });

  it("clears every result session", async () => {
    await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qabc12345" },
    );
    await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qdef67890" },
    );

    expect(await clearResultSessions({ saptoolsRoot: rootDir })).toBe(2);
    expect(await listResultSessions({ saptoolsRoot: rootDir })).toEqual([]);
  });
});
