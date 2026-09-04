import type { ParsedLogRow } from "@saptools/cf-logs";
import { parseRecentLogs } from "@saptools/cf-logs";
import { describe, expect, it } from "vitest";

import { buildRedactionRules, redactLogRow } from "../../src/redaction.js";

const SECRETS = {
  corr: "SECRET-CORR",
  vcap: "SECRET-VCAP",
  tenant: "SECRET-TENANT",
  ip: "203.0.113.7",
} as const;

function routerRow(): ParsedLogRow {
  const [row] = parseRecentLogs(
    `2026-04-12T09:14:41.00+0700 [RTR/0] OUT app.example.test - ` +
      `[2026-04-12T02:14:41.000Z] "GET /x HTTP/1.1" 200 4 1 "-" "agent/1.0" ` +
      `"10.0.1.1:1001" "10.0.2.1:2001" x_correlationid:"${SECRETS.corr}" ` +
      `vcap_request_id:"${SECRETS.vcap}" tenantid:"${SECRETS.tenant}" ` +
      `x_cf_true_client_ip:"${SECRETS.ip}" response_time:0.1`,
  );
  if (row === undefined) {
    throw new Error("fixture did not parse");
  }
  return row;
}

describe("redactLogRow", () => {
  it("redacts every secret from every string field on the row", () => {
    const row = routerRow();
    const rules = buildRedactionRules({ secrets: Object.values(SECRETS) });

    const redacted = redactLogRow(row, rules);

    // Asserted over every string-valued field rather than a hand-listed few:
    // `redactLogRow` spreads `...row` and then overrides named fields, so a
    // field added to ParsedLogRow but forgotten there passes through
    // unredacted and TypeScript cannot catch it. This is what makes that a
    // test failure instead of a silent leak.
    const leaked = Object.entries(redacted)
      .filter(([, value]) => typeof value === "string")
      .filter(([, value]) => Object.values(SECRETS).some((secret) => (value as string).includes(secret)))
      .map(([key]) => key);

    expect(leaked).toEqual([]);
  });

  it("redacts the split correlation and hop identifiers", () => {
    const row = routerRow();
    const rules = buildRedactionRules({ secrets: [SECRETS.corr, SECRETS.vcap] });

    const redacted = redactLogRow(row, rules);

    expect(row.correlationId).toBe(SECRETS.corr);
    expect(row.vcapRequestId).toBe(SECRETS.vcap);
    expect(redacted.correlationId).toBe("***");
    expect(redacted.vcapRequestId).toBe("***");
    expect(redacted.requestId).toBe("***");
  });

  it("returns the row untouched when there are no rules", () => {
    const row = routerRow();

    expect(redactLogRow(row, [])).toBe(row);
  });
});
