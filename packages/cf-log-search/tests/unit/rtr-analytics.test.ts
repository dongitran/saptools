import { describe, expect, it } from "vitest";

import { buildRtrFilterClauses } from "../../src/rtr-analytics.js";

const NOW = new Date("2026-09-12T06:00:00.000Z");

describe("buildRtrFilterClauses", () => {
  it("always includes the RTR source_type filter", () => {
    const clauses = buildRtrFilterClauses({}, () => NOW);
    expect(clauses).toContainEqual({ term: { "source_type.keyword": "RTR" } });
  });

  it("defaults the time range to --since 1h, same as search/count", () => {
    const clauses = buildRtrFilterClauses({}, () => NOW);
    expect(clauses).toContainEqual({ range: { "@timestamp": { gte: new Date("2026-09-12T05:00:00.000Z").toISOString() } } });
  });

  it("adds an app_name.keyword filter when --app is given", () => {
    const clauses = buildRtrFilterClauses({ app: "acme-svc-config" }, () => NOW);
    expect(clauses).toContainEqual({ term: { "app_name.keyword": "acme-svc-config" } });
  });

  it("omits the app filter when --app is not given", () => {
    const clauses = buildRtrFilterClauses({}, () => NOW);
    expect(clauses.some((clause) => "term" in clause && Object.keys((clause as { term: object }).term)[0] === "app_name.keyword")).toBe(false);
  });
});
