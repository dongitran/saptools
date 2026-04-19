import type {
  HanaCredentials,
  RawHanaBinding,
  RawHanaCredentials,
  RawVcapServices,
} from "./types.js";

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

function assertRawCredentials(value: unknown): RawHanaCredentials {
  if (typeof value !== "object" || value === null) {
    throw new Error("HANA credentials must be an object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of REQUIRED_CREDENTIAL_FIELDS) {
    if (typeof obj[key] !== "string") {
      throw new Error(`Missing or invalid HANA credential field: "${key}"`);
    }
  }
  return obj as unknown as RawHanaCredentials;
}

function assertRawBinding(value: unknown): RawHanaBinding {
  if (typeof value !== "object" || value === null) {
    throw new Error("HANA binding must be an object");
  }
  const obj = value as Record<string, unknown>;
  const credentials = assertRawCredentials(obj["credentials"]);
  return { credentials };
}

export function parseVcapServices(raw: string): RawVcapServices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VCAP_SERVICES is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("VCAP_SERVICES must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const hanaRaw = obj["hana"];
  if (hanaRaw === undefined) {
    return {};
  }
  if (!Array.isArray(hanaRaw)) {
    throw new Error("VCAP_SERVICES.hana must be an array when present");
  }
  const hana = hanaRaw.map((binding: unknown) => assertRawBinding(binding));
  return { hana };
}

export function extractHanaCredentials(binding: RawHanaBinding): HanaCredentials {
  const c = binding.credentials;
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    schema: c.schema,
    hdiUser: c.hdi_user,
    hdiPassword: c.hdi_password,
    url: c.url,
    databaseId: c.database_id,
    certificate: c.certificate,
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
