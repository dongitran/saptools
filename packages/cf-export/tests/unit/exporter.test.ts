import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cfModule from "../../src/cf.js";
import * as defaultEnvModule from "../../src/default-env.js";
import { exportArtifacts } from "../../src/exporter.js";
import * as remoteModule from "../../src/remote-paths.js";
import * as sessionModule from "../../src/session.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-export-exporter-"));
  vi.resetAllMocks();
  vi.spyOn(cfModule, "ensureSshEnabled").mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeSession() {
  const dispose = vi.fn().mockResolvedValue(undefined);
  const context = { env: { CF_HOME: join(tempDir, "cfhome") } };
  return { context, dispose };
}

describe("exportArtifacts", () => {
  it("throws when no artifacts selected after normalization", async () => {
    await expect(
      exportArtifacts({
        target: { region: "ap10", org: "o", space: "s", app: "a" },
        outDir: tempDir,
        artifacts: [],
      }),
    ).rejects.toThrow("At least one artifact");
  });

  it("exports default-env.json using fetcher and writes with 0600", async () => {
    const sess = makeSession();
    vi.spyOn(sessionModule, "openCfSession").mockResolvedValue(sess as unknown as Awaited<ReturnType<typeof sessionModule.openCfSession>>);

    const fetchDefault = vi
      .spyOn(defaultEnvModule, "fetchDefaultEnvJson")
      .mockResolvedValue('{"VCAP_SERVICES":{}}\n');

    const result = await exportArtifacts({
      target: { region: "ap10", org: "o", space: "s", app: "demo-app" },
      outDir: tempDir,
      artifacts: ["default-env.json"],
    });

    expect(fetchDefault).toHaveBeenCalledOnce();
    expect(result.writtenFiles.length).toBe(1);
    expect(result.skipped.length).toBe(0);

    const writtenPath = result.writtenFiles[0]!;
    const content = await readFile(writtenPath, "utf8");
    expect(JSON.parse(content)).toEqual({ VCAP_SERVICES: {} });
    const mode = (await stat(writtenPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("exports regular files via remote fetch and skips missing", async () => {
    const sess = makeSession();
    vi.spyOn(sessionModule, "openCfSession").mockResolvedValue(sess as unknown as Awaited<ReturnType<typeof sessionModule.openCfSession>>);

    vi.spyOn(remoteModule, "fetchRemoteTextFile")
      .mockResolvedValueOnce('{"name":"pkg"}\n') // package.json
      .mockResolvedValueOnce(null); // pnpm missing

    const result = await exportArtifacts({
      target: { region: "ap10", org: "o", space: "s", app: "demo" },
      outDir: tempDir,
      artifacts: ["package.json", "pnpm-lock.yaml"],
    });

    expect(result.writtenFiles.some((p) => p.endsWith("package.json"))).toBe(true);
    expect(result.skipped).toContain("pnpm-lock.yaml");
  });

  it("prefers remoteRoot for file lookup", async () => {
    const sess = makeSession();
    vi.spyOn(sessionModule, "openCfSession").mockResolvedValue(sess as unknown as Awaited<ReturnType<typeof sessionModule.openCfSession>>);

    const spy = vi.spyOn(remoteModule, "fetchRemoteTextFile").mockResolvedValue("rooted\n");

    await exportArtifacts({
      target: { region: "ap10", org: "o", space: "s", app: "x" },
      outDir: tempDir,
      remoteRoot: "/my/app",
      artifacts: ["package.json"],
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRoot: "/my/app", fileName: "package.json" }),
    );
  });
});
