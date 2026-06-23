import type { AppDbBinding, DbAppView, HanaBindingCredentials } from "@saptools/cf-sync";

import type { ConnectionConfig } from "../../../src/connection.js";

export function sampleCredentials(
  overrides?: Partial<HanaBindingCredentials>,
): HanaBindingCredentials {
  return {
    host: "hana.example.internal",
    port: "443",
    user: "DB_USER",
    password: "db-password",
    schema: "APP_SCHEMA",
    hdiUser: "HDI_USER",
    hdiPassword: "HDI_PASSWORD",
    url: "jdbc:sap://hana.example.internal:443",
    databaseId: "DB-1",
    certificate: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
    ...overrides,
  };
}

export function sampleBinding(overrides?: Partial<AppDbBinding>): AppDbBinding {
  return {
    kind: "hana",
    name: "hana-primary",
    credentials: sampleCredentials(),
    ...overrides,
  };
}

export function sampleConnectionConfig(
  overrides?: Partial<ConnectionConfig>,
): ConnectionConfig {
  return {
    host: "hana.example.internal",
    port: 443,
    user: "DB_USER",
    password: "db-password",
    schema: "APP_SCHEMA",
    certificate: "cert",
    connectTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
    readOnly: false,
    allowDestructive: false,
    autoLimit: 1000,
    ...overrides,
  };
}

export function sampleDbAppView(bindings: readonly AppDbBinding[]): DbAppView {
  return {
    source: "stable",
    entry: {
      selector: "eu10/acme/dev/orders-api",
      regionKey: "eu10",
      orgName: "acme",
      spaceName: "dev",
      appName: "orders-api",
      syncedAt: "2026-05-22T00:00:00.000Z",
      bindings,
    },
    metadata: undefined,
  };
}
