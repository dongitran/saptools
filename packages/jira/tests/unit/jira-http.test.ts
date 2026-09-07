import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  assertJiraResponseOk,
  basicAuthorizationHeader,
  bearerAuthorizationHeader,
  encodeBasicCredential,
  jsonJiraHeaders,
  readJiraHeaders,
} from "../../src/jira-http.js";

describe("Jira HTTP helpers", () => {
  it("builds the RFC 7617 credential Atlassian API tokens require", () => {
    expect(encodeBasicCredential("fred@example.com", "api-token")).toBe(
      Buffer.from("fred@example.com:api-token").toString("base64"),
    );
    expect(basicAuthorizationHeader("fred@example.com", "api-token")).toBe(
      `Basic ${Buffer.from("fred@example.com:api-token").toString("base64")}`,
    );
    expect(bearerAuthorizationHeader("access-token")).toBe("Bearer access-token");
  });

  it("passes any authorization scheme through the request headers unchanged", () => {
    expect(readJiraHeaders("Basic abc")).toEqual({
      Accept: "application/json",
      Authorization: "Basic abc",
    });
    expect(jsonJiraHeaders("Bearer abc")).toEqual({
      Accept: "application/json",
      Authorization: "Bearer abc",
      "Content-Type": "application/json",
    });
  });

  it("accepts any successful response", () => {
    expect(() => {
      assertJiraResponseOk(new Response("ok", { status: 200 }), "Nope.");
    }).not.toThrow();
  });

  it("reports the status line but never the response body", () => {
    expect(() => {
      assertJiraResponseOk(
        new Response("sensitive site detail", { status: 404, statusText: "Not Found" }),
        "Jira issue detail could not be loaded.",
      );
    }).toThrow("Jira issue detail could not be loaded. (HTTP 404 Not Found)");

    try {
      assertJiraResponseOk(new Response("sensitive site detail", { status: 500 }), "Boom.");
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("sensitive site detail");
    }
  });

  it("adds a credential hint to authentication and authorization failures only", () => {
    for (const status of [401, 403]) {
      expect(() => {
        assertJiraResponseOk(new Response(null, { status }), "Boom.");
      }).toThrow("Run `jira status` to see which Jira credentials are active.");
    }

    expect(() => {
      assertJiraResponseOk(new Response(null, { status: 404 }), "Boom.");
    }).not.toThrow("Run `jira status`");
  });

  it("omits an empty status text instead of leaving a dangling space", () => {
    expect(() => {
      assertJiraResponseOk(new Response(null, { status: 429, statusText: "" }), "Boom.");
    }).toThrow("Boom. (HTTP 429)");
  });
});
