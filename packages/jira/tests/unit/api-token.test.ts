import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  hasJiraApiToken,
  jiraApiTokenSecrets,
  normalizeJiraSiteUrl,
  resolveJiraApiTokenCredential,
} from "../../src/api-token.js";

const token = "static-api-token";
const email = "fred@example.com";
const basic = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

function classicEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    JIRA_API_TOKEN: token,
    JIRA_EMAIL: email,
    JIRA_SITE_URL: "https://acme.atlassian.net",
    ...overrides,
  };
}

describe("Atlassian API token credentials", () => {
  it("returns null when no API token is configured", () => {
    expect(resolveJiraApiTokenCredential({ env: {} })).toBeNull();
    expect(resolveJiraApiTokenCredential({ env: { JIRA_API_TOKEN: "   " } })).toBeNull();
    expect(hasJiraApiToken({ env: {} })).toBe(false);
    expect(hasJiraApiToken({ env: classicEnv() })).toBe(true);
  });

  it("builds a Basic credential against the site URL for a classic token", () => {
    expect(resolveJiraApiTokenCredential({ env: classicEnv() })).toEqual({
      authMode: "api-token",
      authorization: basic,
      baseUrl: "https://acme.atlassian.net",
      cloudId: "acme.atlassian.net",
      cloudName: "acme.atlassian.net",
      email,
      siteUrl: "https://acme.atlassian.net",
    });
  });

  it("builds a Basic credential against the gateway for a scoped token", () => {
    const credential = resolveJiraApiTokenCredential({
      env: { JIRA_API_TOKEN: token, JIRA_CLOUD_ID: "1234-abcd", JIRA_EMAIL: email },
    });

    expect(credential).toMatchObject({
      authorization: basic,
      baseUrl: "https://api.atlassian.com/ex/jira/1234-abcd",
      cloudId: "1234-abcd",
      cloudName: "1234-abcd",
      siteUrl: null,
    });
  });

  it("keeps the real cloud ID as the local state key when a site URL is also configured", () => {
    expect(
      resolveJiraApiTokenCredential({ env: classicEnv({ JIRA_CLOUD_ID: "1234-abcd" }) }),
    ).toMatchObject({
      baseUrl: "https://acme.atlassian.net",
      cloudId: "1234-abcd",
    });
  });

  it("honours the gateway api root override for scoped tokens", () => {
    expect(
      resolveJiraApiTokenCredential(
        { env: { JIRA_API_TOKEN: token, JIRA_CLOUD_ID: "cloud-1", JIRA_EMAIL: email } },
        "http://127.0.0.1:30129/ex/jira/",
      ),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:30129/ex/jira/cloud-1" });
  });

  it("accepts the ATLASSIAN_ and JIRA_BASE_URL aliases", () => {
    expect(
      resolveJiraApiTokenCredential({
        env: {
          ATLASSIAN_API_TOKEN: token,
          ATLASSIAN_EMAIL: email,
          JIRA_BASE_URL: "https://acme.atlassian.net/",
        },
      }),
    ).toMatchObject({ authorization: basic, baseUrl: "https://acme.atlassian.net" });
  });

  it("lets explicit overrides win over the environment", () => {
    expect(
      resolveJiraApiTokenCredential({
        apiToken: "override-token",
        email: "wilma@example.com",
        env: classicEnv(),
        siteUrl: "https://other.atlassian.net",
      }),
    ).toMatchObject({
      authorization: `Basic ${Buffer.from("wilma@example.com:override-token").toString("base64")}`,
      baseUrl: "https://other.atlassian.net",
    });
  });

  it("names the missing companion variable instead of falling back to OAuth", () => {
    expect(() => resolveJiraApiTokenCredential({ env: { JIRA_API_TOKEN: token } })).toThrow(
      "JIRA_EMAIL is required when JIRA_API_TOKEN is set",
    );
    expect(() =>
      resolveJiraApiTokenCredential({ env: { JIRA_API_TOKEN: token, JIRA_EMAIL: email } }),
    ).toThrow("JIRA_SITE_URL or JIRA_CLOUD_ID is required when JIRA_API_TOKEN is set");
  });

  it("names the alias that actually supplied a rejected value", () => {
    expect(() =>
      resolveJiraApiTokenCredential({
        env: { ATLASSIAN_API_TOKEN: token, ATLASSIAN_EMAIL: "not-an-email" },
      }),
    ).toThrow("ATLASSIAN_EMAIL must be the Atlassian account email address");
  });

  it("rejects an email that is not an address, including a pasted token", () => {
    for (const badEmail of ["not-an-email", token, "fred@example.com:extra", "fred @example.com"]) {
      expect(() =>
        resolveJiraApiTokenCredential({ env: classicEnv({ JIRA_EMAIL: badEmail }) }),
      ).toThrow("must be the Atlassian account email address");
    }
  });

  it("rejects credentials carrying control characters that could split a header", () => {
    expect(() =>
      resolveJiraApiTokenCredential({ env: classicEnv({ JIRA_API_TOKEN: "abc\r\nX-Evil: 1" }) }),
    ).toThrow("JIRA_API_TOKEN must not contain control characters");
    expect(() =>
      resolveJiraApiTokenCredential({ env: classicEnv({ JIRA_EMAIL: "fred\n@example.com" }) }),
    ).toThrow("JIRA_EMAIL must not contain control characters");
  });

  it("rejects a site URL that is not http or https", () => {
    for (const badSite of ["acme.atlassian.net", "ftp://acme.atlassian.net", "not a url"]) {
      expect(() =>
        resolveJiraApiTokenCredential({ env: classicEnv({ JIRA_SITE_URL: badSite }) }),
      ).toThrow("must be an http(s) URL");
    }
  });

  it("normalizes a site URL to its origin and path without a trailing slash", () => {
    expect(normalizeJiraSiteUrl("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeJiraSiteUrl("  https://acme.atlassian.net?a=b#c  ")).toBe(
      "https://acme.atlassian.net",
    );
    expect(normalizeJiraSiteUrl("http://127.0.0.1:30129/ex/jira/cloud-1/")).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1",
    );
    expect(normalizeJiraSiteUrl("javascript:alert(1)")).toBeNull();
  });

  it("keeps the port in the local state key so parallel test sites stay isolated", () => {
    expect(
      resolveJiraApiTokenCredential({
        env: classicEnv({ JIRA_SITE_URL: "http://127.0.0.1:30129/ex/jira/cloud-1" }),
      }),
    ).toMatchObject({ cloudId: "127.0.0.1:30129", cloudName: "127.0.0.1:30129" });
  });

  it("lists the raw token and its Basic encoding as strings to mask", () => {
    const secrets = jiraApiTokenSecrets(classicEnv());

    expect(secrets).toContain(token);
    expect(secrets).toContain(Buffer.from(`${email}:${token}`).toString("base64"));
    expect(jiraApiTokenSecrets({})).toEqual([]);
  });
});
