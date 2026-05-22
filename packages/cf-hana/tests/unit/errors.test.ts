import { describe, expect, it } from "vitest";

import {
  CfHanaError,
  CredentialsNotFoundError,
  DestructiveStatementError,
  errorMessage,
  QueryError,
  ReadOnlyViolationError,
} from "../../src/errors.js";

describe("errors", () => {
  it("CfHanaError carries a code and extends Error", () => {
    const error = new CfHanaError("CONFIG", "bad config");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CfHanaError);
    expect(error.code).toBe("CONFIG");
    expect(error.name).toBe("CfHanaError");
    expect(error.message).toBe("bad config");
  });

  it("subclasses set their code and stay instanceof CfHanaError", () => {
    const error = new CredentialsNotFoundError("missing");
    expect(error).toBeInstanceOf(CfHanaError);
    expect(error).toBeInstanceOf(CredentialsNotFoundError);
    expect(error.code).toBe("CREDENTIALS_NOT_FOUND");
    expect(error.name).toBe("CredentialsNotFoundError");
  });

  it("ReadOnlyViolationError and DestructiveStatementError carry their codes", () => {
    expect(new ReadOnlyViolationError("ro").code).toBe("READ_ONLY_VIOLATION");
    expect(new DestructiveStatementError("destructive").code).toBe("DESTRUCTIVE_BLOCKED");
  });

  it("QueryError exposes an optional sqlState", () => {
    expect(new QueryError("boom", { sqlState: "42000" }).sqlState).toBe("42000");
    expect(new QueryError("boom").sqlState).toBeUndefined();
  });

  it("preserves the underlying cause", () => {
    const cause = new Error("root cause");
    expect(new CfHanaError("QUERY", "wrapped", { cause }).cause).toBe(cause);
  });

  it("errorMessage extracts a message from any thrown value", () => {
    expect(errorMessage(new Error("typed error"))).toBe("typed error");
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});
