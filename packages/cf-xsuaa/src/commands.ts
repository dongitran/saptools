import { fetchAppXsuaaCredentials } from "./cf-bridge.js";
import { computeExpiryIso, isExpired } from "./jwt.js";
import { fetchClientCredentialsToken } from "./oauth.js";
import { findEntry, readStore, upsertSecret, upsertToken, writeStore } from "./store.js";
import type { AppRef, CachedToken, FetchSecretFn, FetchTokenFn, XsuaaEntry } from "./types.js";

export interface FetchSecretOptions {
  readonly fetchCredentials?: FetchSecretFn;
  readonly now?: Date;
}

export async function fetchSecret(ref: AppRef, opts: FetchSecretOptions = {}): Promise<XsuaaEntry> {
  const fetcher = opts.fetchCredentials ?? fetchAppXsuaaCredentials;
  const credentials = await fetcher(ref);
  const store = await readStore();
  const updated = upsertSecret(store, ref, credentials, opts.now);
  await writeStore(updated);
  const entry = findEntry(updated, ref);
  if (!entry) {
    throw new Error("fetch-secret: internal error — failed to persist entry");
  }
  return entry;
}

export interface GetTokenOptions {
  readonly fetchCredentials?: FetchSecretFn;
  readonly fetchToken?: FetchTokenFn;
  readonly now?: Date;
}

export async function getToken(ref: AppRef, opts: GetTokenOptions = {}): Promise<string> {
  const tokenFetcher = opts.fetchToken ?? fetchClientCredentialsToken;
  let store = await readStore();
  let entry = findEntry(store, ref);

  if (!entry) {
    entry = await fetchSecret(ref, {
      ...(opts.fetchCredentials ? { fetchCredentials: opts.fetchCredentials } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    store = await readStore();
  }

  const accessToken = await tokenFetcher(entry.credentials);
  const token: CachedToken = {
    accessToken,
    expiresAt: computeExpiryIso(accessToken, opts.now),
  };
  const next = upsertToken(store, ref, token);
  await writeStore(next);
  return accessToken;
}

export type GetTokenCachedOptions = GetTokenOptions;

export async function getTokenCached(ref: AppRef, opts: GetTokenCachedOptions = {}): Promise<string> {
  const store = await readStore();
  const entry = findEntry(store, ref);
  const now = opts.now ?? new Date();
  if (entry?.token && !isExpired(entry.token.expiresAt, now)) {
    return entry.token.accessToken;
  }
  return await getToken(ref, opts);
}
