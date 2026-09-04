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
    // Only a correlation id on this line, so there is no second identifier to add.
    expect(Object.keys(compact[1] ?? {})).not.toContain("vcapRequestId");
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

  it("keeps the hop id when the correlation id takes the requestId slot", () => {
    const compact = compactLogRows(parseRecentLogs(
      '2026-04-12T09:00:01.00+0700 [RTR/2] OUT app.example.test - [2026-04-12T02:00:01.000Z] "GET /both HTTP/1.1" 200 0 532 "-" "agent/1.0" "10.0.1.1:1001" "10.0.2.1:2001" vcap_request_id:"0f386888-da32-42b2-7c48-c6200a2894fa" x_correlationid:"corr-both" response_time:0.017',
    ));
    expect(compact[0]).toMatchObject({
      requestId: "corr-both",
      vcapRequestId: "0f386888-da32-42b2-7c48-c6200a2894fa",
    });
    expect(formatCompactRows(compact)).toContain(
      "requestId=corr-both vcapRequestId=0f386888-da32-42b2-7c48-c6200a2894fa",
    );
  });

  it("keeps the 0.7.0 requestId precedence for every payload alias combination", () => {
    // The tempting refactor — sourcing this slot from the new typed fields —
    // let x_vcap_request_id outrank request_id and reqID, which the 0.7.0 chain
    // never consulted at all. These are the shapes where that showed.
    const shapes: readonly (readonly [Record<string, string>, string | undefined])[] = [
      [{ reqID: "RID" }, "RID"],
      [{ request_id: "RQ", reqID: "RID" }, "RQ"],
      [{ x_vcap_request_id: "XV" }, undefined],
      [{ x_vcap_request_id: "XV", request_id: "RQ" }, "RQ"],
      [{ x_vcap_request_id: "XV", reqID: "RID" }, "RID"],
      [{ x_vcap_request_id: "XV", request_id: "RQ", reqID: "RID" }, "RQ"],
      [{ correlation_id: "C", x_vcap_request_id: "XV", request_id: "RQ" }, "C"],
      [{ x_correlationid: "XC", request_id: "RQ" }, "XC"],
    ];

    for (const [payload, expected] of shapes) {
      const line = `2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT ${JSON.stringify({ level: "info", logger: "l", msg: "m", ...payload })}`;
      const [compact] = compactLogRows(parseRecentLogs(line));
      expect(compact?.requestId, JSON.stringify(payload)).toBe(expected);
    }
  });

  it("recovers both ids from the payload when the typed fields are empty", () => {
    // Exactly the shape a session stored by 0.7.0 rehydrates into: payload
    // intact, typed fields backfilled to "". The projection must not lose them.
    const rehydrated = parseRecentLogs(
      '2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT {"level":"info","logger":"l","msg":"m","correlation_id":"JC","x_vcap_request_id":"JV"}',
    ).map((row) => ({ ...row, correlationId: "", vcapRequestId: "" }));

    expect(compactLogRows(rehydrated)[0]).toMatchObject({ requestId: "JC", vcapRequestId: "JV" });
  });

  it("emits the hop id even when it duplicates requestId", () => {
    const rows = parseRecentLogs(
      '2026-04-12T09:00:02.00+0700 [RTR/3] OUT app.example.test - [2026-04-12T02:00:02.000Z] "GET /v HTTP/1.1" 200 0 5 "-" "a/1.0" "10.0.1.1:1" "10.0.2.1:2" vcap_request_id:"only-vcap" response_time:0.017',
    );

    // Suppressing this made a vcap-only row indistinguishable from a correlation-only one.
    expect(compactLogRows(rows)[0]).toMatchObject({
      requestId: "only-vcap",
      vcapRequestId: "only-vcap",
    });
  });
});
