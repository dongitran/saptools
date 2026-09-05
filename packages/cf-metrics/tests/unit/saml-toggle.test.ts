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
  return (await readdir(tmpdir())).filter((name) => name.startsWith("cf-metrics-saml-"));
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
 * Every step after `create-service-key` can fail — reading the key back, a
 * payload with no dashboards fields, the broker timing out — and the key name
 * used to be lost with the error, leaving an unusable key on a shared
 * instance, invisible, one per retry.
 */
describe("mintDashboardsCredential key cleanup", () => {
  it("deletes the key it created when a later step fails, and only after restoring SAML", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true,"sp":{"entity_id":"x"}}}');
    const order: string[] = [];
    vi.spyOn(cf, "cfUpdateService").mockImplementation(async () => {
      order.push("update-service");
    });
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    // The key exists server-side, but reading it back fails.
    vi.spyOn(cf, "cfServiceKey").mockRejectedValue(new Error("cf service-key failed: broker timeout"));
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockImplementation(async () => {
      order.push("delete-service-key");
    });

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow(/broker timeout/);

    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(deleteKey.mock.calls[0]?.[1]).toMatch(/^cf-metrics-[0-9a-f]{8}$/);
    // Cleanup is a round trip; doing it before the restore would hold SSO down
    // for every user of the instance that much longer.
    expect(order).toEqual(["update-service", "update-service", "delete-service-key"]);
  });

  it("names the key in the error when the cleanup itself fails, so it can be removed by hand", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true,"sp":{"entity_id":"x"}}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockRejectedValue(new Error("cf service-key failed: broker timeout"));
    vi.spyOn(cf, "cfDeleteServiceKey").mockRejectedValue(new Error("insufficient scope"));

    const caught: unknown = await mintDashboardsCredential(
      "cloud-logging",
      { cfHome: "/tmp/fake" },
      { confirmDisruptive: true },
    ).catch((error: unknown) => error);

    // The original failure survives, with the orphan named alongside it.
    expect((caught as Error).message).toMatch(/broker timeout/);
    expect((caught as Error).message).toMatch(/cf delete-service-key cloud-logging cf-metrics-[0-9a-f]{8} -f/);
  });

  it("deletes nothing when the mint succeeded, since that key is the credential being returned", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true,"sp":{"entity_id":"x"}}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    stubServiceShowSucceeded();
    vi.spyOn(cf, "cfCreateServiceKey").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"minted-pw"}',
    );
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true });

    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("deletes nothing when the failure happened before any key was created", async () => {
    vi.spyOn(cf, "cfServiceParams").mockResolvedValue('{"saml":{"enabled":true,"sp":{"entity_id":"x"}}}');
    vi.spyOn(cf, "cfUpdateService").mockResolvedValue(undefined);
    // The confirmation step fails outright, so minting never reaches a create.
    vi.spyOn(cf, "cfServiceShow").mockRejectedValue(new Error("cf service failed: not authorized"));
    const deleteKey = vi.spyOn(cf, "cfDeleteServiceKey").mockResolvedValue(undefined);

    await expect(
      mintDashboardsCredential("cloud-logging", { cfHome: "/tmp/fake" }, { confirmDisruptive: true }),
    ).rejects.toThrow();

    expect(deleteKey).not.toHaveBeenCalled();
  });
});
