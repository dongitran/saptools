#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];

const DASHBOARDS_URL = process.env.CF_OTEL_FAKE_DASHBOARDS_URL ?? "";
const WORKING_USERNAME = process.env.CF_OTEL_FAKE_DASHBOARDS_USERNAME ?? "fake-dashboards-user";
const WORKING_PASSWORD = process.env.CF_OTEL_FAKE_DASHBOARDS_PASSWORD ?? "fake-dashboards-password";

function trace(entry) {
  const file = process.env.CF_OTEL_FAKE_CF_TRACE_FILE;
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
  process.exit(0);
}

if (cmd === "service-keys") {
  trace({ kind: "service-keys", instance: args[1] });
  // Two keys, oldest-listed first (as real `cf service-keys` lists them) —
  // lets a test prove the CLI tries the last-listed ("newest") one first.
  out("name");
  out("key1");
  out("key2");
  process.exit(0);
}

if (cmd === "service-key") {
  const [, instance, keyName] = args;
  trace({ kind: "service-key", instance, keyName });
  // CF_OTEL_FAKE_CF_KEY1_BROKEN makes EVERY key fail (matching the original
  // single-key fixture's behavior) to exercise the fallback-binding path.
  // CF_OTEL_FAKE_CF_ONLY_KEY2_WORKS makes only key1 fail, so a test can prove
  // key2 is tried before key1 rather than merely eventually succeeding.
  const onlyKey2Works = process.env.CF_OTEL_FAKE_CF_ONLY_KEY2_WORKS === "1";
  const broken = onlyKey2Works ? keyName !== "key2" : process.env.CF_OTEL_FAKE_CF_KEY1_BROKEN === "1";
  if (broken) {
    out(`{\n  "dashboards-endpoint": "${DASHBOARDS_URL}"\n}`);
  } else {
    out(
      `{\n  "dashboards-endpoint": "${DASHBOARDS_URL}",\n  "dashboards-username": "${WORKING_USERNAME}",\n` +
        `  "dashboards-password": "${WORKING_PASSWORD}"\n}`,
    );
  }
  process.exit(0);
}

if (cmd === "env") {
  const app = args[1];
  trace({ kind: "env", app });
  if (app === "legacy-app") {
    const vcap = {
      "cloud-logging": [
        {
          name: "cloud-logging",
          credentials: {
            "dashboards-endpoint": DASHBOARDS_URL,
            "dashboards-username": WORKING_USERNAME,
            "dashboards-password": WORKING_PASSWORD,
          },
        },
      ],
    };
    out("VCAP_SERVICES:");
    out(JSON.stringify(vcap));
    out("VCAP_APPLICATION:{}");
    process.exit(0);
  }
  err(`App ${app} not found (fake)`);
}

if (cmd === "service" && args[2] === "--params") {
  trace({ kind: "service-params", instance: args[1] });
  out(JSON.stringify({ saml: { enabled: true, sp: { entity_id: "urn:example:sp" } } }));
  process.exit(0);
}

if (cmd === "service") {
  trace({ kind: "service-show", instance: args[1] });
  out(`name:      ${args[1]}\nstatus:    update succeeded`);
  process.exit(0);
}

if (cmd === "update-service") {
  trace({ kind: "update-service", instance: args[1] });
  process.exit(0);
}

if (cmd === "create-service-key") {
  trace({ kind: "create-service-key", instance: args[1], keyName: args[2] });
  process.exit(0);
}

err(`Unsupported cf command in fake: ${args.join(" ")}`);
