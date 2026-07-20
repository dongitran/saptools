import { describe, expect, it } from "vitest";

import { isAppOwnedScript, resolveRuntimeScript } from "../../src/script-resolver.js";

const SCRIPTS = [
  { scriptId: "1", url: "file:///home/vcap/app/dist/order.js" },
  { scriptId: "2", url: "file:///home/vcap/app/other/order.js" },
  { scriptId: "3", url: "file:///home/vcap/app/node_modules/pkg/index.js" },
];

describe("runtime script resolution", () => {
  it("prefers exact URL and decoded absolute path", () => {
    expect(resolveRuntimeScript("file:///home/vcap/app/dist/order.js", SCRIPTS).scriptId).toBe("1");
    expect(resolveRuntimeScript("/home/vcap/app/dist/order.js", SCRIPTS).scriptId).toBe("1");
  });

  it("fails closed when a relative suffix is ambiguous", () => {
    expect(() => resolveRuntimeScript("order.js", SCRIPTS, ["/home/vcap/app"])).toThrowError(expect.objectContaining({
      code: "AMBIGUOUS_SCRIPT",
    }));
  });

  it("classifies only app-root scripts outside dependency and internal paths", () => {
    expect(isAppOwnedScript(SCRIPTS[0]?.url ?? "", ["/home/vcap/app"])).toBe(true);
    expect(isAppOwnedScript(SCRIPTS[2]?.url ?? "", ["/home/vcap/app"])).toBe(false);
    expect(isAppOwnedScript("node:internal/modules/cjs/loader", ["/home/vcap/app"])).toBe(false);
  });

  it("resolves one verified relative suffix and decodes file URLs", () => {
    expect(resolveRuntimeScript("dist/order.js", SCRIPTS, ["/home/vcap/app"]).scriptId).toBe("1");
    expect(resolveRuntimeScript(
      "/home/vcap/app/dist/space name.js",
      [{ scriptId: "4", url: "file:///home/vcap/app/dist/space%20name.js" }],
    ).scriptId).toBe("4");
  });

  it("fails closed for absent scripts and root-prefix lookalikes", () => {
    expect(() => resolveRuntimeScript("missing.js", SCRIPTS, ["/home/vcap/app"])).toThrowError(expect.objectContaining({
      code: "SCRIPT_NOT_FOUND",
    }));
    expect(isAppOwnedScript("file:///home/vcap/application/escape.js", ["/home/vcap/app"])).toBe(false);
    expect(isAppOwnedScript("internal/bootstrap/node.js", ["/home/vcap/app"])).toBe(false);
    expect(isAppOwnedScript("eval at handler (runtime.js:1:1)", ["/home/vcap/app"])).toBe(false);
    expect(() => resolveRuntimeScript(SCRIPTS[2]?.url ?? "", SCRIPTS, ["/home/vcap/app"]))
      .toThrowError(expect.objectContaining({ code: "SCRIPT_NOT_FOUND" }));
  });
});
