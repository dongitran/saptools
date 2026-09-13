import { describe, expect, it } from "vitest";

import { mapHitToLogRow, resolveSpanId, resolveTraceId } from "../../src/row-mapper.js";

describe("resolveTraceId", () => {
  it("returns the trace_id on an RTR document", () => {
    expect(resolveTraceId({ source_type: "RTR", trace_id: "af152fbfbba481911801aa1961e28384" })).toBe(
      "af152fbfbba481911801aa1961e28384",
    );
  });

  it("returns undefined on an APP-log document even when trace_id is present", () => {
    // Regression test for the verified gotcha: on an APP/PROC/WEB document,
    // `trace_id` is unreliable — often a de-hyphenated `correlation_id`, not
    // a real trace id (verified live: correlation_id
    // "cafecafe-babe-4bad-8bad-deadbeefcafe" -> trace_id
    // "cafecafebabe4bad8baddeadbeefcafe", exact de-hyphenation match) — but a
    // live 100-row resample on 2026-09-13 found ~42% instead carry a
    // genuinely different, real trace id. This fixture covers the
    // de-hyphenated case; either way the field must never be trusted off an
    // RTR row (see row-mapper.ts's own doc comment on resolveTraceId).
    expect(
      resolveTraceId({
        source_type: "APP/PROC/WEB",
        trace_id: "cafecafebabe4bad8baddeadbeefcafe",
        correlation_id: "cafecafe-babe-4bad-8bad-deadbeefcafe",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for every other source_type, not only APP/PROC/WEB", () => {
    for (const sourceType of ["CELL", "STG", "API", "APP/TASK/43be6b79"]) {
      expect(resolveTraceId({ source_type: sourceType, trace_id: "some-value" })).toBeUndefined();
    }
  });

  it("returns undefined when source_type is missing entirely", () => {
    expect(resolveTraceId({ trace_id: "x" })).toBeUndefined();
  });

  it("returns undefined when trace_id itself is absent on an RTR document", () => {
    expect(resolveTraceId({ source_type: "RTR" })).toBeUndefined();
  });
});

describe("resolveSpanId", () => {
  it("returns span_id only on RTR documents, mirroring resolveTraceId", () => {
    expect(resolveSpanId({ source_type: "RTR", span_id: "beefbeefbeefbeef" })).toBe("beefbeefbeefbeef");
    expect(resolveSpanId({ source_type: "APP/PROC/WEB", span_id: "beefbeefbeefbeef" })).toBeUndefined();
  });
});

describe("mapHitToLogRow", () => {
  it("maps an RTR document into a row with method/path/status/latency and a real traceId", () => {
    const row = mapHitToLogRow({
      id: "abc",
      source: {
        "@timestamp": "2026-09-12T05:07:38.957Z",
        source_type: "RTR",
        app_name: "acme-svc-config",
        space_name: "app",
        organization_name: "acme-demo-org",
        method: "GET",
        request: "/SystemConfigService/getBrokerConfig()",
        response_status: 200,
        response_time_ms: 16.985,
        vcap_request_id: "11111111-1111-4111-8111-111111111111",
        correlation_id: "22222222-2222-4222-8222-222222222222",
        trace_id: "deaddeaddeaddeaddeaddeaddeaddead",
        span_id: "beefbeefbeefbeef",
      },
    });

    expect(row).toEqual({
      id: "abc",
      timestamp: "2026-09-12T05:07:38.957Z",
      sourceType: "RTR",
      appName: "acme-svc-config",
      appId: "",
      spaceName: "app",
      orgName: "acme-demo-org",
      level: "",
      logger: "",
      message: "GET /SystemConfigService/getBrokerConfig() -> 200 (17.0ms)",
      correlationId: "22222222-2222-4222-8222-222222222222",
      vcapRequestId: "11111111-1111-4111-8111-111111111111",
      traceId: "deaddeaddeaddeaddeaddeaddeaddead",
      spanId: "beefbeefbeefbeef",
      method: "GET",
      path: "/SystemConfigService/getBrokerConfig()",
      responseStatus: 200,
      responseTimeMs: 16.985,
    });
  });

  it("maps an APP-log document into a row with msg as the message and an empty traceId", () => {
    const row = mapHitToLogRow({
      id: "def",
      source: {
        "@timestamp": "2026-09-12T05:04:31.044Z",
        source_type: "APP/PROC/WEB",
        app_name: "acme-svc-user",
        space_name: "app",
        organization_name: "acme-demo-org",
        level: "debug",
        logger: "remote",
        msg: "GET <srv_config_system>/SystemConfigService/getBrokerConfig()",
        correlation_id: "cafecafe-babe-4bad-8bad-deadbeefcafe",
        trace_id: "cafecafebabe4bad8baddeadbeefcafe",
      },
    });

    expect(row.message).toBe("GET <srv_config_system>/SystemConfigService/getBrokerConfig()");
    expect(row.traceId).toBe("");
    expect(row.spanId).toBe("");
    expect(row.method).toBe("");
    expect(row.responseStatus).toBeUndefined();
  });

  it("never throws on a document missing every optional field", () => {
    expect(() => mapHitToLogRow({ id: "x", source: {} })).not.toThrow();
  });
});
