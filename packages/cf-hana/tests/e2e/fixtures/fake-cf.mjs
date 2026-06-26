#!/usr/bin/env node

// Minimal fake cf for cf-hana e2e tests.
// Supports the commands needed for live binding resolution:
//   cf target
//   cf api ...
//   cf auth ...
//   cf target -o ... -s ...
//   cf env <app>

const args = process.argv.slice(2);
const cmd = args[0];

function out(text) {
  process.stdout.write(text + "\n");
}

function err(text) {
  process.stderr.write(text + "\n");
  process.exit(1);
}

if (cmd === "target") {
  if (args[1] === "-o") {
    // target space is a no-op success in fake
    process.exit(0);
  }
  // default current target for tests
  out(`api endpoint:   https://api.cf.eu10.hana.ondemand.com
api version:    3.XX.X
user:           user@example.com
org:            example-org
space:          space-demo`);
  process.exit(0);
}

if (cmd === "api") {
  // success
  process.exit(0);
}

if (cmd === "auth") {
  // success (creds are validated by test env presence)
  process.exit(0);
}

if (cmd === "env") {
  const app = args[1] || "app-demo";
  if (app === "app-demo" || app.includes("app-demo")) {
    // Return realistic VCAP output matching what extractVcapServicesSection expects
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