import { expect, test } from "@playwright/test";

import { connect } from "../../src/index.js";

const target = process.env["CF_HANA_E2E_TARGET"];
const hasCredentials =
  process.env["SAP_EMAIL"] !== undefined &&
  process.env["SAP_PASSWORD"] !== undefined &&
  target !== undefined;

test("connects to a real HANA database and runs SELECT 1", async () => {
  test.skip(
    !hasCredentials,
    "live HANA e2e requires SAP_EMAIL, SAP_PASSWORD and CF_HANA_E2E_TARGET",
  );

  const client = await connect(target ?? "", { refresh: true });
  try {
    const result = await client.query<{ N: number }>("SELECT 1 AS N FROM DUMMY");
    expect(result.rows[0]?.N).toBe(1);

    const tables = await client.listTables(client.info.schema);
    expect(Array.isArray(tables)).toBe(true);
  } finally {
    await client.close();
  }
});
