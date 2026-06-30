import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearJiraTokenStore,
  jiraTokenStorePath,
  readJiraTokens,
  writeJiraTokens,
} from "../../src/token-store.js";
import type { JiraTokens } from "../../src/types.js";

let tempRoot: string;

function createTokens(overrides: Partial<JiraTokens> = {}): JiraTokens {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresIn: 3600,
    scope: "read:jira-work",
    tokenType: "Bearer",
    cloudId: "cloud-1",
    cloudName: "Example Jira",
    issuedAt: 1_000,
    ...overrides,
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "saptools-jira-token-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("Jira token store", () => {
  it("uses the same default store layout as JiraOps and jira-oauth-client", () => {
    expect(jiraTokenStorePath("/Users/example")).toBe(
      "/Users/example/.jira-oauth/tokens.json",
    );
  });

  it("returns null when the shared token store is missing or malformed", async () => {
    const path = join(tempRoot, "tokens.json");

    await expect(readJiraTokens(path)).resolves.toBeNull();

    await writeFile(path, JSON.stringify({ accessToken: "" }), "utf8");
    await expect(readJiraTokens(path)).resolves.toBeNull();
  });

  it("writes tokens with owner-only file permissions", async () => {
    const path = join(tempRoot, ".jira-oauth", "tokens.json");
    const tokens = createTokens();

    await writeJiraTokens(tokens, path);

    await expect(readJiraTokens(path)).resolves.toEqual(tokens);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("clears only the requested token file", async () => {
    const path = join(tempRoot, ".jira-oauth", "tokens.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(createTokens()), "utf8");

    await clearJiraTokenStore(path);

    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
