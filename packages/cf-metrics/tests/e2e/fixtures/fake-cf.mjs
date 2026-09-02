#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];

const DASHBOARDS_URL = process.env.CF_METRICS_FAKE_DASHBOARDS_URL ?? "";
const WORKING_USERNAME = process.env.CF_METRICS_FAKE_DASHBOARDS_USERNAME ?? "fake-dashboards-user";
const WORKING_PASSWORD = process.env.CF_METRICS_FAKE_DASHBOARDS_PASSWORD ?? "fake-dashboards-password";
const MULTI_INSTANCE = process.env.CF_METRICS_FAKE_CF_MULTI_INSTANCE === "1";
// Simulates a machine with no `cf login` at all, so the CLI has to take the
// isolated-login path (cf api/auth/target in a temporary CF_HOME). Without it
// the fake reports a session already targeting exactly what the tests ask for,
// and the CLI reuses that session the way it would a real one.
const NO_SESSION = process.env.CF_METRICS_FAKE_CF_NO_SESSION === "1";

// Hold the session open long enough for a test to interrupt the CLI while a
// temporary CF_HOME exists, which is the only window the leak can occur in.
const SLOW_MS = Number(process.env.CF_METRICS_FAKE_CF_SLOW_MS ?? "0");
if (SLOW_MS > 0 && cmd === "auth") {
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
}

function trace(entry) {
  const file = process.env.CF_METRICS_FAKE_CF_TRACE_FILE;
  if (file) {
    appendFileSync(file, `${JSON.stringify({ ...entry, cfHome: process.env.CF_HOME ?? null })}\n`);
  }
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function err(text) {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

if (cmd === "target") {
  if (args[1] === "-o") {
    trace({ kind: "target-space", org: args[2], space: args[4] });
    process.exit(0);
  }
  trace({ kind: "target-read" });
  if (NO_SESSION) {
    err("FAILED\nNot logged in. Use 'cf login' or 'cf login --sso' to log in.");
  }
  out(
    "api endpoint:   https://api.cf.eu10.hana.ondemand.com\n" +
      "api version:    3.181.0\n" +
      "user:           user@example.com\n" +
      "org:            example-org\n" +
      "space:          space-demo",
  );
  process.exit(0);
}

if (cmd === "api") {
  trace({ kind: "api", apiEndpoint: args[1] });
  process.exit(0);
}

if (cmd === "auth") {
  trace({ kind: "auth", hasUsername: Boolean(process.env.CF_USERNAME), hasPassword: Boolean(process.env.CF_PASSWORD) });
  if (!process.env.CF_USERNAME || !process.env.CF_PASSWORD) {
    err("missing credentials");
  }
  process.exit(0);
}

const SPACE_GUID = "1af3e621-59f5-439c-9838-4508ae8be431";
const INSTANCE_GUID = "11111111-2222-3333-4444-555555555555";
const SECOND_INSTANCE_GUID = "66666666-7777-8888-9999-000000000000";

if (cmd === "space" && args.includes("--guid")) {
  trace({ kind: "space-guid", space: args[1] });
  out(SPACE_GUID);
  process.exit(0);
}

// Two service keys and one pre-SAML app binding, mirroring the real v3 shape.
// `created_at` drives ordering: keys newest-first, app bindings oldest-first.
const BINDINGS = [
  { guid: "key-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" },
  { guid: "key-2", type: "key", name: "key2", created_at: "2026-02-01T00:00:00Z" },
  { guid: "bind-1", type: "app", name: null, created_at: "2025-01-01T00:00:00Z", appGuid: "app-1", appName: "legacy-app" },
];

if (cmd === "service" && args.includes("--guid")) {
  trace({ kind: "service-guid", instance: args[1] });
  out(INSTANCE_GUID);
  process.exit(0);
}

if (cmd === "curl") {
  const path = args[1] ?? "";

  // The v3 listing that replaced `cf services`: instances reference plans,
  // plans reference offerings, and both sidecars arrive under `included`
  // because the CLI asked for them with `fields[...]`.
  if (path.startsWith("/v3/service_instances?")) {
    trace({ kind: "list-instances" });
    const instances = [
      { guid: INSTANCE_GUID, name: "cloud-logging" },
      ...(MULTI_INSTANCE ? [{ guid: SECOND_INSTANCE_GUID, name: "cloud-logging-2" }] : []),
      { guid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "some-hana", plan: "plan-hana" },
    ];
    out(
      JSON.stringify({
        pagination: { total_results: instances.length, total_pages: 1 },
        resources: instances.map((instance) => ({
          guid: instance.guid,
          name: instance.name,
          type: "managed",
          relationships: { service_plan: { data: { guid: instance.plan ?? "plan-logging" } } },
        })),
        included: {
          service_plans: [
            { guid: "plan-logging", name: "standard", relationships: { service_offering: { data: { guid: "offering-logging" } } } },
            { guid: "plan-hana", name: "hdi-shared", relationships: { service_offering: { data: { guid: "offering-hana" } } } },
          ],
          service_offerings: [
            { guid: "offering-logging", name: "cloud-logging" },
            { guid: "offering-hana", name: "hana" },
          ],
        },
      }),
    );
    process.exit(0);
  }

  const details = /service_credential_bindings\/([^/]+)\/details/.exec(path);

  if (details === null) {
    trace({ kind: "list-bindings" });
    out(
      JSON.stringify({
        pagination: { total_results: BINDINGS.length, total_pages: 1 },
        resources: BINDINGS.map((b) => ({
          guid: b.guid,
          type: b.type,
          name: b.name,
          created_at: b.created_at,
          relationships: b.appGuid ? { app: { data: { guid: b.appGuid } } } : {},
        })),
        included: {
          apps: BINDINGS.filter((b) => b.appGuid).map((b) => ({ guid: b.appGuid, name: b.appName })),
        },
      }),
    );
    process.exit(0);
  }

  const guid = details[1];
  const binding = BINDINGS.find((b) => b.guid === guid);
  trace({ kind: "binding-details", guid, name: binding?.name ?? binding?.appName });

  // CF_METRICS_FAKE_CF_KEY1_BROKEN makes EVERY key fail, to exercise the
  // app-binding fallback. CF_METRICS_FAKE_CF_ONLY_KEY2_WORKS makes only key1
  // fail, so a test can prove key2 is tried before key1.
  const onlyKey2Works = process.env.CF_METRICS_FAKE_CF_ONLY_KEY2_WORKS === "1";
  const isKey = binding?.type === "key";
  const broken = isKey
    ? onlyKey2Works
      ? binding.name !== "key2"
      : process.env.CF_METRICS_FAKE_CF_KEY1_BROKEN === "1"
    : false;

  const credentials = { "dashboards-endpoint": DASHBOARDS_URL };
  if (!broken) {
    credentials["dashboards-username"] = WORKING_USERNAME;
    credentials["dashboards-password"] = WORKING_PASSWORD;
  }
  out(JSON.stringify({ credentials }));
  process.exit(0);
}

if (cmd === "create-service-key") {
  trace({ kind: "create-service-key", instance: args[1], keyName: args[2] });
  process.exit(0);
}

err(`Unsupported cf command in fake: ${args.join(" ")}`);
