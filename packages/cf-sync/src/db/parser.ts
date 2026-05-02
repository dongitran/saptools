import type { AppDbBinding, HanaBindingCredentials } from "../types.js";

interface RawHanaCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdi_user: string;
  readonly hdi_password: string;
  readonly url: string;
  readonly database_id: string;
  readonly certificate: string;
}

interface RawHanaBinding {
  readonly credentials: RawHanaCredentials;
  readonly name?: string;
  readonly label?: string;
  readonly plan?: string;
}

const REQUIRED_CREDENTIAL_FIELDS = [
  "host",
  "port",
  "user",
  "password",
  "schema",
  "hdi_user",
  "hdi_password",
  "url",
  "database_id",
  "certificate",
] as const satisfies readonly (keyof RawHanaCredentials)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function assertRawCredentials(value: unknown): RawHanaCredentials {
  if (!isRecord(value)) {
    throw new Error("HANA credentials must be an object");
  }

  for (const key of REQUIRED_CREDENTIAL_FIELDS) {
    if (typeof value[key] !== "string") {
      throw new Error(`Missing or invalid HANA credential field: "${key}"`);
    }
  }

  return value as unknown as RawHanaCredentials;
}

function assertRawBinding(value: unknown): RawHanaBinding {
  if (!isRecord(value)) {
    throw new Error("HANA binding must be an object");
  }

  const name = readOptionalString(value, "name");
  const label = readOptionalString(value, "label");
  const plan = readOptionalString(value, "plan");

  return {
    credentials: assertRawCredentials(value["credentials"]),
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
    ...(plan ? { plan } : {}),
  };
}

function mapCredentials(value: RawHanaCredentials): HanaBindingCredentials {
  return {
    host: value.host,
    port: value.port,
    user: value.user,
    password: value.password,
    schema: value.schema,
    hdiUser: value.hdi_user,
    hdiPassword: value.hdi_password,
    url: value.url,
    databaseId: value.database_id,
    certificate: value.certificate,
  };
}

export function extractVcapServicesSection(cfEnvStdout: string): string {
  const startMarker = "VCAP_SERVICES:";
  const endMarker = "VCAP_APPLICATION:";
  const startIdx = cfEnvStdout.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error("VCAP_SERVICES section not found in cf env output");
  }

  const afterStart = cfEnvStdout.slice(startIdx + startMarker.length);
  const endIdx = afterStart.indexOf(endMarker);
  const block = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);
  return block.trim();
}

export function parseHanaBindings(raw: string): readonly AppDbBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VCAP_SERVICES is not valid JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("VCAP_SERVICES must be a JSON object");
  }

  const hanaRaw = parsed["hana"];
  if (hanaRaw === undefined) {
    return [];
  }

  if (!Array.isArray(hanaRaw)) {
    throw new Error("VCAP_SERVICES.hana must be an array when present");
  }

  return hanaRaw.map((binding): AppDbBinding => {
    const parsedBinding = assertRawBinding(binding);
    return {
      kind: "hana",
      credentials: mapCredentials(parsedBinding.credentials),
      ...(parsedBinding.name ? { name: parsedBinding.name } : {}),
      ...(parsedBinding.label ? { label: parsedBinding.label } : {}),
      ...(parsedBinding.plan ? { plan: parsedBinding.plan } : {}),
    };
  });
}

export function extractHanaBindingsFromCfEnv(cfEnvStdout: string): readonly AppDbBinding[] {
  return parseHanaBindings(extractVcapServicesSection(cfEnvStdout));
}
