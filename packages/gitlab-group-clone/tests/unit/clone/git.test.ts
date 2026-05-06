import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildHttpsCloneUrl, isGitRepo } from "../../../src/clone/git.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify:
    (fn: unknown) =>
    (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        (fn as (...a: unknown[]) => void)(...args, (err: Error | null, stdout = "", stderr = "") => {
          if (err) {
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        });
      }),
}));

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `gitlab-clone-test-${Date.now().toString()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

type ExecFileCb = (err: Error | null, stdout?: string, stderr?: string) => void;

function mockExecFile(cb: (callback: ExecFileCb) => void): void {
  vi.mocked(execFile).mockImplementation(
    ((...args: unknown[]) => {
      cb(args.at(-1) as ExecFileCb);
    }) as typeof execFile,
  );
}

describe("isGitRepo", () => {
  it("returns true when a .git directory exists", () => {
    const repoDir = join(tmpDir, "fake-repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(isGitRepo(repoDir)).toBe(true);
  });

  it("returns false when no .git directory exists", () => {
    const emptyDir = join(tmpDir, "empty-dir");
    mkdirSync(emptyDir, { recursive: true });

    expect(isGitRepo(emptyDir)).toBe(false);
  });

  it("returns false for a non-existent directory", () => {
    expect(isGitRepo(join(tmpDir, "does-not-exist"))).toBe(false);
  });
});

describe("buildHttpsCloneUrl", () => {
  it("embeds the token as oauth2 credential", () => {
    const url = buildHttpsCloneUrl("https://gitlab.com", "mycompany/backend/service", "glpat-abc");
    expect(url).toBe("https://oauth2:glpat-abc@gitlab.com/mycompany/backend/service.git");
  });

  it("uses the correct host for self-hosted instances", () => {
    const url = buildHttpsCloneUrl("https://gitlab.example.com", "org/project", "mytoken");
    expect(url).toBe("https://oauth2:mytoken@gitlab.example.com/org/project.git");
  });

  it("preserves a non-standard port", () => {
    const url = buildHttpsCloneUrl("https://gitlab.internal:8443", "team/repo", "tok");
    expect(url).toBe("https://oauth2:tok@gitlab.internal:8443/team/repo.git");
  });
});

describe("gitClone", () => {
  it("returns success when git exits cleanly", async () => {
    mockExecFile((cb) => { cb(null, "", ""); });

    const { gitClone } = await import("../../../src/clone/git.js");
    const result = await gitClone({
      url: "https://oauth2:tok@gitlab.com/org/repo.git",
      destination: "/tmp/dest",
      token: "tok",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns failure and redacts the token from the error message", async () => {
    const err = new Error("fatal: repository 'https://oauth2:secret@gitlab.com/org/repo.git' not found");
    mockExecFile((cb) => { cb(err); });

    const { gitClone } = await import("../../../src/clone/git.js");
    const result = await gitClone({
      url: "https://oauth2:secret@gitlab.com/org/repo.git",
      destination: "/tmp/dest",
      token: "secret",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("secret");
    expect(result.error).toContain("[REDACTED]");
  });
});

describe("gitPull", () => {
  it("returns success when git pull exits cleanly", async () => {
    mockExecFile((cb) => { cb(null, "Already up to date.", ""); });

    const { gitPull } = await import("../../../src/clone/git.js");
    const result = await gitPull("/some/repo", "tok");
    expect(result.success).toBe(true);
  });

  it("returns failure on error", async () => {
    mockExecFile((cb) => { cb(new Error("merge conflict")); });

    const { gitPull } = await import("../../../src/clone/git.js");
    const result = await gitPull("/some/repo", "tok");
    expect(result.success).toBe(false);
    expect(result.error).toContain("merge conflict");
  });
});
