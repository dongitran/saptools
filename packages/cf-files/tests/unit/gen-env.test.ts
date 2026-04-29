import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-files-genenv-"));
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("../../src/session.js");
  await rm(tempDir, { recursive: true, force: true });
});

describe("genEnv", () => {
  it("writes default-env.json with system-provided and user-provided values", async () => {
    const sessionContext = { env: { CF_HOME: join(tempDir, "cf-home") } };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfEnv = vi.fn().mockResolvedValue([
      "Getting env variables for app demo-app in org demo-org / space dev as user@example.com...",
      "OK",
      "",
      "System-Provided:",
      "{",
      '  "VCAP_APPLICATION": {',
      '    "application_id": "demo-guid",',
      '    "application_name": "demo-app"',
      "  },",
      '  "VCAP_SERVICES": {',
      '    "xsuaa": [{',
      '      "credentials": { "clientid": "demo" }',
      "    }]",
      "  }",
      "}",
      "",
      "User-Provided:",
      'destinations: [{"name":"example-api","url":"https://example.com"}]',
      "FEATURE_FLAG: true",
      "",
    ].join("\n"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfEnv }));

    const { genEnv } = await import("../../src/gen-env.js");
    const outPath = join(tempDir, "default-env.json");

    const result = await genEnv({
      target: { region: "ap10", org: "demo-org", space: "dev", app: "demo-app" },
      outPath,
    });

    expect(openCfSession).toHaveBeenCalledOnce();
    expect(cfEnv).toHaveBeenCalledWith("demo-app", sessionContext);
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.outPath).toBe(outPath);
    expect(result.payload).toEqual({
      VCAP_APPLICATION: {
        application_id: "demo-guid",
        application_name: "demo-app",
      },
      VCAP_SERVICES: { xsuaa: [{ credentials: { clientid: "demo" } }] },
      destinations: [{ name: "example-api", url: "https://example.com" }],
      FEATURE_FLAG: true,
    });

    const content = await readFile(outPath, "utf8");
    expect(JSON.parse(content)).toEqual(result.payload);
    expect((await stat(outPath)).mode & 0o777).toBe(0o600);
  });

  it("creates nested output directories", async () => {
    const sessionContext = { env: { CF_HOME: join(tempDir, "cf-home") } };
    vi.doMock("../../src/session.js", () => ({
      openCfSession: vi.fn().mockResolvedValue({
        context: sessionContext,
        dispose: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../src/cf.js", () => ({
      cfEnv: vi.fn().mockResolvedValue('VCAP_SERVICES: {"a":1}'),
    }));

    const { genEnv } = await import("../../src/gen-env.js");
    const outPath = join(tempDir, "nested", "deep", "default-env.json");
    await genEnv({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      outPath,
    });

    const content = await readFile(outPath, "utf8");
    expect(JSON.parse(content)).toEqual({ VCAP_SERVICES: { a: 1 } });
  });

  it("propagates parse errors", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/session.js", () => ({
      openCfSession: vi.fn().mockResolvedValue({
        context: { env: { CF_HOME: join(tempDir, "cf-home") } },
        dispose,
      }),
    }));
    vi.doMock("../../src/cf.js", () => ({
      cfEnv: vi.fn().mockResolvedValue("no marker here"),
    }));

    const { genEnv } = await import("../../src/gen-env.js");
    await expect(
      genEnv({
        target: { region: "ap10", org: "o", space: "s", app: "a" },
        outPath: join(tempDir, "x.json"),
      }),
    ).rejects.toThrow(/No supported env variables found/);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
