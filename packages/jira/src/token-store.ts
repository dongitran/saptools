import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { JiraTokens } from "./types.js";

const JIRA_OAUTH_DIR_NAME = ".jira-oauth";
const JIRA_OAUTH_TOKEN_FILENAME = "tokens.json";

const nonEmptyStringSchema = z.string().min(1);

const JiraTokensSchema = z.object({
  accessToken: nonEmptyStringSchema,
  refreshToken: nonEmptyStringSchema,
  expiresIn: z.number().int().positive(),
  scope: z.string(),
  tokenType: nonEmptyStringSchema,
  cloudId: nonEmptyStringSchema,
  cloudName: nonEmptyStringSchema,
  issuedAt: z.number().int().nonnegative(),
});

export function jiraTokenStorePath(homeDir = homedir()): string {
  return join(homeDir, JIRA_OAUTH_DIR_NAME, JIRA_OAUTH_TOKEN_FILENAME);
}

export function resolveJiraTokenStorePath(tokenStorePath?: string): string {
  return tokenStorePath ?? jiraTokenStorePath();
}

export async function readJiraTokens(tokenStorePath?: string): Promise<JiraTokens | null> {
  try {
    const raw = await readFile(resolveJiraTokenStorePath(tokenStorePath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = JiraTokensSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function writeJiraTokens(
  tokens: JiraTokens,
  tokenStorePath?: string,
): Promise<void> {
  const storePath = resolveJiraTokenStorePath(tokenStorePath);
  const storeDir = dirname(storePath);
  const validatedTokens = JiraTokensSchema.parse(tokens);
  const temporaryPath = `${storePath}.${process.pid.toString()}.${Date.now().toString()}.tmp`;

  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  await chmod(storeDir, 0o700);

  try {
    await writeFile(temporaryPath, `${JSON.stringify(validatedTokens, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, storePath);
    await chmod(storePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function clearJiraTokenStore(tokenStorePath?: string): Promise<void> {
  await rm(resolveJiraTokenStorePath(tokenStorePath), { force: true });
}
