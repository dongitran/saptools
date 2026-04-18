import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import type * as OsModule from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRef, XsuaaCredentials } from "../../src/types.js";

const ref: AppRef = { region: "ap10", org: "o", space: "s", app: "a" };
const creds: XsuaaCredentials = {
  clientId: "cid",
  clientSecret: "csec",
  url: "https://uaa.example.com",
};

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-cmd-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof OsModule>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

describe("fetchSecret", () => {
  it("writes credentials to store", async () => {
    const { fetchSecret } = await import("../../src/commands.js");
    const entry = await fetchSecret(ref, {
      fetchCredentials: async () => await Promise.resolve(creds),
    });
    expect(entry.credentials).toEqual(creds);

    const { readStore } = await import("../../src/store.js");
    const store = await readStore();
    expect(store.entries).toHaveLength(1);
  });

  it("updates existing entry instead of appending", async () => {
    const { fetchSecret } = await import("../../src/commands.js");
    await fetchSecret(ref, { fetchCredentials: async () => await Promise.resolve(creds) });
    await fetchSecret(ref, {
      fetchCredentials: async () => await Promise.resolve({ ...creds, clientSecret: "NEW" }),
    });

    const { readStore } = await import("../../src/store.js");
    const store = await readStore();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.credentials.clientSecret).toBe("NEW");
  });
});

describe("getToken", () => {
  it("fetches secret automatically if not present, then returns token", async () => {
    const { getToken } = await import("../../src/commands.js");
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const token = await getToken(ref, {
      fetchCredentials: async () => await Promise.resolve(creds),
      fetchToken: async () => await Promise.resolve(jwt),
    });
    expect(token).toBe(jwt);

    const { readStore } = await import("../../src/store.js");
    const store = await readStore();
    expect(store.entries[0]?.token?.accessToken).toBe(jwt);
    expect(store.entries[0]?.token?.expiresAt).toMatch(/T/);
  });
});

describe("getTokenCached", () => {
  it("returns cached token if still valid", async () => {
    const { fetchSecret, getTokenCached } = await import("../../src/commands.js");
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await fetchSecret(ref, { fetchCredentials: async () => await Promise.resolve(creds) });

    const { readStore, writeStore, upsertToken } = await import("../../src/store.js");
    const store = await readStore();
    const futureIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await writeStore(upsertToken(store, ref, { accessToken: jwt, expiresAt: futureIso }));

    const tokenFetcher = vi.fn();
    const result = await getTokenCached(ref, { fetchToken: tokenFetcher });
    expect(result).toBe(jwt);
    expect(tokenFetcher).not.toHaveBeenCalled();
  });

  it("refetches when cached token is expired", async () => {
    const { fetchSecret, getTokenCached } = await import("../../src/commands.js");
    const oldJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const newJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await fetchSecret(ref, { fetchCredentials: async () => await Promise.resolve(creds) });

    const { readStore, writeStore, upsertToken } = await import("../../src/store.js");
    const baseStore = await readStore();
    await writeStore(
      upsertToken(baseStore, ref, {
        accessToken: oldJwt,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    const tokenFetcher = vi.fn(async () => await Promise.resolve(newJwt));
    const result = await getTokenCached(ref, { fetchToken: tokenFetcher });
    expect(result).toBe(newJwt);
    expect(tokenFetcher).toHaveBeenCalledOnce();
  });

  it("fetches secret and token when neither is cached", async () => {
    const { getTokenCached } = await import("../../src/commands.js");
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const token = await getTokenCached(ref, {
      fetchCredentials: async () => await Promise.resolve(creds),
      fetchToken: async () => await Promise.resolve(jwt),
    });
    expect(token).toBe(jwt);
  });
});
