#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

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
  trace({ kind: "target-read", apiEndpoint, cfHome: process.env.CF_HOME ? "isolated" : "current" });
  out(`api endpoint:   ${apiEndpoint}
api version:    3.XX.X
user:           user@example.com
org:            ${retargeted ? "different-org" : "example-org"}
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
  trace({ kind: "env", app, cfHome: process.env.CF_HOME ? "isolated" : "current" });
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
    out("VCAP_SERVICES:");
    out(JSON.stringify(vcap));
    out("VCAP_APPLICATION:{}");
    process.exit(0);
  }
  err(`App ${app} not found or has no HANA binding (fake)`);
}

err(`Unsupported cf command in fake: ${args.join(" ")}`);
