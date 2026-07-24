import { describe, expect, it, vi } from "vitest";

import {
  fetchJiraCurrentUserProfile,
  parseJiraCurrentUserProfile,
} from "../../src/current-user.js";

const apiRoot = "https://jira-api.example.com/ex/jira";

describe("Jira current user profile", () => {
  it("parses the whoami fields and maps private email values to null", () => {
    expect(parseJiraCurrentUserProfile({
      accountId: "account-1",
      active: true,
      displayName: "Current User",
      emailAddress: "current.user@example.com",
    })).toEqual({
      accountId: "account-1",
      active: true,
      displayName: "Current User",
      emailAddress: "current.user@example.com",
    });
    expect(parseJiraCurrentUserProfile({
      accountId: "account-2",
      active: false,
      displayName: "Private User",
    })).toEqual({
      accountId: "account-2",
      active: false,
      displayName: "Private User",
      emailAddress: null,
    });
    expect(parseJiraCurrentUserProfile({
      accountId: "account-3",
      active: true,
      displayName: "Null Email",
      emailAddress: null,
    })).toMatchObject({ emailAddress: null });
  });

  it("rejects malformed profiles without returning partial data", () => {
    for (const value of [
      { accountId: "", active: true, displayName: "User" },
      { accountId: "account-1", active: "yes", displayName: "User" },
      { accountId: "account-1", active: true, displayName: "" },
      { accountId: "account-1", active: true, displayName: "User", emailAddress: "" },
    ]) {
      expect(() => parseJiraCurrentUserProfile(value)).toThrow(
        "Jira current user profile response was not valid.",
      );
    }
  });

  it("loads the profile through the shared authenticated current-user URL", async () => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response(JSON.stringify({
      accountId: "account-1",
      active: true,
      displayName: "Current User",
      emailAddress: "current.user@example.com",
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })));

    await expect(fetchJiraCurrentUserProfile({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({ accountId: "account-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/myself",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
        },
      },
    );
  });

  it("uses neutral HTTP and response-validation failures", async () => {
    const deniedFetch = vi.fn(async () => await Promise.resolve(
      new Response("secret-access-token", { status: 401 }),
    ));
    await expect(fetchJiraCurrentUserProfile({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: deniedFetch,
    })).rejects.toThrow("Jira current user could not be loaded.");

    const malformedFetch = vi.fn(async () => await Promise.resolve(
      new Response(JSON.stringify({ accountId: "account-1" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ));
    await expect(fetchJiraCurrentUserProfile({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: malformedFetch,
    })).rejects.toThrow("Jira current user profile response was not valid.");

    const invalidJsonFetch = vi.fn(async () => await Promise.resolve(
      new Response("private profile response", { status: 200 }),
    ));
    await expect(fetchJiraCurrentUserProfile({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: invalidJsonFetch,
    })).rejects.toThrow("Jira current user profile response was not valid.");
  });
});
