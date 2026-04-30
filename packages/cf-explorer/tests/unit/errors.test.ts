import { describe, expect, it } from "vitest";

import { CfExplorerError, toExplorerError } from "../../src/errors.js";

describe("typed errors", () => {
  it("preserves existing explorer errors", () => {
    const error = new CfExplorerError("UNSAFE_INPUT", "bad", "detail");
    expect(toExplorerError(error)).toBe(error);
    expect(error.detail).toBe("detail");
  });

  it("maps unknown failures to remote command errors", () => {
    expect(toExplorerError(new Error("failed"))).toMatchObject({
      code: "REMOTE_COMMAND_FAILED",
      message: "failed",
    });
    expect(toExplorerError("plain")).toMatchObject({
      code: "REMOTE_COMMAND_FAILED",
      message: "plain",
    });
  });
});
