import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createProgram, type CliCommandHandlers } from "../../src/cli/program.js";

function handlers(): CliCommandHandlers {
  return {
    plan: vi.fn(async (): Promise<void> => undefined),
    record: vi.fn(async (): Promise<void> => undefined),
    show: vi.fn(async (): Promise<void> => undefined),
    state: vi.fn(async (): Promise<void> => undefined),
    diff: vi.fn(async (): Promise<void> => undefined),
    runs: vi.fn(async (): Promise<void> => undefined),
    purge: vi.fn(async (): Promise<void> => undefined),
  };
}

describe("cf-function-trace command contract", () => {
  it("reports the version declared by the published package", () => {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Package version metadata is missing");
    }
    const version: unknown = Reflect.get(parsed, "version");
    if (typeof version !== "string") {
      throw new Error("Package version metadata is missing");
    }

    expect(createProgram(handlers()).version()).toBe(version);
  });

  it("passes positional file and function selectors to plan", async () => {
    const plan = vi.fn(async (): Promise<void> => undefined);
    const commandHandlers = { ...handlers(), plan };
    const program = createProgram(commandHandlers);
    await program.parseAsync([
      "node",
      "cf-function-trace",
      "plan",
      "file:///home/vcap/app/dist/service.js",
      "OrderService.create",
      "--port",
      "9229",
      "--call-depth",
      "1",
      "--app-root",
      "/srv/app",
    ]);
    expect(plan).toHaveBeenCalledWith(
      "file:///home/vcap/app/dist/service.js",
      "OrderService.create",
      expect.objectContaining({ port: "9229", callDepth: "1", appRoot: "/srv/app" }),
    );
  });

  it("passes an optional preferred CF tunnel port to record", async () => {
    const record = vi.fn(async (): Promise<void> => undefined);
    const commandHandlers = { ...handlers(), record };
    await createProgram(commandHandlers).parseAsync([
      "node", "cf-function-trace", "record", "file:///app.js", "run",
      "--region", "eu10", "--org", "org-a", "--space", "dev", "--app", "orders",
      "--tunnel-port", "24321", "--confirm-impact",
    ]);
    expect(record).toHaveBeenCalledWith(
      "file:///app.js",
      "run",
      expect.objectContaining({ tunnelPort: "24321" }),
    );
  });

  it("registers record and all offline query commands", async () => {
    const cases = [
      ["record", "file:///app.js", "run", "--port", "9229"],
      ["show", "latest", "--changes-only"],
      ["state", "latest", "--at", "2", "--path", "/frames/0"],
      ["diff", "latest", "--from", "1", "--to", "2"],
      ["runs", "--limit", "10"],
      ["purge", "t0123456789abcdef"],
    ] as const;
    for (const argv of cases) {
      const commandHandlers = handlers();
      await createProgram(commandHandlers).parseAsync(["node", "cf-function-trace", ...argv]);
      const handler = commandHandlers[argv[0]];
      expect(handler).toHaveBeenCalledOnce();
    }
  });
});
