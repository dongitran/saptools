import { describe, expect, it } from "vitest";

import * as publicApi from "../../src/index.js";

describe("public exports", () => {
  it("exposes the documented runtime API surface", () => {
    const expected = [
      "connect",
      "query",
      "withConnection",
      "HanaClient",
      "Transaction",
      "createDriver",
      "formatResult",
      "formatTable",
      "formatJson",
      "formatCsv",
      "buildSelect",
      "buildCount",
      "buildInsert",
      "buildUpdate",
      "buildDelete",
      "CfHanaError",
      "CredentialsNotFoundError",
      "QueryError",
      "ReadOnlyViolationError",
      "DestructiveStatementError",
      "errorMessage",
    ] as const;
    for (const name of expected) {
      expect(typeof publicApi[name]).toBe("function");
    }
  });
});
