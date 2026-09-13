import { describe, expect, it } from "vitest";

import { CfLogSearchError, CredentialsNotFoundError, errorMessage } from "../../src/errors.js";

describe("errorMessage", () => {
  it("returns an Error's own message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("CfLogSearchError", () => {
  it("carries an optional status and cause when given", () => {
    const cause = new Error("root cause");
    const withOptions = new CfLogSearchError("OPENSEARCH_REQUEST_FAILED", "request failed", { status: 502, cause });
    expect(withOptions.status).toBe(502);
    expect(withOptions.cause).toBe(cause);
  });

  it("leaves status and cause undefined when no options are given", () => {
    const bare = new CfLogSearchError("CONFIG", "bad config");
    expect(bare.status).toBeUndefined();
    expect(bare.cause).toBeUndefined();
  });
});

describe("CredentialsNotFoundError", () => {
  it("carries the CREDENTIALS_NOT_FOUND code and its own name", () => {
    const error = new CredentialsNotFoundError("no usable credential");
    expect(error.code).toBe("CREDENTIALS_NOT_FOUND");
    expect(error.name).toBe("CredentialsNotFoundError");
    expect(error.message).toBe("no usable credential");
    expect(error).toBeInstanceOf(Error);
  });
});
