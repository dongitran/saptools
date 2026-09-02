import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage, isRecord, readString } from "../records.js";

import { parseSemver } from "./semver.js";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const REGISTRY_ENV = "SAPTOOLS_NPM_REGISTRY";
/**
 * The registry answers in ~0.5 s from Asia; two seconds separates "slow" from
 * "offline or captive portal" without holding up a 1.5 s command for long.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

export type LatestVersionResult =
  | { readonly ok: true; readonly latest: string }
  | { readonly ok: false; readonly reason: string };

export interface FetchLatestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export function normalizeRegistryUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    return;
  }
  return trimmed;
}

function registryFromNpmrc(text: string | undefined, key: string): string | undefined {
  if (text === undefined) {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== key) {
      continue;
    }
    return trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return;
}

/** `~/.npmrc` as text, or undefined when absent; the project-level `.npmrc` is deliberately ignored (see resolveRegistryUrl). */
export function readUserNpmrc(homeDirectory: string): string | undefined {
  try {
    return readFileSync(join(homeDirectory, ".npmrc"), "utf8");
  } catch {
    return;
  }
}

/**
 * Registry precedence: explicit saptools override, the registry npm itself was
 * configured with when it launched us, the user's `~/.npmrc` (scoped entry
 * first), then npmjs. The current directory's `.npmrc` is ignored on purpose:
 * a project's private registry has nothing to do with where the user's global
 * CLI came from.
 */
export function resolveRegistryUrl(env: NodeJS.ProcessEnv, userNpmrc: string | undefined): string {
  const candidates = [
    env[REGISTRY_ENV],
    env["npm_config_registry"],
    registryFromNpmrc(userNpmrc, "@saptools:registry"),
    registryFromNpmrc(userNpmrc, "registry"),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeRegistryUrl(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return DEFAULT_NPM_REGISTRY;
}

type JsonResponse =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: number | undefined; readonly reason: string };

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonResponse> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `HTTP ${String(response.status)} from ${url}` };
    }
    const body: unknown = await response.json();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, status: undefined, reason: `${errorMessage(error)} (${url})` };
  }
}

function readLatestTag(body: unknown, nestedUnderDistTags: boolean): string | undefined {
  if (!isRecord(body)) {
    return;
  }
  const tags = nestedUnderDistTags ? body["dist-tags"] : body;
  if (!isRecord(tags)) {
    return;
  }
  const latest = readString(tags, "latest");
  return latest !== undefined && parseSemver(latest) !== undefined ? latest : undefined;
}

/**
 * Ask the registry for the `latest` dist-tag. The dedicated dist-tags endpoint
 * is 18 bytes; registries that do not implement it (some private mirrors) get
 * a second try through the abbreviated packument. A network failure on the
 * first request is not retried: the registry is unreachable, not old.
 */
export async function fetchLatestVersion(
  packageName: string,
  registryUrl: string,
  options: FetchLatestOptions = {},
): Promise<LatestVersionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const encoded = encodeURIComponent(packageName);
  const baseHeaders: Record<string, string> = { "user-agent": options.userAgent ?? "saptools-self-update" };

  const distTags = await fetchJson(fetchImpl, `${registryUrl}/-/package/${encoded}/dist-tags`, { ...baseHeaders, accept: "application/json" }, timeoutMs);
  if (distTags.ok) {
    const latest = readLatestTag(distTags.body, false);
    return latest === undefined ? { ok: false, reason: "dist-tags response carries no valid latest version" } : { ok: true, latest };
  }
  if (distTags.status === undefined) {
    return { ok: false, reason: distTags.reason };
  }

  const packument = await fetchJson(
    fetchImpl,
    `${registryUrl}/${encoded}`,
    { ...baseHeaders, accept: "application/vnd.npm.install-v1+json" },
    timeoutMs,
  );
  if (!packument.ok) {
    return { ok: false, reason: packument.reason };
  }
  const latest = readLatestTag(packument.body, true);
  return latest === undefined ? { ok: false, reason: "packument carries no valid latest dist-tag" } : { ok: true, latest };
}
