import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("target reading (self-contained)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parseCfTargetOutput extracts api/org/space and derives regionKey", async () => {
    const { parseCfTargetOutput } = await import("../../src/target.js");

    const stdout = [
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
      "API version:    3.156.0",
      "user:           operator@example.test",
      "org:            sample-org",
      "space:          sample",
      "",
    ].join("\n");

    const target = parseCfTargetOutput(stdout);
    expect(target).toEqual({
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      regionKey: "ap10",
      orgName: "sample-org",
      spaceName: "sample",
    });
  });

  it("parseCfTargetOutput returns undefined for incomplete target", async () => {
    const { parseCfTargetOutput } = await import("../../src/target.js");

    expect(parseCfTargetOutput("API endpoint: https://x\norg: foo\n")).toBeUndefined();
    expect(parseCfTargetOutput("")).toBeUndefined();
  });

  it("parseCfTargetOutput keeps api when region unknown", async () => {
    const { parseCfTargetOutput } = await import("../../src/target.js");

    const target = parseCfTargetOutput(
      "API endpoint: https://api.example.custom\norg: o\nspace: s\n",
    );
    expect(target).toEqual({
      apiEndpoint: "https://api.example.custom",
      orgName: "o",
      spaceName: "s",
    });
  });

  it("readCurrentCfTarget invokes cf target (or override) and parses", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        cb(null, "API endpoint: https://api.cf.eu10.hana.ondemand.com\norg: myorg\nspace: dev\n");
      },
    );

    const { readCurrentCfTarget } = await import("../../src/target.js");
    const t = await readCurrentCfTarget({ command: "custom-cf" });
    expect(t?.regionKey).toBe("eu10");
    expect(t?.orgName).toBe("myorg");
    expect(execFileMock).toHaveBeenCalledWith(
      "custom-cf",
      ["target"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("readCurrentCfTarget throws on cf failure (wrapped)", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const err = Object.assign(new Error("boom"), { stderr: "nope" });
        cb(err);
      },
    );

    const { readCurrentCfTarget } = await import("../../src/target.js");
    await expect(readCurrentCfTarget()).rejects.toThrow();
  });
});
