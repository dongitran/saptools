import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  connectJira,
  disconnectJira,
  getJiraConnectionStatus,
  getStoredOrRefreshJiraTokens,
  isJiraTokenUsable,
  requireStoredOrRefreshJiraTokens,
} from "../../src/auth.js";
import { readJiraTokens, writeJiraTokens } from "../../src/token-store.js";
import type { JiraOAuthClientLike, JiraTokens } from "../../src/types.js";

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

describe("Jira auth", () => {
  it("uses a refresh safety window when checking token usability", () => {
    const tokens = createTokens({ issuedAt: 1_000, expiresIn: 120 });

    expect(isJiraTokenUsable(tokens, 30_000)).toBe(true);
    expect(isJiraTokenUsable(tokens, 70_000)).toBe(false);
  });

  it("reports connection status from the shared token store without requiring app credentials", async () => {
    const storedTokens = createTokens({ issuedAt: Date.now() });
    const tokenStorePath = await writeTempTokenStore(storedTokens);

    await expect(getJiraConnectionStatus({ tokenStorePath })).resolves.toEqual({
      connected: true,
      cloudId: "cloud-1",
      cloudName: "Example Jira",
      usable: true,
    });
  });

  it("reports disconnected status when the shared token store is empty", async () => {
    await expect(
      getJiraConnectionStatus({
        tokenStorePath: "/tmp/saptools-jira-empty-token-store/tokens.json",
      }),
    ).resolves.toEqual({
      connected: false,
      cloudId: null,
      cloudName: null,
      usable: false,
    });
  });

  it("returns usable stored tokens without constructing an OAuth client", async () => {
    const storedTokens = createTokens({ issuedAt: Date.now(), expiresIn: 3600 });
    const tokenStorePath = await writeTempTokenStore(storedTokens);
    const client = createClient();

    await expect(
      getStoredOrRefreshJiraTokens({ tokenStorePath, clientFactory: () => client }),
    ).resolves.toEqual(storedTokens);
    expect(client.refresh).not.toHaveBeenCalled();
  });


  it("returns required stored tokens when they are usable", async () => {
    const storedTokens = createTokens({ issuedAt: Date.now(), expiresIn: 3600 });
    const tokenStorePath = await writeTempTokenStore(storedTokens);

    await expect(requireStoredOrRefreshJiraTokens({ tokenStorePath })).resolves.toEqual(storedTokens);
  });

  it("requires a shared token before running API commands", async () => {
    await expect(
      requireStoredOrRefreshJiraTokens({
        tokenStorePath: "/tmp/saptools-jira-required-token-store/tokens.json",
      }),
    ).rejects.toThrow("Jira token is required.");
  });

  it("returns null instead of starting OAuth when no token has been stored", async () => {
    const client = createClient();

    await expect(
      getStoredOrRefreshJiraTokens({
        tokenStorePath: "/tmp/saptools-jira-missing-token-store.json",
        clientFactory: () => client,
      }),
    ).resolves.toBeNull();
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it("refreshes an expired stored token through the injected OAuth client", async () => {
    const expired = createTokens({ issuedAt: 1_000, expiresIn: 1 });
    const refreshed = createTokens({ accessToken: "fresh-access-token", issuedAt: Date.now() });
    const tokenStorePath = await writeTempTokenStore(expired);
    const client = createClient({ refreshed });

    await expect(
      getStoredOrRefreshJiraTokens({ tokenStorePath, clientFactory: () => client }),
    ).resolves.toEqual(refreshed);
    expect(client.refresh).toHaveBeenCalledWith("refresh-token");
  });

  it("connects through OAuth and disconnects by deleting the shared token store", async () => {
    const connected = createTokens({ issuedAt: Date.now() });
    const tokenStorePath = await writeTempTokenStore(connected);
    const client = createClient({ authenticated: connected });

    await expect(connectJira({ tokenStorePath, clientFactory: () => client })).resolves.toEqual(
      connected,
    );
    expect(client.authenticate).toHaveBeenCalledOnce();

    await disconnectJira({ tokenStorePath });
    await expect(readJiraTokens(tokenStorePath)).resolves.toBeNull();
  });
});

function createClient(options: {
  readonly refreshed?: JiraTokens;
  readonly authenticated?: JiraTokens;
} = {}): JiraOAuthClientLike {
  return {
    getStoredTokens: vi.fn(() => null),
    refresh: vi.fn(async () => await Promise.resolve(options.refreshed ?? createTokens())),
    authenticate: vi.fn(async () => await Promise.resolve(options.authenticated ?? createTokens())),
  };
}

async function writeTempTokenStore(tokens: JiraTokens): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saptools-jira-auth-test-"));
  const path = join(root, "tokens.json");
  await writeJiraTokens(tokens, path);
  return path;
}
