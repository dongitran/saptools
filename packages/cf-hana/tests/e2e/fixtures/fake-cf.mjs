#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
const cmd = args[0];

function trace(entry) {
  const file = process.env.CF_HANA_FAKE_CF_TRACE_FILE;
  if (file) appendFileSync(file, JSON.stringify(entry) + "\n");
}

function out(text) {
  process.stdout.write(text + "\n");
}

function err(text) {
  process.stderr.write(text + "\n");
  process.exit(1);
}

function targetReadCount() {
  const file = process.env.CF_HANA_FAKE_CF_TRACE_FILE;
  if (!file) return 0;
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes('"kind":"target-read"')).length;
  } catch {
    return 0;
  }
}

if (cmd === "target") {
  if (args[1] === "-o") {
    trace({ kind: "target-space", org: args[2], space: args[4], cfHome: process.env.CF_HOME ? "isolated" : "current" });
    process.exit(0);
  }
  const apiEndpoint = process.env.CF_HANA_FAKE_CF_API_ENDPOINT ?? "https://api.cf.eu10-005.hana.ondemand.com";
  const retargeted = process.env.CF_HANA_FAKE_CF_RETARGET_AFTER_ENV === "1" && targetReadCount() > 0;
  const org = retargeted ? "different-org" : "example-org";
  trace({ kind: "target-read", apiEndpoint, org, space: "space-demo", cfHome: process.env.CF_HOME ? "isolated" : "current" });
  out(`api endpoint:   ${apiEndpoint}
api version:    3.XX.X
user:           user@example.com
org:            ${org}
space:          space-demo`);
  process.exit(0);
}

if (cmd === "api") {
  const apiEndpoint = args[1] ?? "";
  trace({ kind: "api", apiEndpoint, cfHome: process.env.CF_HOME ? "isolated" : "current" });
  if (apiEndpoint.includes("attacker") || apiEndpoint.startsWith("http://")) err("unsafe endpoint");
  process.exit(0);
}

if (cmd === "auth") {
  trace({ kind: "auth", hasUsername: Boolean(process.env.CF_USERNAME), hasPassword: Boolean(process.env.CF_PASSWORD), cfHome: process.env.CF_HOME ? "isolated" : "current" });
  if (!process.env.CF_USERNAME || !process.env.CF_PASSWORD) err("missing credentials");
  process.exit(0);
}

if (cmd === "env") {
  const app = args[1] || "app-demo";
  const org =
    process.env.CF_HANA_FAKE_CF_AMBIENT_TARGET_ABA === "1"
      ? "different-org"
      : "example-org";
  trace({ kind: "env", app, org, space: "space-demo", cfHome: process.env.CF_HOME ? "isolated" : "current" });
  if (process.env.CF_HANA_FAKE_CF_DIRECT_AUTH_FAIL === "1" && !process.env.CF_HOME) err("not logged in");
  if (app === "app-demo" || app.includes("app-demo")) {
    const vcap = {
      hana: [
        {
          name: "hana-primary",
          credentials: {
            host: "hana.example.internal",
            port: "443",
            user: "DB_USER",
            password: "db-password",
            schema: "APP_SCHEMA",
            hdi_user: "HDI_USER",
            hdi_password: "HDI_PASSWORD",
            url: "jdbc:sap://hana.example.internal:443",
            database_id: "DB-1",
            certificate: "test-certificate",
          },
        },
        ...(process.env.CF_HANA_FAKE_CF_MULTIPLE_BINDINGS === "1"
          ? [
              {
                name: "hana-secondary",
                credentials: {
                  host: "hana.example.internal",
                  port: "443",
                  user: "DB_USER_SECONDARY",
                  password: "db-password-secondary",
                  schema: "APP_SCHEMA",
                  hdi_user: "HDI_USER_SECONDARY",
                  hdi_password: "hdi-password-secondary",
                  url: "jdbc:sap://hana.example.internal:443",
                  database_id: "DB-1",
                  certificate: "test-certificate",
                },
              },
            ]
          : []),
      ],
    };
    const apiEndpoint = process.env.CF_HANA_FAKE_CF_API_ENDPOINT ?? "https://api.cf.eu10-005.hana.ondemand.com";
    const vcapApplication = {
      application_name: app,
      cf_api: apiEndpoint,
      organization_name: org,
      space_name: "space-demo",
    };
    out("VCAP_SERVICES:");
    out(JSON.stringify(vcap));
    out(`VCAP_APPLICATION:${JSON.stringify(vcapApplication)}`);
    process.exit(0);
  }
  err(`App ${app} not found or has no HANA binding (fake)`);
}

if (cmd === "apps") {
  trace({ kind: "apps", cfHome: process.env.CF_HOME ? "isolated" : "current" });
  out("Getting apps in org example-org / space space-demo as user@example.com...");
  out("");
  out("name          requested state   processes   routes");
  out("app-demo      started           web:1/1     app-demo.cf.example.com");
  out("sibling-app   started           web:1/1     sibling-app.cf.example.com");
  process.exit(0);
}

if (cmd === "ssh") {
  const app = args[1];
  const forwardIndex = args.indexOf("-L");
  const forward = forwardIndex === -1 ? undefined : args[forwardIndex + 1];
  trace({ kind: "ssh", app, cfHome: process.env.CF_HOME ? "isolated" : "current" });

  const deniedApps = (process.env.CF_HANA_FAKE_CF_SSH_DENY_APPS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (deniedApps.includes(app)) {
    // Mirrors the live-measured "SSH disabled on this app" shape: a real
    // failure takes several seconds, not milliseconds - simulate a short,
    // deterministic delay instead of literally waiting seconds in CI.
    setTimeout(() => {
      err("You are not authorized to perform the requested action");
    }, 150);
  } else if (forward === undefined) {
    err(`missing -L forward: ${args.join(" ")}`);
  } else {
    const localPort = Number(forward.split(":")[0]);
    const cIndex = args.indexOf("-c");
    const remoteCommand = cIndex === -1 ? undefined : args[cIndex + 1];
    const sleepMatch = remoteCommand ? /^sleep (\d+)$/.exec(remoteCommand) : null;
    const keepaliveSeconds = sleepMatch ? Number(sleepMatch[1]) : 60;

    const server = createServer((socket) => {
      socket.on("error", () => {
        // A probe connecting and immediately disconnecting is expected.
      });
    });
    server.listen(localPort, "127.0.0.1");
    // Mirrors the real remote `sleep <keepalive>` command: the session
    // self-terminates once it elapses, exactly like the genuine tunnel.
    const keepaliveTimer = setTimeout(() => {
      server.close(() => {
        process.exit(0);
      });
    }, keepaliveSeconds * 1000);
    process.on("SIGTERM", () => {
      clearTimeout(keepaliveTimer);
      server.close(() => {
        process.exit(0);
      });
    });
    // Otherwise deliberately does not exit: a real `cf ssh -L` session stays
    // open for the life of its remote command; this fake mirrors that by
    // idling until killed or the keepalive elapses, like the real tunnel.
  }
} else {
  err(`Unsupported cf command in fake: ${args.join(" ")}`);
}
