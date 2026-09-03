import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerResultCommands } from "../../src/cli-results.js";
import * as resultStore from "../../src/result-store.js";
import type { ResultSession } from "../../src/result-store.js";
import type { HanaClientInfo } from "../../src/types.js";

// Exactly the four bindings `cli-results.ts` imports from the store. A factory
// that misses one resolves it to `undefined` and fails at call time rather than
// at type-check time, so this list must be kept in step with that import.
vi.mock("../../src/result-store.js", () => ({
  clearResultSessions: vi.fn(),
  listResultSessions: vi.fn(),
  pruneResultSessions: vi.fn(),
  readResultSession: vi.fn(),
}));

const info: HanaClientInfo = {
  selector: "placeholder/example-org/space/app",
  appName: "app",
  host: "db.example.internal",
  schema: "APP_SCHEMA",
  role: "runtime",
  driver: "fake",
  credentialSource: "live",
};

function session(overrides: Partial<ResultSession> = {}): ResultSession {
  return {
    ref: "q0000000a",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-08T00:00:00.000Z",
    ttlMinutes: 10_080,
    info,
    result: {
      rows: [
        {
          ID: 1,
          NAME: "alpha",
          DOC: '{"items":[{"name":"first"}]}',
          BLOB: Buffer.from([1, 2, 3]),
          NOTES: Buffer.from("lob text", "utf8"),
          WHEN: new Date("2026-06-25T00:00:00.000Z"),
          ACTIVE: true,
          EMPTY: null,
        },
        {
          ID: 2,
          NAME: "beta",
          DOC: '{"items":[]}',
          BLOB: null,
          NOTES: null,
          WHEN: new Date("2026-06-26T00:00:00.000Z"),
          ACTIVE: false,
          EMPTY: null,
        },
      ],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "NAME", typeName: "NVARCHAR" },
        { name: "DOC", typeName: "NCLOB" },
        { name: "BLOB", typeName: "BLOB" },
        { name: "NOTES", typeName: "NCLOB" },
        { name: "WHEN", typeName: "TIMESTAMP" },
        { name: "ACTIVE", typeName: "BOOLEAN" },
        { name: "EMPTY", typeName: "NVARCHAR" },
      ],
      rowCount: 2,
      statement: "select",
      truncated: false,
      elapsedMs: 3,
    },
    directory: "/tmp/placeholder/q0000000a",
    path: "/tmp/placeholder/q0000000a/manifest.json",
    ...overrides,
  };
}

function buildTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerResultCommands(program);
  for (const command of program.commands) {
    command.exitOverride();
    for (const nested of command.commands) {
      nested.exitOverride();
    }
  }
  return program;
}

function captureStdout(): { text: () => string } {
  let buffer = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  });
  return { text: () => buffer };
}

function captureStderr(): { text: () => string } {
  let buffer = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  });
  return { text: () => buffer };
}

async function run(...args: readonly string[]): Promise<void> {
  await buildTestProgram().parseAsync(["node", "cf-hana", ...args]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("result prune", () => {
  it("prints removed=N and nothing else when the store was clean", async () => {
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 3, failed: 0, retainedRefs: [] });
    const output = captureStdout();
    const notices = captureStderr();

    await run("result", "prune");

    expect(output.text()).toBe("removed=3\n");
    expect(notices.text()).toBe("");
  });

  it("exits non-zero when a sweep could not delete something, so a script can tell", async () => {
    const original = process.exitCode;
    try {
      vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 0, failed: 2, retainedRefs: [] });
      captureStdout();
      captureStderr();

      await run("result", "prune");

      expect(process.exitCode).toBe(1);
    } finally {
      // Restore explicitly: an exit code set inside a test outlives it, and
      // would otherwise mark the whole suite failed on a runner that honours it.
      process.exitCode = original;
    }
  });

  it("leaves the exit code alone on a clean sweep", async () => {
    const original = process.exitCode;
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 1, failed: 0, retainedRefs: [] });
    captureStdout();

    await run("result", "prune");

    expect(process.exitCode).toBe(original);
  });

  it("keeps removed=N the only stdout line, reporting retained and failed on stderr", async () => {
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 1, failed: 3, retainedRefs: ["ref0", "ref1"] });
    const output = captureStdout();
    const notices = captureStderr();

    await run("result", "prune");

    expect(output.text()).toBe("removed=1\n");
    expect(notices.text()).toContain("2 saved result(s) were left in place");
    // The refs must be named, not just counted.
    expect(notices.text()).toContain("ref0, ref1");
    expect(notices.text()).toContain("3 expired saved result(s) could not be deleted");
    // The notices must carry the CLI-name prefix every other cf-hana notice uses.
    expect(notices.text()).toContain("cf-hana: ");
  });

  it("does not claim anything was left in place when only a delete failed", async () => {
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 0, failed: 1, retainedRefs: [] });
    captureStdout();
    const notices = captureStderr();

    await run("result", "prune");

    expect(notices.text()).not.toContain("left in place");
    expect(notices.text()).toContain("1 expired saved result(s) could not be deleted");
  });
});

describe("result clear", () => {
  it("prints the number of removed sessions", async () => {
    vi.mocked(resultStore.clearResultSessions).mockResolvedValue(7);
    const output = captureStdout();

    await run("result", "clear");

    expect(output.text()).toBe("removed=7\n");
  });
});

describe("result list", () => {
  it("prints one CSV row per active session", async () => {
    vi.mocked(resultStore.listResultSessions).mockResolvedValue([
      { ref: "q0000000a", createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", rowCount: 2, columnCount: 8, truncated: false },
    ]);
    const output = captureStdout();

    await run("result", "list");

    expect(output.text()).toContain("REF,ROWS,COLUMNS,ROW_TRUNCATED,EXPIRES_AT");
    expect(output.text()).toContain("q0000000a,2,8,false,2026-09-08T00:00:00.000Z");
  });

  it("prints only the header when nothing is saved", async () => {
    vi.mocked(resultStore.listResultSessions).mockResolvedValue([]);
    const output = captureStdout();

    await run("result", "list");

    expect(output.text().trim().split("\n")).toHaveLength(1);
  });
});

describe("result show", () => {
  beforeEach(() => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue(session());
  });

  it("prints a summary when no row is selected", async () => {
    const output = captureStdout();

    await run("result", "show", "q0000000a");

    expect(output.text()).toContain("REF,ROWS,COLUMNS,ROW_TRUNCATED,TRUNCATED_CELLS,EXPIRES_AT");
    expect(output.text()).toContain("q0000000a,2,8,false");
  });

  it("prints the selected row", async () => {
    const output = captureStdout();

    await run("result", "show", "q0000000a", "--row", "2");

    expect(output.text()).toContain("beta");
    expect(output.text()).not.toContain("alpha");
  });

  it("prints one cell window when a column is selected", async () => {
    const output = captureStdout();

    await run("result", "show", "q0000000a", "--row", "1", "--column", "NAME");

    expect(output.text()).toContain("ROW,COLUMN,TYPE,ORIGINAL_LENGTH,OFFSET,VALUE");
    expect(output.text()).toContain("alpha");
  });

  it("walks a JSON pointer inside a text cell", async () => {
    const output = captureStdout();

    await run("result", "show", "q0000000a", "--row", "1", "--column", "DOC", "--path", "/items/0/name");

    expect(output.text()).toContain("PATH,TYPE,VALUE");
    expect(output.text()).toContain("first");
  });

  it.each(["--column", "--path", "--offset"])("rejects %s without --row", async (flag) => {
    const value = flag === "--column" ? "NAME" : flag === "--path" ? "/items" : "0";

    await expect(run("result", "show", "q0000000a", flag, value)).rejects.toThrow(
      /--column, --path, and --offset require --row/,
    );
  });

  it.each(["--path", "--offset"])("rejects %s without --column", async (flag) => {
    const value = flag === "--path" ? "/items" : "0";

    await expect(run("result", "show", "q0000000a", "--row", "1", flag, value)).rejects.toThrow(
      /--path and --offset require --column/,
    );
  });

  it("rejects a row number outside the saved result", async () => {
    // Pin the message: with the range guard gone, `selectResultRow` returns
    // undefined and downstream formatting throws a TypeError, which a bare
    // `toThrow()` would happily accept.
    await expect(run("result", "show", "q0000000a", "--row", "99")).rejects.toThrow(
      /Saved result row 99 not found/,
    );
  });
});

describe("result search", () => {
  it("prints the matches as CSV", async () => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue(session());
    const output = captureStdout();

    await run("result", "search", "q0000000a", "alpha");

    expect(output.text()).toContain("ROW,COLUMN,OFFSET,PATH,PREVIEW");
    expect(output.text()).toContain("alpha");
  });

  it("prints only the header when nothing matches", async () => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue(session());
    const output = captureStdout();

    await run("result", "search", "q0000000a", "no-such-text-anywhere");

    expect(output.text().trim().split("\n")).toHaveLength(1);
  });
});

describe("result export", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cf-hana-cli-results-"));
    vi.mocked(resultStore.readResultSession).mockResolvedValue(session());
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    // A whitespace-only `--output` resolves relative to the working directory,
    // so a regressed guard writes into the package itself. Checked here rather
    // than inside the test, because the test's own `rejects.toThrow` fails
    // first when the guard regresses and an assertion after it would never run.
    const strayPath = "   ";
    const stray = await stat(strayPath).then(() => true, () => false);
    if (stray) {
      await rm(strayPath, { force: true });
    }
    expect(stray).toBe(false);
  });

  it("writes the exact cell value 0600 and prints the path", async () => {
    const output = join(directory, "cell.txt");
    const stdout = captureStdout();

    await run("result", "export", "q0000000a", "--output", output, "--row", "1", "--column", "NAME");

    expect(stdout.text()).toBe(`wrote=${output}\n`);
    await expect(readFile(output, "utf8")).resolves.toBe("alpha");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("writes a text-LOB cell as UTF-8 text rather than raw bytes", async () => {
    const output = join(directory, "cell.txt");
    captureStdout();

    await run("result", "export", "q0000000a", "--output", output, "--row", "1", "--column", "NOTES");

    await expect(readFile(output, "utf8")).resolves.toBe("lob text");
  });

  it("writes a boolean false as a word", async () => {
    const output = join(directory, "cell-false");
    captureStdout();

    await run("result", "export", "q0000000a", "--output", output, "--row", "2", "--column", "ACTIVE");

    await expect(readFile(output, "utf8")).resolves.toBe("false");
  });

  it("writes a binary cell without transcoding it", async () => {
    const output = join(directory, "cell.bin");
    captureStdout();

    await run("result", "export", "q0000000a", "--output", output, "--row", "1", "--column", "BLOB");

    await expect(readFile(output)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it.each([
    ["a timestamp as ISO-8601", "WHEN", "2026-06-25T00:00:00.000Z"],
    ["a boolean as a word", "ACTIVE", "true"],
    ["a null as an empty file", "EMPTY", ""],
  ])("writes %s", async (_description, column, expected) => {
    const output = join(directory, `cell-${column}`);
    captureStdout();

    await run("result", "export", "q0000000a", "--output", output, "--row", "1", "--column", column);

    await expect(readFile(output, "utf8")).resolves.toBe(expected);
  });

  it("requires --row and --column", async () => {
    await expect(
      run("result", "export", "q0000000a", "--output", join(directory, "x"), "--row", "1"),
    ).rejects.toThrow(/result export requires --row and --column/);
  });

  it("rejects a blank --output, which commander's requiredOption still accepts", async () => {
    await expect(
      run("result", "export", "q0000000a", "--output", "   ", "--row", "1", "--column", "NAME"),
    ).rejects.toThrow(/result export requires --output/);
  });
});

describe("numeric option validation", () => {
  beforeEach(() => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue(session());
  });

  it("rejects a non-integer", async () => {
    await expect(run("result", "show", "q0000000a", "--row", "abc")).rejects.toThrow(
      /Expected an integer but received "abc"/,
    );
  });

  it("rejects an integer too large to be exact", async () => {
    await expect(run("result", "show", "q0000000a", "--row", "99999999999999999999")).rejects.toThrow(
      /Expected a safe integer/,
    );
  });

  it("rejects --length above the maximum", async () => {
    await expect(run("result", "show", "q0000000a", "--length", "10001")).rejects.toThrow(
      /--length must be at most 10000/,
    );
  });

  it("rejects a non-positive --length", async () => {
    await expect(run("result", "show", "q0000000a", "--length", "0")).rejects.toThrow(
      /--length must be a positive safe integer/,
    );
  });

  it("rejects a negative --offset", async () => {
    await expect(
      run("result", "show", "q0000000a", "--row", "1", "--column", "NAME", "--offset", "-1"),
    ).rejects.toThrow(/--offset must be a non-negative safe integer/);
  });

  it("rejects a non-positive --limit on search", async () => {
    await expect(run("result", "search", "q0000000a", "alpha", "--limit", "0")).rejects.toThrow(
      /--limit must be a positive safe integer/,
    );
  });
});
