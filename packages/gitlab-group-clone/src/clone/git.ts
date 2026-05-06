import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

function redactToken(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("[REDACTED]");
}

function extractErrorMessage(error: unknown, token: string): string {
  return redactToken(error instanceof Error ? error.message : String(error), token);
}

export interface GitCloneOptions {
  url: string;
  destination: string;
  token: string;
}

export interface GitResult {
  success: boolean;
  error?: string;
}

export function isGitRepo(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}

export function buildHttpsCloneUrl(
  gitlabUrl: string,
  pathWithNamespace: string,
  token: string,
): string {
  const parsed = new URL(gitlabUrl);
  return `https://oauth2:${token}@${parsed.host}/${pathWithNamespace}.git`;
}

export async function gitClone(options: GitCloneOptions): Promise<GitResult> {
  try {
    await execFileAsync("git", ["clone", options.url, options.destination], {
      maxBuffer: MAX_BUFFER,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error, options.token) };
  }
}

export async function gitPull(directory: string, token: string): Promise<GitResult> {
  try {
    await execFileAsync("git", ["-C", directory, "pull", "--ff-only"], {
      maxBuffer: MAX_BUFFER,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error, token) };
  }
}
