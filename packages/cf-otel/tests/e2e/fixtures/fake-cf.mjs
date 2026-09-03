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
  // CF_OTEL_FAKE_CF_SERVICE_KEYS_SHAPE=v6 prints the single-column table CF
  // CLI v6/v7 emitted; the default is v8's three-column table, because that
  // is what a current `cf` actually prints and what the parser regressed on.
  if (process.env.CF_OTEL_FAKE_CF_SERVICE_KEYS_SHAPE === "v6") {
    out("name");
    out("key1");
    out("key2");
    process.exit(0);
  }
  out(`Getting keys for service instance ${args[1]} as user@example.com...`);
  out("");
  out("name   last operation     message");
  out("key1   create succeeded   ");
  out("key2   create succeeded   ");
  process.exit(0);
}

if (cmd === "service-key") {
  const [, instance, keyName] = args;
  trace({ kind: "service-key", instance, keyName });
  // CF_OTEL_FAKE_CF_KEY1_BROKEN makes EVERY key fail (matching the original
  // single-key fixture's behavior) to exercise the fallback-binding path.
  // CF_OTEL_FAKE_CF_ONLY_KEY2_WORKS makes only key1 fail, so a test can prove
  // key2 is tried before key1 rather than merely eventually succeeding.
  // CF_OTEL_FAKE_CF_MINTED_KEY_WORKS exempts a freshly minted `cf-otel-*` key
  // from both, so a test can drive the mint path to success while every
  // pre-existing key still fails.
  const onlyKey2Works = process.env.CF_OTEL_FAKE_CF_ONLY_KEY2_WORKS === "1";
  const isMinted = (keyName ?? "").startsWith("cf-otel-");
  const mintedWorks = isMinted && process.env.CF_OTEL_FAKE_CF_MINTED_KEY_WORKS === "1";
  const broken = mintedWorks
    ? false
    : onlyKey2Works
      ? keyName !== "key2"
      : process.env.CF_OTEL_FAKE_CF_KEY1_BROKEN === "1";
  const fields = { "dashboards-endpoint": DASHBOARDS_URL };
  if (!broken) {
    fields["dashboards-username"] = WORKING_USERNAME;
    fields["dashboards-password"] = WORKING_PASSWORD;
  }
  // CF CLI v8 nests the fields under `credentials`; v7 printed them flat.
  // The wrapper is the default because that is what a current `cf` emits, and
  // reading only the top level is exactly what used to break here.
  const payload = process.env.CF_OTEL_FAKE_CF_KEY_SHAPE === "flat" ? fields : { credentials: fields };
  out(JSON.stringify(payload, null, 2));
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

if (cmd === "delete-service-key") {
  const [, instance, keyName] = args;
  // `forced` is traced so a test can pin the -f flag: without it a real `cf`
  // prompts on stdin and the command would hang until the exec timeout.
  trace({ kind: "delete-service-key", instance, keyName, forced: args.includes("-f") });
  if (process.env.CF_OTEL_FAKE_CF_DELETE_KEY_FAILS === "1") {
    err("Server error, status code: 502, error code: 0, message: ");
  }
  out(`Deleting key ${keyName} for service instance ${instance} as user@example.com...`);
  out("OK");
  process.exit(0);
}

err(`Unsupported cf command in fake: ${args.join(" ")}`);
