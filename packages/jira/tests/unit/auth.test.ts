import { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  connectJira,
  disconnectJira,
  getJiraConnectionStatus,
  getStoredOrRefreshJiraTokens,
  isJiraApiTokenPreferred,
  isJiraTokenUsable,
  requireStoredOrRefreshJiraTokens,
  resolveJiraCredential,
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
      authMode: "oauth",
      baseUrl: "https://api.atlassian.com/ex/jira/cloud-1",
      connected: true,
      cloudId: "cloud-1",
      cloudName: "Example Jira",
      email: null,
      siteUrl: null,
      usable: true,
    });
  });

  it("reports disconnected status when the shared token store is empty", async () => {
    await expect(
      getJiraConnectionStatus({
        tokenStorePath: "/tmp/saptools-jira-empty-token-store/tokens.json",
      }),
    ).resolves.toEqual({
      authMode: null,
      baseUrl: null,
      connected: false,
      cloudId: null,
      cloudName: null,
      email: null,
      siteUrl: null,
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

describe("Jira credential precedence", () => {
  const apiTokenEnv = {
    JIRA_API_TOKEN: "static-api-token",
    JIRA_EMAIL: "fred@example.com",
    JIRA_SITE_URL: "https://acme.atlassian.net",
  };

  it("prefers a configured API token over a usable stored OAuth token", async () => {
    const tokenStorePath = await writeTempTokenStore(createTokens({ issuedAt: Date.now() }));

    await expect(
      resolveJiraCredential({ apiToken: { env: apiTokenEnv }, tokenStorePath }),
    ).resolves.toEqual({
      authMode: "api-token",
      authorization: `Basic ${Buffer.from("fred@example.com:static-api-token").toString("base64")}`,
      baseUrl: "https://acme.atlassian.net",
      cloudId: "acme.atlassian.net",
      cloudName: "acme.atlassian.net",
      email: "fred@example.com",
      siteUrl: "https://acme.atlassian.net",
    });
    expect(isJiraApiTokenPreferred({ apiToken: { env: apiTokenEnv } })).toBe(true);
  });

  it("falls back to the OAuth token store when no API token is configured", async () => {
    const tokenStorePath = await writeTempTokenStore(createTokens({ issuedAt: Date.now() }));

    await expect(resolveJiraCredential({ apiToken: { env: {} }, tokenStorePath })).resolves.toEqual({
      authMode: "oauth",
      authorization: "Bearer access-token",
      baseUrl: "https://api.atlassian.com/ex/jira/cloud-1",
      cloudId: "cloud-1",
      cloudName: "Example Jira",
      email: null,
      siteUrl: null,
    });
    expect(isJiraApiTokenPreferred({ apiToken: { env: {} } })).toBe(false);
  });

  it("ignores a configured API token when OAuth is selected explicitly", async () => {
    const tokenStorePath = await writeTempTokenStore(createTokens({ issuedAt: Date.now() }));

    await expect(
      resolveJiraCredential({ apiToken: { env: apiTokenEnv }, authMode: "oauth", tokenStorePath }),
    ).resolves.toMatchObject({ authMode: "oauth", authorization: "Bearer access-token" });
    expect(
      isJiraApiTokenPreferred({ apiToken: { env: apiTokenEnv }, authMode: "oauth" }),
    ).toBe(false);
  });

  it("still reports a half-configured API token as preferred without throwing", () => {
    // `jira connect` warns through this predicate after a successful OAuth login; throwing here
    // would fail a command that actually worked.
    const halfConfigured = { apiToken: { env: { JIRA_API_TOKEN: "static-api-token" } } };

    expect(isJiraApiTokenPreferred(halfConfigured)).toBe(true);
    expect(isJiraApiTokenPreferred({ ...halfConfigured, authMode: "oauth" })).toBe(false);
  });

  it("refuses to fall back to OAuth when the API token mode is required", async () => {
    const tokenStorePath = await writeTempTokenStore(createTokens({ issuedAt: Date.now() }));

    await expect(
      resolveJiraCredential({ apiToken: { env: {} }, authMode: "api-token", tokenStorePath }),
    ).rejects.toThrow("An Atlassian API token is required.");
  });

  it("reports API token status without exposing the credential", async () => {
    const tokenStorePath = await writeTempTokenStore(createTokens({ issuedAt: Date.now() }));
    const status = await getJiraConnectionStatus({ apiToken: { env: apiTokenEnv }, tokenStorePath });

    expect(status).toEqual({
      authMode: "api-token",
      baseUrl: "https://acme.atlassian.net",
      connected: true,
      cloudId: "acme.atlassian.net",
      cloudName: "acme.atlassian.net",
      email: "fred@example.com",
      siteUrl: "https://acme.atlassian.net",
      usable: true,
    });
    expect(JSON.stringify(status)).not.toContain("static-api-token");
  });

  it("routes a scoped API token through the Atlassian gateway", async () => {
    await expect(
      resolveJiraCredential({
        apiToken: {
          env: {
            JIRA_API_TOKEN: "scoped-token",
            JIRA_CLOUD_ID: "1234-abcd",
            JIRA_EMAIL: "fred@example.com",
          },
        },
      }),
    ).resolves.toMatchObject({
      baseUrl: "https://api.atlassian.com/ex/jira/1234-abcd",
      cloudId: "1234-abcd",
      cloudName: "1234-abcd",
    });
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
