import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { cfApi, cfAuth, cfOrgs, cfTarget, cfTargetSpace, cfApps, cfEnv } from "../src/cf.js";
import { parseVcapServices, extractHanaCredentials } from "../src/parser.js";
import { writeCredentials } from "../src/writer.js";

// ── Config ──────────────────────────────────────────────────────────
const REGION_API = "https://api.cf.ap11.hana.ondemand.com";
const TARGET_ORG = "acmecorp-dev-democorp";
const TARGET_SPACE = "app";
const TEST_APPS = ["demoapp-db-prd", "demoapp-db-config"];
const OUTPUT_FILE = "/tmp/sap-cli-e2e-output.json";

// ── Shared state across tests (login once, reuse session) ───────────
let availableOrgs: string[] = [];
let availableApps: string[] = [];

// ── Guard: skip all tests if env vars are missing ───────────────────
function requireEnv(): { email: string; password: string } {
  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];

  if (!email || !password) {
    throw new Error(
      "E2E tests require SAP_EMAIL and SAP_PASSWORD environment variables.\n" +
        "Run: SAP_EMAIL=you@example.com SAP_PASSWORD=secret npm run e2e",
    );
  }

  return { email, password };
}

// ── Suite ───────────────────────────────────────────────────────────
describe("sap-cli E2E — ap11 real CF environment", () => {

  beforeAll(async () => {
    const { email, password } = requireEnv();

    // Set CF API endpoint and authenticate once for all tests
    await cfApi(REGION_API);
    await cfAuth(email, password);
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Organization discovery
  // ────────────────────────────────────────────────────────────────
  describe("Organization discovery", () => {
    it("fetches at least one org from ap11", async () => {
      availableOrgs = await cfOrgs();

      expect(availableOrgs.length).toBeGreaterThan(0);
    });

    it(`org "${TARGET_ORG}" is accessible`, () => {
      expect(availableOrgs).toContain(TARGET_ORG);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Target org + space
  // ────────────────────────────────────────────────────────────────
  describe("Space targeting", () => {
    it(`targets org "${TARGET_ORG}" and finds space "${TARGET_SPACE}"`, async () => {
      const result = await cfTarget(TARGET_ORG);

      expect(result.spaces).toContain(TARGET_SPACE);
    });

    it(`sets target to ${TARGET_ORG} / ${TARGET_SPACE}`, async () => {
      await expect(cfTargetSpace(TARGET_ORG, TARGET_SPACE)).resolves.toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. App discovery
  // ────────────────────────────────────────────────────────────────
  describe("App discovery", () => {
    it("lists apps in the targeted space", async () => {
      availableApps = await cfApps();

      expect(availableApps.length).toBeGreaterThan(0);
    });

    for (const appName of TEST_APPS) {
      it(`app "${appName}" is present in the space`, () => {
        expect(availableApps).toContain(appName);
      });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 4. HANA credential extraction — per app
  // ────────────────────────────────────────────────────────────────
  describe("HANA credential extraction", () => {
    for (const appName of TEST_APPS) {
      describe(`App: ${appName}`, () => {
        it("fetches CF env with VCAP_SERVICES", async () => {
          const raw = await cfEnv(appName);

          expect(raw).toContain('"hana"');
          expect(raw.startsWith("{")).toBe(true);
        });

        it("parses VCAP_SERVICES into typed HANA binding", async () => {
          const raw = await cfEnv(appName);
          const vcap = parseVcapServices(raw);

          expect(vcap.hana).toBeDefined();
          expect(vcap.hana?.length).toBeGreaterThan(0);
        });

        it("extracts valid HANA credentials (all required fields present)", async () => {
          const raw = await cfEnv(appName);
          const vcap = parseVcapServices(raw);
          const binding = vcap.hana?.[0];

          expect(binding).toBeDefined();

          if (!binding) return;

          const creds = extractHanaCredentials(binding);

          expect(creds.host).toMatch(/\.hanacloud\.ondemand\.com$/);
          expect(creds.port).toBe("443");
          expect(creds.schema).toBeTruthy();
          expect(creds.user).toBeTruthy();
          expect(creds.hdiUser).toBeTruthy();
          expect(creds.password.length).toBeGreaterThan(0);
          expect(creds.hdiPassword.length).toBeGreaterThan(0);
          expect(creds.url).toMatch(/^jdbc:sap:\/\//);
          expect(creds.certificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
          expect(creds.databaseId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
        });
      });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Full pipeline — multi-app extraction + file write
  // ────────────────────────────────────────────────────────────────
  describe("Full pipeline — extract and write", () => {
    beforeAll(async () => {
      // Clean up from previous runs
      if (existsSync(OUTPUT_FILE)) {
        await rm(OUTPUT_FILE);
      }
    });

    it("extracts credentials for all test apps and writes to JSON file", async () => {
      const entries = [];

      for (const appName of TEST_APPS) {
        const raw = await cfEnv(appName);
        const vcap = parseVcapServices(raw);
        const binding = vcap.hana?.[0];

        if (!binding) continue;

        entries.push({
          app: appName,
          org: TARGET_ORG,
          space: TARGET_SPACE,
          region: "ap11" as const,
          hana: extractHanaCredentials(binding),
        });
      }

      expect(entries.length).toBe(TEST_APPS.length);

      const writtenPath = await writeCredentials(entries, OUTPUT_FILE);

      expect(writtenPath).toBe(OUTPUT_FILE);
      expect(existsSync(OUTPUT_FILE)).toBe(true);
    });

    it("output file is valid JSON with correct structure", async () => {
      const content = await readFile(OUTPUT_FILE, "utf-8");
      const parsed: unknown = JSON.parse(content);

      expect(Array.isArray(parsed)).toBe(true);

      const entries = parsed as Array<Record<string, unknown>>;

      expect(entries).toHaveLength(TEST_APPS.length);

      for (const entry of entries) {
        expect(entry["app"]).toBeTruthy();
        expect(entry["org"]).toBe(TARGET_ORG);
        expect(entry["space"]).toBe(TARGET_SPACE);
        expect(entry["region"]).toBe("ap11");
        expect(typeof entry["hana"]).toBe("object");

        const hana = entry["hana"] as Record<string, unknown>;

        expect(typeof hana["host"]).toBe("string");
        expect(typeof hana["password"]).toBe("string");
        expect(typeof hana["certificate"]).toBe("string");
      }
    });

    it("output file contains both test apps", async () => {
      const content = await readFile(OUTPUT_FILE, "utf-8");
      const entries = JSON.parse(content) as Array<{ app: string }>;
      const appNames = entries.map((e) => e.app);

      for (const expectedApp of TEST_APPS) {
        expect(appNames).toContain(expectedApp);
      }
    });
  });
});
