import { z } from "zod";

import { assertJiraResponseOk, readJiraHeaders } from "./jira-http.js";
import type { JiraCurrentUserProfile, JiraRequestOptions } from "./types.js";
import { buildJiraCurrentUserUrl } from "./urls.js";

const nonBlankStringSchema = z.string().trim().min(1);

export const JiraCurrentUserProfileSchema = z.object({
  accountId: nonBlankStringSchema,
  active: z.boolean(),
  displayName: nonBlankStringSchema,
  emailAddress: z.string().trim().min(1).nullable().optional(),
});

export function parseJiraCurrentUserProfile(value: unknown): JiraCurrentUserProfile {
  const parsed = JiraCurrentUserProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Jira current user profile response was not valid.");
  }

  return {
    accountId: parsed.data.accountId,
    active: parsed.data.active,
    displayName: parsed.data.displayName,
    emailAddress: parsed.data.emailAddress ?? null,
  };
}

export async function fetchJiraCurrentUserProfile(
  options: JiraRequestOptions,
): Promise<JiraCurrentUserProfile> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(buildJiraCurrentUserUrl(options.cloudId, options.apiRoot), {
    headers: readJiraHeaders(options.accessToken),
  });
  assertJiraResponseOk(response, "Jira current user could not be loaded.");
  try {
    return parseJiraCurrentUserProfile(await response.json());
  } catch {
    throw new Error("Jira current user profile response was not valid.");
  }
}
