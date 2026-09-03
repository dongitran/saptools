import { readdir, readFile, writeFile } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import { SamlRestoreFailedError } from "../../src/errors.js";
import { mintDashboardsCredential, redactForLog } from "../../src/saml-toggle.js";

// A real ESM built-in's namespace object can't be spied on directly (`vi.spyOn`
// throws "Module namespace is not configurable"); `vi.mock` substitutes the
// whole module instead. The wrapped writeFile defaults to the REAL
// implementation, so every other test in this file still performs real,
// verifiable filesystem I/O — only a test that explicitly calls
// `vi.mocked(writeFile).mockRejectedValueOnce(...)` sees different behavior,
// and only for that one call (it self-reverts to the real implementation).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

async function listSamlTempDirs(): Promise<readonly string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("cf-otel-saml-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactForLog", () => {
  it("redacts nested saml.sp.signature_private_key-style names by substring match", () => {
    const redacted = redactForLog({
      saml: {
        enabled: false,
        sp: {
          signature_private_key: "-----BEGIN PRIVATE KEY-----",
          signature_private_key_password: "hunter2",
          entity_id: "urn:example:sp",
        },
      },
    }) as { saml: { enabled: boolean; sp: Record<string, unknown> } };

    expect(redacted.saml.enabled).toBe(false);
    expect(redacted.saml.sp["entity_id"]).toBe("urn:example:sp");
    expect(redacted.saml.sp["signature_private_key"]).toBe("[REDACTED]");
    expect(redacted.saml.sp["signature_private_key_password"]).toBe("[REDACTED]");
  });

  it("recurses into arrays", () => {
    const redacted = redactForLog({ certs: [{ password: "x" }] }) as { certs: [{ password: string }] };
    expect(redacted.certs[0].password).toBe("[REDACTED]");
  });

  it("leaves non-sensitive primitive values untouched", () => {
    expect(redactForLog({ a: 1, b: "text", c: true, d: null })).toEqual({ a: 1, b: "text", c: true, d: null });
  });
});

function stubServiceShowSucceeded(): void {
  vi.spyOn(cf, "cfServiceShow").mockResolvedValue("status:    update succeeded\n");
}

describe("mintDashboardsCredential", () => {
  it("disables SAML, mints a key, and restores SAML on success, each mutation exactly once", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true,"sp":{"entity_id":"x"}}}');
    const updateService = vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    stubServiceShowSucceeded();
    const createKey = vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"minted-pw"}',
    );

    const credential = await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    expect(credential).toMatchObject({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "minted-pw" });
    expect(credential.source).toMatch(/^minted:/);
    expect(updateService).toHaveBeenCalledTimes(2); // disable + restore, never retried past that
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it("never attempts a restore when the disable update-service CALL ITSELF fails", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    const updateService = vi.spyOn(cf, "cfUpdateService").mockRejectedValue(new Error("cf update-service failed: timeout"));

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow(/Failed to disable SAML/);
    expect(updateService).toHaveBeenCalledTimes(1);
  });

  it("STILL attempts the restore when the disable succeeds but its confirmation polling fails", async () => {
    // Regression test for a real bug: the disable *mutation* (cfUpdateService)
    // can succeed while the subsequent *confirmation* (cfServiceShow polling)
    // fails for an unrelated reason (e.g. a transient read error) — SAML may
    // now genuinely be disabled server-side, so the restore must still run.
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    const updateService = vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceShow").mockRejectedValue(new Error("transient read failure"));

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    // The restore's own update-service call must have been issued (a second
    // cfUpdateService call, alongside the original disable call) even though
    // confirmation could never succeed (cfServiceShow always rejects) --
    // proving the restore was attempted, not skipped.
    expect(updateService).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(SamlRestoreFailedError);
  });

  it("raises a distinct, loud SamlRestoreFailedError naming the original failure when both steps fail", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    let updateCall = 0;
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      updateCall += 1;
      if (updateCall === 1) {
        return;
      }
      throw new Error("cf update-service failed: network error");
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockRejectedValue(new Error("cf create-service-key failed: quota exceeded"));

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SamlRestoreFailedError);
    const message = (caught as Error).message;
    expect(message).toContain("CRITICAL");
    expect(message).toContain("broken for ALL users");
    expect(message).toContain("quota exceeded");
  });

  it("raises SamlRestoreFailedError even when minting itself succeeded but the restore failed", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    let updateCall = 0;
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      updateCall += 1;
      if (updateCall === 1) {
        return;
      }
      throw new Error("restore failed");
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toBeInstanceOf(SamlRestoreFailedError);
  });

  it("never prints the minted password anywhere, even via a verbose reporter", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"top-secret-value"}',
    );
    const reported: string[] = [];

    await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true, report: (message) => reported.push(message) },
    );

    expect(reported.join("\n")).not.toContain("top-secret-value");
  });

  it("leaves no temp directory behind on the OS filesystem after a successful mint", async () => {
    const before = await listSamlTempDirs();
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    expect(await listSamlTempDirs()).toEqual(before);
  });

  it("leaves no temp directory behind when the disable update-service call fails", async () => {
    const before = await listSamlTempDirs();
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.spyOn(cf, "cfUpdateService").mockRejectedValue(new Error("boom"));

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }).catch(() => undefined);

    expect(await listSamlTempDirs()).toEqual(before);
  });

  it("removes its temp directory even when writing the params file itself fails partway through", async () => {
    // Regression test: mkdtemp can succeed while the subsequent writeFile
    // fails (disk full, permission error) — the directory must still be
    // cleaned up, not just left behind because no file was ever written into it.
    const before = await listSamlTempDirs();
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("ENOSPC: no space left"));

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
    expect(await listSamlTempDirs()).toEqual(before);
  });

  it("writes every other params key's value unchanged, only flipping saml.enabled", async () => {
    // cfUpdateService is called with the real temp file's path while it still
    // exists (cleanup only runs after it returns), so reading it there proves
    // exactly what was written to disk without needing to mock fs at all.
    const originalParams = {
      saml: { enabled: true, sp: { entity_id: "urn:example:sp", signature_private_key: "SECRET_KEY_VALUE" } },
      plan: "standard",
      unrelated: { nested: [1, 2, 3] },
    };
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue(JSON.stringify(originalParams));
    const writtenPayloads: unknown[] = [];
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async (_instance, paramsFilePath) => {
      writtenPayloads.push(JSON.parse(await readFile(paramsFilePath, "utf8")));
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    const [disableWritten, restoreWritten] = writtenPayloads;
    expect(disableWritten).toEqual({ ...originalParams, saml: { ...originalParams.saml, enabled: false } });
    expect(restoreWritten).toEqual(originalParams);
  });

  it("restores saml.enabled to its true original value, not hard-coded true — instance had SAML off to begin with", async () => {
    // Regression test: a freshly provisioned instance with saml.enabled
    // already false (or no saml block at all) reaches this last-resort path
    // whenever it simply has zero service keys/bound apps yet — nothing here
    // implies SAML was ever on. A restore that force-writes enabled=true
    // would permanently turn SSO on for an instance that never had it.
    const originalParams = { saml: { enabled: false, sp: { entity_id: "urn:example:sp" } }, plan: "standard" };
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue(JSON.stringify(originalParams));
    const writtenPayloads: unknown[] = [];
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async (_instance, paramsFilePath) => {
      writtenPayloads.push(JSON.parse(await readFile(paramsFilePath, "utf8")));
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    const [disableWritten, restoreWritten] = writtenPayloads;
    expect(disableWritten).toEqual({ ...originalParams, saml: { ...originalParams.saml, enabled: false } });
    expect(restoreWritten).toEqual(originalParams);
  });

  it("restores saml.enabled to false when the instance never had a saml block at all", async () => {
    const originalParams = { plan: "standard", unrelated: true };
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue(JSON.stringify(originalParams));
    const writtenPayloads: unknown[] = [];
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async (_instance, paramsFilePath) => {
      writtenPayloads.push(JSON.parse(await readFile(paramsFilePath, "utf8")));
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    // Verbatim restore: writing originalParams back byte-for-byte means an
    // instance that never had a saml block at all doesn't get one injected.
    const [, restoreWritten] = writtenPayloads;
    expect(restoreWritten).toEqual(originalParams);
  });

  it("downgrades a restore failure to non-critical when SAML was already off, and never discards the minted credential's real risk profile", async () => {
    // Regression test: the disable step already succeeded and set
    // saml.enabled=false before restore ever runs, so when the original was
    // ALSO false, a failed restore leaves the instance exactly where it
    // started — there is no SSO outage to raise a CRITICAL alarm about.
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":false}}');
    let updateCall = 0;
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      updateCall += 1;
      if (updateCall === 1) {
        return;
      }
      throw new Error("restore failed");
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}',
    );

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SamlRestoreFailedError);
    const message = (caught as Error).message;
    expect(message).toContain("saml.enabled=false");
    expect(message).not.toContain("saml.enabled=true");
    expect(message).not.toContain("CRITICAL");
    expect(message).not.toContain("broken for ALL users");
  });

  it("never leaks a secret value quoted inside a JSON parse error for a malformed params blob", async () => {
    // A malformed payload where the syntax error sits right next to a secret
    // value -- confirms the thrown message never repeats V8's raw parser text.
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"password":\'TopSecretValue4\'}}');

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("TopSecretValue4");
    expect((caught as Error).message).toContain("parse error details omitted");
  });
});

/**
 * The mint path creates a service key on a shared instance. Every failure
 * after that create must take the key away again, or a retry loop leaves a
 * trail of unusable `cf-otel-*` keys nobody can attribute later.
 */
describe("mintDashboardsCredential: the key it created", () => {
  const MINTED_KEY_PATTERN = /^cf-otel-[0-9a-f]{8}$/;

  /** Disable and restore both succeed; the caller decides how the mint itself behaves. */
  function stubWorkingSamlToggle(order: string[] = []): void {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      order.push("update-service");
    });
    stubServiceShowSucceeded();
  }

  it("mints successfully from CF CLI v8's nested credentials payload, and deletes nothing", async () => {
    // Regression test: the mint path reads `cf service-key` directly, so
    // before the wrapper was understood this failed with CREDENTIALS_NOT_FOUND
    // *after* SAML had already been toggled on a shared instance.
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"credentials":{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"minted-pw"}}',
    );
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    const credential = await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    expect(credential).toMatchObject({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "minted-pw" });
    expect(credential.source).toMatch(/^minted:cf-otel-[0-9a-f]{8}$/);
    // The key IS the returned credential; deleting it would destroy it.
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("deletes the key it created when the minted payload carries no basic-auth fields", async () => {
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"credentials":{"dashboards-endpoint":"https://dash.example.com"}}');
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow(/did not contain dashboards-username/);

    expect(deleteKey).toHaveBeenCalledTimes(1);
    const [instance, keyName] = deleteKey.mock.calls[0] ?? [];
    expect(instance).toBe("cloud-logging");
    expect(keyName).toMatch(MINTED_KEY_PATTERN);
  });

  it("deletes the key it created when reading it back fails", async () => {
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockRejectedValue(new Error("cf service-key failed: connection reset"));
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow(/connection reset/);

    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(deleteKey.mock.calls[0]?.[1]).toMatch(MINTED_KEY_PATTERN);
  });

  it("deletes the key even when create-service-key itself failed, since the broker may still have applied it", async () => {
    // `cf create-service-key` is never retried, so a call killed by the exec
    // timeout leaves it unknown whether the key exists. The generated name is
    // unique to this run, and deleting a key that does not exist exits 0.
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockRejectedValue(new Error("cf create-service-key failed: timeout"));
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow(/timeout/);

    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(deleteKey.mock.calls[0]?.[1]).toMatch(MINTED_KEY_PATTERN);
  });

  it("does not attempt a delete when the failure happened before any key name existed", async () => {
    // The confirmation poll runs before the key is named, so there is nothing
    // to clean up and no pointless `cf` call to make.
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceShow").mockRejectedValue(new Error("transient read failure"));
    const createKey = vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toBeInstanceOf(SamlRestoreFailedError);

    expect(createKey).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("deletes only after the SAML restore, never before it", async () => {
    // Cleanup must not extend the window in which SSO is disabled for every
    // user of the instance, so the restore always goes first.
    const order: string[] = [];
    stubWorkingSamlToggle(order);
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"credentials":{"dashboards-endpoint":"https://x"}}');
    vi.spyOn(cf, "cfDeleteServiceKey").mockImplementation(async () => {
      order.push("delete-service-key");
    });

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }).catch(
      () => undefined,
    );

    expect(order).toEqual(["update-service", "update-service", "delete-service-key"]);
  });

  it("keeps the original mint error and appends an actionable note when the delete itself fails", async () => {
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"credentials":{"dashboards-endpoint":"https://x"}}');
    vi.spyOn(cf, "cfDeleteServiceKey").mockRejectedValue(new Error("cf delete-service-key failed: 502 bad gateway"));

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    const message = (caught as Error).message;
    expect(message).toContain("did not contain dashboards-username");
    expect(message).toContain("could not be deleted");
    expect(message).toMatch(/cf delete-service-key cloud-logging cf-otel-[0-9a-f]{8} -f/);
  });

  it("keeps a successfully minted key when the restore fails, and names it in the error", async () => {
    // The credential is thrown away by raising, but the key behind it still
    // works -- deleting it here would destroy the only thing that succeeded.
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true}}');
    let updateCall = 0;
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      updateCall += 1;
      if (updateCall === 1) {
        return;
      }
      throw new Error("restore failed");
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"credentials":{"dashboards-endpoint":"https://x","dashboards-username":"u","dashboards-password":"p"}}',
    );
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SamlRestoreFailedError);
    expect(deleteKey).not.toHaveBeenCalled();
    const message = (caught as Error).message;
    expect(message).toContain("was kept rather than deleted");
    expect(message).toMatch(/cf delete-service-key cloud-logging cf-otel-[0-9a-f]{8} -f/);
  });

  it("never echoes the key payload into the note appended after a failed delete", async () => {
    // A payload that carries a password but not the endpoint/username fails
    // extraction, so the cleanup path runs with a real secret in play. The
    // appended note may name the key and the instance, never the payload.
    stubWorkingSamlToggle();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"credentials":{"dashboards-password":"top-secret-value"}}');
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockRejectedValue(new Error("cf delete-service-key failed: 502"));
    const reported: string[] = [];

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true, report: (message) => reported.push(message) },
    ).catch((error: unknown) => error);

    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect((caught as Error).message).toContain("could not be deleted");
    expect(`${(caught as Error).message}\n${reported.join("\n")}`).not.toContain("top-secret-value");
  });
});
