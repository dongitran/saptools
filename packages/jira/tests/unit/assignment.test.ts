import { describe, expect, it } from "vitest";

import {
  JiraAssigneeAmbiguityError,
  normalizeJiraDisplayName,
  parseJiraAssignableUsers,
  parseJiraCurrentUser,
  resolveAssignableUserByAccountId,
  resolveAssignableUserByQuery,
} from "../../src/assignment.js";
import type { JiraAssignableUser } from "../../src/types.js";

const active = (accountId: string, displayName: string): JiraAssignableUser => ({
  accountId,
  active: true,
  displayName,
});

const inactive = (accountId: string, displayName: string): JiraAssignableUser => ({
  accountId,
  active: false,
  displayName,
});
const wideTran = "\uFF34\uFF52\uFF41\uFF4E";

describe("Jira assignee resolution", () => {
  it("normalizes display names for exact equality only", () => {
    expect(normalizeJiraDisplayName(`  EXAMPLE   ${wideTran}  `)).toBe("example tran");
  });

  it("validates current-user and assignable-user responses", () => {
    expect(parseJiraCurrentUser(active("account-1", "Example User"))).toEqual(active("account-1", "Example User"));
    expect(parseJiraAssignableUsers([active("account-1", "Example User")])).toEqual([active("account-1", "Example User")]);
    expect(() => parseJiraCurrentUser({ accountId: " ", active: true, displayName: "User" })).toThrow("current user response");
    expect(() => parseJiraAssignableUsers({ values: [] })).toThrow("assignable users response");
    expect(() => parseJiraAssignableUsers([{ accountId: "a", displayName: "User" }])).toThrow("assignable users response");
  });

  it("deduplicates identical account records and rejects conflicting duplicates", () => {
    expect(parseJiraAssignableUsers([active("a", "User"), active("a", "User")])).toEqual([active("a", "User")]);
    expect(() => parseJiraAssignableUsers([active("a", "User"), inactive("a", "User")])).toThrow("conflicting duplicate");
  });

  it("selects exact and single-fuzzy matches without relying on Jira ordering", () => {
    expect(resolveAssignableUserByQuery("OPS-1", "Example", [active("a", "Example")])).toMatchObject({ source: "exact" });
    expect(resolveAssignableUserByQuery("OPS-1", "Sample", [active("a", "Example")])).toMatchObject({ source: "single-fuzzy" });
    expect(resolveAssignableUserByQuery("OPS-1", "example tran", [
      active("b", "Another Tran"),
      active("a", " Example   Tran "),
      active("c", "Third Tran"),
    ])).toMatchObject({ assignee: { accountId: "a" }, source: "exact" });
  });

  it("treats unresolved multiple users and duplicate exact display names as ambiguous", () => {
    expect(() => resolveAssignableUserByQuery("OPS-1", "Exam Tran", [
      active("a", "Example Tran"),
      active("b", "Another Tran"),
    ])).toThrow(JiraAssigneeAmbiguityError);
    expect(() => resolveAssignableUserByQuery("OPS-1", "Example Tran", [
      active("a", "Example Tran"),
      active("b", "example  tran"),
    ])).toThrow(JiraAssigneeAmbiguityError);
  });

  it("rejects empty or inactive candidate sets", () => {
    expect(() => resolveAssignableUserByQuery("OPS-1", "Example", [])).toThrow("No active assignable");
    expect(() => resolveAssignableUserByQuery("OPS-1", "Example", [inactive("a", "Example")])).toThrow("No active assignable");
  });

  it("resolves account IDs only when the exact active account is present", () => {
    expect(resolveAssignableUserByAccountId("OPS-1", "a", [active("a", "User")], "account-id")).toMatchObject({ source: "account-id" });
    expect(() => resolveAssignableUserByAccountId("OPS-1", "a", [active("b", "Other")], "account-id")).toThrow("not active or assignable");
    expect(() => resolveAssignableUserByAccountId("OPS-1", "a", [inactive("a", "User")], "me")).toThrow("not active or assignable");
  });
});
