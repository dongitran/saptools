import { describe, expect, it } from "vitest";

import { CfHanaError, QueryError } from "../../src/errors.js";
import { isConnectivityFailure } from "../../src/tunnel/classifier.js";

function openConnError(): Error {
  return Object.assign(
    new Error(
      "Could not connect to any host: [ hana.example.internal:443 - " +
        "Client network socket disconnected before secure TLS connection " +
        "was established ]",
    ),
    { code: "EHDBOPENCONN" },
  );
}

describe("isConnectivityFailure", () => {
  it("matches a CfHanaError wrapping a real EHDBOPENCONN cause", () => {
    const error = new CfHanaError(
      "CONNECTION",
      `Failed to connect to HANA: ${openConnError().message}`,
      { cause: openConnError() },
    );
    expect(isConnectivityFailure(error)).toBe(true);
  });

  it("matches the connect-phase timeout message", () => {
    const error = new CfHanaError("TIMEOUT", "HANA connection timed out after 60000ms");
    expect(isConnectivityFailure(error)).toBe(true);
  });

  it("walks one extra level of nested cause defensively", () => {
    const inner = new CfHanaError("CONNECTION", "wrapped once", {
      cause: openConnError(),
    });
    const outer = new CfHanaError("CONNECTION", "wrapped twice", { cause: inner });
    expect(isConnectivityFailure(outer)).toBe(true);
  });

  it("does not match the unrelated query-phase timeout (same code, different message)", () => {
    const error = new CfHanaError("TIMEOUT", "Statement timed out after 20ms");
    expect(isConnectivityFailure(error)).toBe(false);
  });

  it("does not match an auth/privilege QueryError with a numeric database code", () => {
    const error = new QueryError("insufficient privilege: not authorized", {
      databaseCode: 258,
    });
    expect(isConnectivityFailure(error)).toBe(false);
  });

  it("does not match a CONNECTION-coded error whose cause carries no EHDBOPENCONN code", () => {
    const error = new CfHanaError("CONNECTION", "Failed to connect to HANA: other reason", {
      cause: new Error("other reason"),
    });
    expect(isConnectivityFailure(error)).toBe(false);
  });

  it("does not match a CONNECTION-coded error with no cause at all", () => {
    const error = new CfHanaError("CONNECTION", "Failed to connect to HANA: mystery");
    expect(isConnectivityFailure(error)).toBe(false);
  });

  it("does not match a non-CfHanaError value", () => {
    expect(isConnectivityFailure(new Error("plain error"))).toBe(false);
    expect(isConnectivityFailure("just a string")).toBe(false);
    expect(isConnectivityFailure(undefined)).toBe(false);
  });
});
