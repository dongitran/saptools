import { z } from "zod";

import type { JiraAssignableUser, JiraAssigneeResolution } from "./types.js";

const nonBlankStringSchema = z.string().trim().min(1);

const JiraAssignableUserSchema = z.object({
  accountId: nonBlankStringSchema,
  active: z.boolean(),
  displayName: nonBlankStringSchema,
});

export class JiraAssigneeAmbiguityError extends Error {
  public readonly candidates: readonly JiraAssignableUser[];
  public readonly issueKey: string;
  public readonly query: string;

  public constructor(issueKey: string, query: string, candidates: readonly JiraAssignableUser[]) {
    super(`Multiple active assignable Jira users match "${query}"; no assignment was changed.`);
    this.name = "JiraAssigneeAmbiguityError";
    this.issueKey = issueKey;
    this.query = query;
    this.candidates = candidates;
  }
}

export function normalizeJiraDisplayName(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

export function parseJiraCurrentUser(value: unknown): JiraAssignableUser {
  const parsed = JiraAssignableUserSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Jira current user response was not valid.");
  }
  return parsed.data;
}

export function parseJiraAssignableUsers(value: unknown): JiraAssignableUser[] {
  const parsed = z.array(JiraAssignableUserSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Jira assignable users response was not valid.");
  }
  return dedupeAssignableUsers(parsed.data);
}

export function activeAssignableUsers(users: readonly JiraAssignableUser[]): JiraAssignableUser[] {
  return users.filter((user) => user.active);
}

export function resolveAssignableUserByQuery(
  issueKey: string,
  query: string,
  users: readonly JiraAssignableUser[],
): JiraAssigneeResolution {
  const activeUsers = activeAssignableUsers(users);
  if (activeUsers.length === 0) {
    throw new Error(`No active assignable Jira user was returned for "${query}" on ${issueKey}.`);
  }

  const normalizedQuery = normalizeJiraDisplayName(query);
  const exact = activeUsers.filter((user) => normalizeJiraDisplayName(user.displayName) === normalizedQuery);
  if (exact.length === 1) {
    return { assignee: requireSingleUser(exact), source: "exact" };
  }
  if (exact.length > 1) {
    throw new JiraAssigneeAmbiguityError(issueKey, query, exact);
  }
  if (activeUsers.length === 1) {
    return { assignee: requireSingleUser(activeUsers), source: "single-fuzzy" };
  }
  throw new JiraAssigneeAmbiguityError(issueKey, query, activeUsers);
}

export function resolveAssignableUserByAccountId(
  issueKey: string,
  accountId: string,
  users: readonly JiraAssignableUser[],
  source: "me" | "account-id",
): JiraAssigneeResolution {
  const matches = activeAssignableUsers(users).filter((user) => user.accountId === accountId);
  if (matches.length === 1) {
    return { assignee: requireSingleUser(matches), source };
  }
  if (matches.length > 1) {
    throw new Error(`Jira returned duplicate active assignable records for account ${accountId}.`);
  }
  const label = source === "me" ? "current user" : `account ${accountId}`;
  throw new Error(`The ${label} is not active or assignable to ${issueKey}; no assignment was changed.`);
}

function requireSingleUser(users: readonly JiraAssignableUser[]): JiraAssignableUser {
  const user = users[0];
  if (user === undefined) {
    throw new Error("Expected one Jira user candidate.");
  }
  return user;
}

function dedupeAssignableUsers(users: readonly JiraAssignableUser[]): JiraAssignableUser[] {
  const byAccountId = new Map<string, JiraAssignableUser>();
  for (const user of users) {
    const existing = byAccountId.get(user.accountId);
    if (existing === undefined) {
      byAccountId.set(user.accountId, user);
      continue;
    }
    if (!sameAssignableUser(existing, user)) {
      throw new Error("Jira assignable users response contained conflicting duplicate account records.");
    }
  }
  return [...byAccountId.values()];
}

function sameAssignableUser(left: JiraAssignableUser, right: JiraAssignableUser): boolean {
  return left.accountId === right.accountId && left.active === right.active && left.displayName === right.displayName;
}
