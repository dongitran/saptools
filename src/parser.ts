import type { RawHanaCredentials, RawHanaBinding, RawVcapServices, HanaCredentials } from "./types.js";

// Narrow unknown JSON to RawHanaCredentials — throws on invalid shape
function assertRawCredentials(value: unknown): RawHanaCredentials {
  if (typeof value !== "object" || value === null) {
    throw new Error("HANA credentials must be an object");
  }

  const obj = value as Record<string, unknown>;

  const required = ["host", "port", "user", "password", "schema", "hdi_user", "hdi_password", "url", "database_id", "certificate"] as const;

  for (const key of required) {
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

// Parse raw VCAP_SERVICES JSON string into typed structure
export function parseVcapServices(raw: string): RawVcapServices {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("VCAP_SERVICES is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("VCAP_SERVICES must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["hana"])) {
    return {};
  }

  const hana = (obj["hana"] as unknown[]).map(assertRawBinding);

  return { hana };
}

// Map raw HANA binding to the clean output shape
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
