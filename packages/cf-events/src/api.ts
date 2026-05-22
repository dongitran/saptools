import type {
  AppSummary,
  AuditEvent,
  CfEntityRef,
  FetchAuditEventsInput,
  ProcessInstanceStat,
  SshEnabled,
} from "./types.js";

/** Calls a Cloud Foundry v3 API path and returns the raw response body. */
export type CurlFn = (path: string) => Promise<string>;

const MAX_PER_PAGE = 100;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("The CF API returned a response that is not valid JSON.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapEntityRef(value: unknown): CfEntityRef {
  const record = asRecord(value);
  return {
    guid: asString(record["guid"]),
    type: asString(record["type"]),
    name: asString(record["name"]),
  };
}

function optionalGuid(value: unknown): string | undefined {
  const guid = asString(asRecord(value)["guid"]);
  return guid.length > 0 ? guid : undefined;
}

function mapAuditEvent(value: unknown): AuditEvent {
  const record = asRecord(value);
  return {
    guid: asString(record["guid"]),
    type: asString(record["type"]),
    createdAt: asString(record["created_at"]),
    updatedAt: asString(record["updated_at"]),
    actor: mapEntityRef(record["actor"]),
    target: mapEntityRef(record["target"]),
    data: asRecord(record["data"]),
    spaceGuid: optionalGuid(record["space"]),
    organizationGuid: optionalGuid(record["organization"]),
  };
}

function mapProcessStat(value: unknown): ProcessInstanceStat {
  const record = asRecord(value);
  const usage = asRecord(record["usage"]);
  return {
    type: asString(record["type"]),
    index: asNumber(record["index"]) ?? 0,
    state: asString(record["state"]),
    uptimeSeconds: asNumber(record["uptime"]),
    cpu: asNumber(usage["cpu"]),
    memBytes: asNumber(usage["mem"]),
    memQuotaBytes: asNumber(record["mem_quota"]),
    diskBytes: asNumber(usage["disk"]),
    diskQuotaBytes: asNumber(record["disk_quota"]),
  };
}

export function buildAuditEventsPath(input: FetchAuditEventsInput, perPage: number): string {
  const params = new URLSearchParams();
  params.set("target_guids", input.appGuid);
  params.set("order_by", "-created_at");
  params.set("per_page", perPage.toString());
  if (input.types !== undefined && input.types.length > 0) {
    params.set("types", input.types.join(","));
  }
  if (input.createdAfter !== undefined) {
    params.set("created_ats[gt]", input.createdAfter);
  }
  return `/v3/audit_events?${params.toString()}`;
}

function nextPagePath(body: unknown): string | undefined {
  const next = asRecord(asRecord(asRecord(body)["pagination"])["next"]);
  const href = next["href"];
  if (typeof href !== "string" || href.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Fetches audit events for an app, following pagination up to `input.limit`. */
export async function fetchAuditEvents(
  input: FetchAuditEventsInput,
  curl: CurlFn,
): Promise<readonly AuditEvent[]> {
  const limit = Math.max(input.limit, 1);
  const perPage = Math.min(limit, MAX_PER_PAGE);
  const events: AuditEvent[] = [];
  let path: string | undefined = buildAuditEventsPath(input, perPage);

  while (path !== undefined && events.length < limit) {
    const body = parseJson(await curl(path));
    for (const resource of asArray(asRecord(body)["resources"])) {
      events.push(mapAuditEvent(resource));
      if (events.length >= limit) {
        break;
      }
    }
    path = events.length < limit ? nextPagePath(body) : undefined;
  }
  return events;
}

export async function fetchApp(appGuid: string, curl: CurlFn): Promise<AppSummary> {
  const body = asRecord(parseJson(await curl(`/v3/apps/${appGuid}`)));
  return {
    guid: asString(body["guid"]),
    name: asString(body["name"]),
    state: asString(body["state"]),
  };
}

export async function fetchSshEnabled(appGuid: string, curl: CurlFn): Promise<SshEnabled> {
  const body = asRecord(parseJson(await curl(`/v3/apps/${appGuid}/ssh_enabled`)));
  return {
    enabled: body["enabled"] === true,
    reason: asString(body["reason"]),
  };
}

export async function fetchWebProcessStats(
  appGuid: string,
  curl: CurlFn,
): Promise<readonly ProcessInstanceStat[]> {
  const body = asRecord(parseJson(await curl(`/v3/apps/${appGuid}/processes/web/stats`)));
  return asArray(body["resources"]).map(mapProcessStat);
}
