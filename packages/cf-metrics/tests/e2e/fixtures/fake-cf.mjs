#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];

const DASHBOARDS_URL = process.env.CF_METRICS_FAKE_DASHBOARDS_URL ?? "";
const WORKING_USERNAME = process.env.CF_METRICS_FAKE_DASHBOARDS_USERNAME ?? "fake-dashboards-user";
const WORKING_PASSWORD = process.env.CF_METRICS_FAKE_DASHBOARDS_PASSWORD ?? "fake-dashboards-password";
const MULTI_INSTANCE = process.env.CF_METRICS_FAKE_CF_MULTI_INSTANCE === "1";

function trace(entry) {
  const file = process.env.CF_METRICS_FAKE_CF_TRACE_FILE;
  if (file) {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
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

if (cmd === "services") {
  trace({ kind: "services" });
  out("name            offering        plan       bound apps    last operation");
  out("cloud-logging   cloud-logging   standard   legacy-app    create succeeded");
  if (MULTI_INSTANCE) {
    out("cloud-logging-2 cloud-logging   standard   legacy-app    create succeeded");
  }
  process.exit(0);
}

const INSTANCE_GUID = "11111111-2222-3333-4444-555555555555";
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
