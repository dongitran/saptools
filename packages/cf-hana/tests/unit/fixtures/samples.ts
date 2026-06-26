import type { ConnectionConfig } from "../../../src/connection.js";
import type { HanaBinding, HanaBindingCredentials } from "../../../src/types.js";


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

export function sampleBinding(overrides?: Partial<HanaBinding>): HanaBinding {
  return {
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
    autoLimit: 100,
    ...overrides,
  };
}
