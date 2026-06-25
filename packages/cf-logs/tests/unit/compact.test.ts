import { describe, expect, it } from "vitest";

import {
  buildCompactLogDocument,
  compactLogRows,
  formatCompactLogDocument,
  formatCompactRows,
} from "../../src/compact.js";
import { parseRecentLogs } from "../../src/parser.js";

const routerLine =
  '2026-04-12T09:00:01.00+0700 [RTR/0] OUT app.example.test - ' +
  '[2026-04-12T02:00:01.000Z] "GET /health HTTP/1.1" 200 42 10 "-" "agent/1.0" ' +
  '"10.0.1.1:1001" "10.0.2.1:2001" x_forwarded_for:"1.2.3.4, 10.0.1.1" ' +
  'x_correlationid:"corr-001" response_time:0.002 tenantid:"tenant-001" ' +
  'x_cf_true_client_ip:"203.0.113.7"';

describe("compact logs", () => {
  it("projects parsed rows into concise compact fields", () => {
    const rows = parseRecentLogs(
      [
        '2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT {"level":"info","logger":"unit.service","timestamp":"2026-04-12T02:00:00.000Z","msg":"operation accepted","type":"log","correlation_id":"corr-000"}',
        routerLine,
      ].join("\n"),
    );

    const compact = compactLogRows(rows);

    expect(compact).toHaveLength(2);
    expect(compact[0]).toMatchObject({
      id: 1,
      time: "09:00:00",
      level: "info",
      source: "APP",
      logger: "unit.service",
      message: "operation accepted",
      requestId: "corr-000",
    });
    expect(compact[1]).toMatchObject({
      id: 2,
      time: "09:00:01",
      level: "info",
      source: "RTR",
      request: "GET /health",
      status: "200",
      latency: "2 ms",
      tenant: "tenant-001",
      clientIp: "203.0.113.7",
      requestId: "corr-001",
    });
    expect(Object.keys(compact[1] ?? {})).not.toContain("rawBody");
    expect(Object.keys(compact[1] ?? {})).not.toContain("jsonPayload");
    expect(Object.keys(compact[1] ?? {})).not.toContain("searchableText");
    expect(compact[1]?.message).toBeUndefined();
  });

  it("bounds long messages and records summary metadata", () => {
    const rows = parseRecentLogs(
      [
        `2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT ${"a".repeat(80)}`,
        "2026-04-12T09:00:02.00+0700 [APP/PROC/WEB/0] ERR failed operation",
      ].join("\n"),
    );

    const document = buildCompactLogDocument(
      {
        appName: "neutral-app",
        generatedAt: "2026-04-12T09:00:03.000Z",
        rows,
        truncated: false,
      },
      { messageLimit: 24 },
    );

    expect(document.rowCount).toBe(2);
    expect(document.summary).toMatchObject({
      levels: { error: 1, info: 1 },
      sources: { APP: 2 },
      firstTimestamp: "2026-04-12T09:00:00.00+0700",
      lastTimestamp: "2026-04-12T09:00:02.00+0700",
    });
    expect(document.rows[0]?.message).toBe("aaaaaaaaaaaaaaaaaaaaa...");
  });

  it("uses a 500 character default message cap", () => {
    const rows = parseRecentLogs(
      `2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT ${"b".repeat(620)}`,
    );

    const compact = compactLogRows(rows);

    expect(compact[0]?.message).toHaveLength(500);
    expect(compact[0]?.message?.endsWith("...")).toBe(true);
  });

  it("formats compact documents as stable single-line text rows", () => {
    const rows = parseRecentLogs(
      [
        "2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT first line",
        "second line",
        routerLine,
      ].join("\n"),
    );
    const compact = compactLogRows(rows);

    const rowsText = formatCompactRows(compact);
    const documentText = formatCompactLogDocument(
      buildCompactLogDocument({ rows, truncated: true }),
    );

    expect(rowsText).toContain("#1 09:00:00 info APP");
    expect(rowsText).toContain("first line second line");
    expect(rowsText).not.toContain("\\n");
    expect(rowsText).toContain("#2 09:00:01 info RTR");
    expect(rowsText).toContain("request=GET /health");
    expect(documentText.split("\n")[0]).toContain("summary rows=2");
    expect(documentText.split("\n")[0]).toContain("truncated=true");
  });
});
