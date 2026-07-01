import { describe, expect, it } from "vitest";

import { compileScriptUrlFilter } from "../../src/cli/commands/listScripts.js";

describe("list-scripts filtering", () => {
  it("matches escaped literal characters in script URL patterns", () => {
    const filter = compileScriptUrlFilter("sample-app\\.mjs");

    expect(filter?.("file:///repo/packages/cf-inspector/tests/e2e/fixtures/sample-app.mjs")).toBe(true);
    expect(filter?.("file:///repo/packages/cf-inspector/tests/e2e/fixtures/sample-appxmjs")).toBe(false);
  });

  it("supports documented wildcard and alternative script URL patterns without RegExp input", () => {
    const wildcard = compileScriptUrlFilter("dist/.+\\.js");
    const alternative = compileScriptUrlFilter("/home/vcap/app|ValidatePayloadWorker");

    expect(wildcard?.("file:///home/vcap/app/dist/service.js")).toBe(true);
    expect(wildcard?.("file:///home/vcap/app/dist/.js")).toBe(false);
    expect(alternative?.("file:///home/vcap/app/srv/server.js")).toBe(true);
    expect(alternative?.("worker://ValidatePayloadWorker/index.js")).toBe(true);
  });

  it("treats unsupported regex metacharacters as literals", () => {
    const filter = compileScriptUrlFilter("[sample]");

    expect(filter?.("file:///tmp/[sample]/app.js")).toBe(true);
    expect(filter?.("file:///tmp/sample/app.js")).toBe(false);
  });

  it("ignores empty alternatives instead of matching every script URL", () => {
    const filter = compileScriptUrlFilter("|sample-app\\.mjs|");

    expect(filter?.("file:///tmp/sample-app.mjs")).toBe(true);
    expect(filter?.("file:///tmp/other.mjs")).toBe(false);
  });
});
