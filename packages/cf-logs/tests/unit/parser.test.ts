// cspell:words samplelogger tenantid
import { describe, expect, it } from "vitest";

import {
  appendParsedLines,
  DEFAULT_LOG_LIMIT,
  filterRows,
  parseRecentLogs,
} from "../../src/parser.js";

const routerLine =
  '2026-04-12T09:14:48.20+0700 [RTR/0] OUT demo-app.cfapps.ap10.hana.ondemand.com - ' +
  '[2026-04-12T02:14:48.200Z] "GET /health HTTP/1.1" 200 42 10 "-" "probe/1.0" ' +
  '"10.0.1.1:1001" "10.0.2.1:2001" x_forwarded_for:"1.2.3.4, 10.0.1.1" ' +
  'vcap_request_id:"req-001" response_time:0.001 tenantid:"sample-tenant" ' +
  'x_cf_true_client_ip:"13.251.40.148"';

describe("parser", () => {
  it("drops CF system messages and parses JSON and router access rows", () => {
    const rows = parseRecentLogs(
      [
        "Retrieving logs for app demo-app in org sample-org / space sample as sample@example.com...",
        "",
        '2026-04-12T09:14:45.25+0700 [APP/PROC/WEB/0] OUT {"level":"info","logger":"samplelogger","timestamp":"2026-04-12T02:14:45.255Z","component_name":"demo-app","organization_name":"sample-org","space_name":"sample","msg":"ready","type":"log"}',
        routerLine,
        "Failed to retrieve logs from Log Cache: unexpected status code 404",
      ].join("\n"),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 1,
      level: "info",
      logger: "samplelogger",
      component: "demo-app",
      org: "sample-org",
      space: "sample",
      request: "ready",
    });
    expect(rows[1]).toMatchObject({
      id: 2,
      level: "info",
      method: "GET",
      request: "GET /health",
      status: "200",
      latency: "1 ms",
      tenant: "sample-tenant",
      clientIp: "13.251.40.148",
      requestId: "req-001",
    });
  });

  it("appends continuation lines and escalates stack traces to error", () => {
    const rows = appendParsedLines(
      [],
      [
        "2026-04-12T09:14:45.25+0700 [APP/PROC/WEB/0] OUT Request started",
        "Error: sample failure",
        "at sample.js:1:1",
      ],
      { logLimit: DEFAULT_LOG_LIMIT },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("error");
    expect(rows[0]?.message).toContain("Request started\nError: sample failure\nat sample.js:1:1");
  });

  it("trims rows to the configured limit without renumbering stable ids", () => {
    const rows = parseRecentLogs(
      [
        "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT line-1",
        "2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT line-2",
        "2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT line-3",
        "2026-04-12T09:14:43.00+0700 [APP/PROC/WEB/0] OUT line-4",
      ].join("\n"),
      { logLimit: 2 },
    );

    expect(rows.map((row) => row.id)).toEqual([3, 4]);
    expect(rows.map((row) => row.message)).toEqual(["line-3", "line-4"]);
  });

  it("filters rows by level and search term with newest rows first", () => {
    const rows = parseRecentLogs(
      [
        "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT alpha ready",
        '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","logger":"samplelogger","timestamp":"2026-04-12T02:14:41.000Z","msg":"save failed","type":"log"}',
        '2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT {"level":"warn","logger":"samplelogger","timestamp":"2026-04-12T02:14:42.000Z","msg":"save retry","type":"log"}',
      ].join("\n"),
    );

    const filtered = filterRows(rows, { level: "error", searchTerm: "save" });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.message).toBe("save failed");
  });

  it("creates a fallback SYSTEM row for an unparsable leading line", () => {
    const rows = parseRecentLogs("plain leading line");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "SYSTEM",
      timestamp: "N/A",
      message: "plain leading line",
    });
  });

  it("maps warning json logs and 404 router access logs to warn", () => {
    const rows = parseRecentLogs(
      [
        '2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT {"level":"warning","logger":"samplelogger","timestamp":"2026-04-12T02:14:40.000Z","msg":"sample warning","type":"log"}',
        '2026-04-12T09:14:41.00+0700 [RTR/0] OUT demo-app.cfapps.ap10.hana.ondemand.com - [2026-04-12T02:14:41.000Z] "GET /missing HTTP/1.1" 404 42 10 "-" "probe/1.0" "10.0.1.1:1001" "10.0.2.1:2001" x_forwarded_for:"1.2.3.4, 10.0.1.1" response_time:1.234 true_client_ip:"7.7.7.7"',
      ].join("\n"),
    );

    expect(rows.map((row) => row.level)).toEqual(["warn", "warn"]);
    expect(rows[1]?.latency).toBe("1.234 s");
    expect(rows[1]?.clientIp).toBe("7.7.7.7");
    expect(filterRows(rows, { newestFirst: false }).map((row) => row.id)).toEqual([1, 2]);
  });

  it("keeps undecodable router targets, prefers correlation id, and handles missing latency", () => {
    const rows = parseRecentLogs(
      '2026-04-12T09:14:41.00+0700 [RTR/0] OUT demo-app.cfapps.ap10.hana.ondemand.com - [2026-04-12T02:14:41.000Z] "GET /bad%ZZ?x=%ZZ HTTP/1.1" 500 42 10 "-" "probe/1.0" "10.0.1.1:1001" "10.0.2.1:2001" x_forwarded_for:"1.2.3.4, 10.0.1.1" x_correlationid:"corr-404" response_time:-',
    );

    expect(rows[0]).toMatchObject({
      level: "error",
      request: "GET /bad%ZZ?x=%ZZ",
      requestId: "corr-404",
      latency: "",
      clientIp: "1.2.3.4",
    });
  });
});
