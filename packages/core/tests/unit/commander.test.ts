import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachSelfUpdate,
  commandPathOf,
  describeOutcome,
  formatSelfUpdateStatus,
  registerSelfUpdateCommand,
} from "../../src/self-update/commander.js";
import * as run from "../../src/self-update/run.js";
import type { SelfUpdateStatus } from "../../src/self-update/run.js";

const OPTIONS = { packageName: "@saptools/demo", currentVersion: "0.6.0", binName: "demo", envPrefix: "DEMO" };

const STATUS: SelfUpdateStatus = {
  packageName: "@saptools/demo",
  installed: "0.6.0",
  location: { kind: "npm-global", packageDirectory: "/p/lib/node_modules/@saptools/demo", prefix: "/p", writable: true, detail: "npm global install under /p" },
  policy: { policy: "on", reason: "default", explicit: false },
  registryUrl: "https://registry.npmjs.org",
  statePath: "/home/x/.saptools/updates/saptools__demo.json",
  latest: "0.7.0",
  checkError: undefined,
};

function buildProgram(): { program: Command; actions: string[] } {
  const actions: string[] = [];
  const program = new Command().name("demo").exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program.version("0.6.0");
  program
    .command("names")
    .action(() => {
      actions.push("names");
    });
  const credential = program.command("credential");
  credential.command("list").action(() => {
    actions.push("credential list");
  });
  return { program, actions };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("commandPathOf", () => {
  it("joins the subcommand names below the root", () => {
    const { program } = buildProgram();
    const credential = program.commands.find((c) => c.name() === "credential");
    const list = credential?.commands.find((c) => c.name() === "list");
    expect(list === undefined ? "" : commandPathOf(list)).toBe("credential list");
    expect(commandPathOf(program)).toBe("");
  });
});

describe("attachSelfUpdate", () => {
  it("runs the updater before every action with the command path, but not for --help or --version", async () => {
    const spy = vi.spyOn(run, "runSelfUpdate").mockResolvedValue({ kind: "current", latest: "0.6.0" });
    const { program, actions } = buildProgram();
    attachSelfUpdate(program, OPTIONS);

    await program.parseAsync(["node", "demo", "credential", "list"]);
    expect(actions).toEqual(["credential list"]);
    expect(spy).toHaveBeenCalledWith({ ...OPTIONS, commandPath: "credential list" });

    await expect(program.parseAsync(["node", "demo", "--version"])).rejects.toMatchObject({ code: "commander.version" });
    await expect(program.parseAsync(["node", "demo", "--help"])).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("registerSelfUpdateCommand", () => {
  it("prints the status and installs without re-running", async () => {
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue(STATUS);
    const runSpy = vi.spyOn(run, "runSelfUpdate").mockResolvedValue({ kind: "updated", from: "0.6.0", to: "0.7.0" });
    const lines: string[] = [];
    const { program } = buildProgram();
    registerSelfUpdateCommand(program, { ...OPTIONS, print: (line) => lines.push(line) });

    await program.parseAsync(["node", "demo", "self-update"]);
    expect(lines).toEqual([
      "package=@saptools/demo",
      "installed=0.6.0",
      "latest=0.7.0",
      "policy=on (default)",
      "install=npm-global /p/lib/node_modules/@saptools/demo",
      "writable=yes",
      "registry=https://registry.npmjs.org",
      "state=/home/x/.saptools/updates/saptools__demo.json",
      "result=updated 0.6.0 -> 0.7.0",
    ]);
    expect(runSpy).toHaveBeenCalledWith({ ...OPTIONS, print: expect.any(Function), manual: true, reexec: false });
    expect(process.exitCode).toBeUndefined();
  });

  it("with --check only reports, and describes an unknown latest with its cause", async () => {
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue({ ...STATUS, latest: undefined, checkError: "HTTP 503" });
    const runSpy = vi.spyOn(run, "runSelfUpdate");
    const lines: string[] = [];
    const { program } = buildProgram();
    registerSelfUpdateCommand(program, { ...OPTIONS, print: (line) => lines.push(line) });
    await program.parseAsync(["node", "demo", "self-update", "--check"]);
    expect(lines).toContain("latest=unknown (HTTP 503)");
    expect(lines.at(-1)).toBe("result=unknown");
    expect(runSpy).not.toHaveBeenCalled();

    lines.length = 0;
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue(STATUS);
    await program.parseAsync(["node", "demo", "self-update", "--check"]);
    expect(lines.at(-1)).toBe("result=update-available");

    lines.length = 0;
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue({ ...STATUS, latest: "0.6.0" });
    await program.parseAsync(["node", "demo", "self-update", "--check"]);
    expect(lines.at(-1)).toBe("result=current");
  });

  it("sets a failing exit code when the install failed", async () => {
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue({ ...STATUS, location: { ...STATUS.location, packageDirectory: undefined } });
    vi.spyOn(run, "runSelfUpdate").mockResolvedValue({ kind: "failed", latest: "0.7.0", reason: "exit 1" });
    const lines: string[] = [];
    const { program } = buildProgram();
    registerSelfUpdateCommand(program, { ...OPTIONS, print: (line) => lines.push(line) });
    await program.parseAsync(["node", "demo", "self-update"]);
    expect(lines).toContain("install=npm global install under /p");
    expect(lines.at(-1)).toBe("result=failed (exit 1)");
    expect(process.exitCode).toBe(1);
  });

  it("writes to stdout by default", async () => {
    vi.spyOn(run, "inspectSelfUpdate").mockResolvedValue(STATUS);
    vi.spyOn(run, "runSelfUpdate").mockResolvedValue({ kind: "current", latest: "0.7.0" });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { program } = buildProgram();
    registerSelfUpdateCommand(program, OPTIONS);
    await program.parseAsync(["node", "demo", "self-update"]);
    expect(write).toHaveBeenCalledWith("result=current (0.7.0 is the newest release)\n");
  });
});

describe("pure formatters", () => {
  it("describes every outcome kind", () => {
    expect(describeOutcome({ kind: "current", latest: "1.0.0" })).toBe("current (1.0.0 is the newest release)");
    expect(describeOutcome({ kind: "updated", from: "1.0.0", to: "1.1.0" })).toBe("updated 1.0.0 -> 1.1.0");
    expect(describeOutcome({ kind: "notified", latest: "1.1.0", reason: "r" })).toBe("not installed (r)");
    expect(describeOutcome({ kind: "failed", latest: "1.1.0", reason: "r" })).toBe("failed (r)");
    expect(describeOutcome({ kind: "skipped", reason: "r" })).toBe("skipped (r)");
  });

  it("formats an unknown latest without a cause", () => {
    expect(formatSelfUpdateStatus({ ...STATUS, latest: undefined, checkError: undefined })).toContain("latest=unknown");
  });
});
