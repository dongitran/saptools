import { parseCompileResult } from "../../src/compiler.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("parseCompileResult", () => {
  it("parses the last non-empty JSON line when workers print diagnostics before payload", () => {
    expect(parseCompileResult("diagnostic line\n{\"packageName\":\"@demo/a\",\"definitions\":{\"A\":{}}}\n", "@demo/a")).toEqual({
      packageName: "@demo/a",
      definitions: { A: {} },
    });
  });

  it("rejects empty, malformed, wrong-package, and invalid-definition payloads", () => {
    expect(() => parseCompileResult("", "@demo/a")).toThrow("returned no JSON payload");
    expect(() => parseCompileResult("not-json", "@demo/a")).toThrow("returned malformed JSON");
    expect(() => parseCompileResult("{\"packageName\":\"@demo/b\",\"definitions\":{}}", "@demo/a")).toThrow("returned an invalid payload");
    expect(() => parseCompileResult("{\"packageName\":\"@demo/a\",\"definitions\":[]}", "@demo/a")).toThrow("returned an invalid payload");
  });
});