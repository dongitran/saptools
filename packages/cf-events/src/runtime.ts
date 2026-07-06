import { setTimeout as delayPromise } from "node:timers/promises";

import {
  fetchApp,
  fetchAuditEvents,
  fetchSshEnabled,
  fetchWebProcessStats,
  resolveOrganizationGuid,
  resolveSpaceGuid,
} from "./api.js";
import type { CurlFn } from "./api.js";
import { cfAppGuid, cfCurl, prepareCfCliSession, withCfSession } from "./cf.js";
import { durationToCreatedAfter, summarizeCrashes, summarizeSpaceCrashes } from "./events.js";
import { resolveSelector } from "./selector.js";
import { buildSshStatus } from "./ssh.js";
import { CRASH_EVENT_TYPES, SSH_EVENT_TYPES } from "./types.js";
import type {
  AppHealth,
  AppSummary,
  AuditEvent,
  AuditEventScope,
  CfCredentials,
  CrashReportSummary,
  FetchAuditEventsInput,
  ProcessInstanceStat,
  ResolvedAppSelector,
  ResolvedSelector,
  SshEnabled,
  SshStatus,
} from "./types.js";

/** Typed accessor for the Cloud Foundry v3 API used by the runtime. */
export interface CfClient {
  readonly fetchAuditEvents: (input: FetchAuditEventsInput) => Promise<readonly AuditEvent[]>;
  readonly fetchApp: (appGuid: string) => Promise<AppSummary>;
  readonly fetchSshEnabled: (appGuid: string) => Promise<SshEnabled>;
  readonly fetchWebProcessStats: (appGuid: string) => Promise<readonly ProcessInstanceStat[]>;
  readonly resolveOrganizationGuid: (orgName: string) => Promise<string>;
  readonly resolveSpaceGuid: (spaceName: string, orgGuid: string) => Promise<string>;
}

export interface CfTargetSession {
  readonly selector: ResolvedSelector;
  readonly client: CfClient;
  readonly resolveAppGuid: (appName: string) => Promise<string>;
}

/** Injection seam so the orchestration can be unit-tested without a real CF. */
export interface CfEventsDependencies {
  readonly resolveSelector: (raw: string) => Promise<ResolvedSelector>;
  readonly withCfTarget: <T>(
    selector: ResolvedSelector,
    credentials: CfCredentials,
    work: (session: CfTargetSession) => Promise<T>,
  ) => Promise<T>;
  readonly now: () => Date;
}

export interface EventQueryOptions {
  readonly limit: number;
  readonly since: string | undefined;
  readonly types: readonly string[];
}

export interface CrashQueryOptions {
  readonly limit: number;
  readonly since: string | undefined;
}

export interface WatchOptions {
  readonly intervalMs: number;
  readonly lookback: string;
  readonly types: readonly string[];
}

const SSH_STATUS_EVENT_LIMIT = 200;
const WATCH_FETCH_LIMIT = 100;

function createCfClient(curl: CurlFn): CfClient {
  return {
    fetchAuditEvents: (input) => fetchAuditEvents(input, curl),
    fetchApp: (appGuid) => fetchApp(appGuid, curl),
    fetchSshEnabled: (appGuid) => fetchSshEnabled(appGuid, curl),
    fetchWebProcessStats: (appGuid) => fetchWebProcessStats(appGuid, curl),
    resolveOrganizationGuid: (orgName) => resolveOrganizationGuid(orgName, curl),
    resolveSpaceGuid: (spaceName, orgGuid) => resolveSpaceGuid(spaceName, orgGuid, curl),
  };
}

async function defaultWithCfTarget<T>(
  selector: ResolvedSelector,
  credentials: CfCredentials,
  work: (session: CfTargetSession) => Promise<T>,
): Promise<T> {
  return await withCfSession(async (ctx) => {
    await prepareCfCliSession(
      {
        apiEndpoint: selector.apiEndpoint,
        orgName: selector.orgName,
        spaceName: selector.spaceName,
        credentials,
      },
      ctx,
    );
    const client = createCfClient((path) => cfCurl(path, ctx));
    return await work({ selector, client, resolveAppGuid: (appName) => cfAppGuid(appName, ctx) });
  });
}

export function createDefaultDependencies(): CfEventsDependencies {
  return {
    resolveSelector,
    withCfTarget: defaultWithCfTarget,
    now: () => new Date(),
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delayPromise(ms, undefined, { signal });
  } catch {
    // The abort signal fired; resolve quietly so the watch loop can re-check it.
  }
}

function requireAppSelector(selector: ResolvedSelector, command: string): ResolvedAppSelector {
  if (selector.kind === "app") {
    return selector;
  }
  throw new Error(
    `The ${command} command requires an app selector. Use region/org/space/app or a bare app name.`,
  );
}

async function resolveAuditScope(session: CfTargetSession): Promise<AuditEventScope> {
  if (session.selector.kind === "app") {
    return { kind: "app", appGuid: await session.resolveAppGuid(session.selector.appName) };
  }
  const orgGuid = await session.client.resolveOrganizationGuid(session.selector.orgName);
  return {
    kind: "space",
    spaceGuid: await session.client.resolveSpaceGuid(session.selector.spaceName, orgGuid),
  };
}

/** Orchestrates the cf-events commands on top of an injectable dependency set. */
export class CfEventsRuntime {
  private readonly deps: CfEventsDependencies;

  constructor(deps: CfEventsDependencies = createDefaultDependencies()) {
    this.deps = deps;
  }

  async fetchEvents(
    raw: string,
    credentials: CfCredentials,
    options: EventQueryOptions,
  ): Promise<readonly AuditEvent[]> {
    const selector = await this.deps.resolveSelector(raw);
    return await this.deps.withCfTarget(selector, credentials, async (session) => {
      return await session.client.fetchAuditEvents({
        scope: await resolveAuditScope(session),
        types: options.types.length > 0 ? options.types : undefined,
        createdAfter: this.resolveCreatedAfter(options.since),
        limit: options.limit,
      });
    });
  }

  async getSshStatus(raw: string, credentials: CfCredentials, since: string): Promise<SshStatus> {
    const selector = requireAppSelector(await this.deps.resolveSelector(raw), "ssh-status");
    return await this.deps.withCfTarget(selector, credentials, async ({ client, resolveAppGuid }) => {
      const appGuid = await resolveAppGuid(selector.appName);
      const [sshEnabled, events] = await Promise.all([
        client.fetchSshEnabled(appGuid),
        client.fetchAuditEvents({
          scope: { kind: "app", appGuid },
          types: [...SSH_EVENT_TYPES],
          createdAfter: durationToCreatedAfter(since, this.deps.now()),
          limit: SSH_STATUS_EVENT_LIMIT,
        }),
      ]);
      return buildSshStatus({
        appName: selector.appName,
        sshEnabled: sshEnabled.enabled,
        sshReason: sshEnabled.reason,
        events,
        now: this.deps.now(),
      });
    });
  }

  async getCrashes(
    raw: string,
    credentials: CfCredentials,
    options: CrashQueryOptions,
  ): Promise<CrashReportSummary> {
    const selector = await this.deps.resolveSelector(raw);
    return await this.deps.withCfTarget(selector, credentials, async (session) => {
      const events = await session.client.fetchAuditEvents({
        scope: await resolveAuditScope(session),
        types: [...CRASH_EVENT_TYPES],
        createdAfter: this.resolveCreatedAfter(options.since),
        limit: options.limit,
      });
      if (selector.kind === "app") {
        return summarizeCrashes(selector.appName, events);
      }
      return summarizeSpaceCrashes(`${selector.regionKey}/${selector.orgName}/${selector.spaceName}`, events);
    });
  }

  async getStatus(raw: string, credentials: CfCredentials): Promise<AppHealth> {
    const selector = requireAppSelector(await this.deps.resolveSelector(raw), "status");
    return await this.deps.withCfTarget(selector, credentials, async ({ client, resolveAppGuid }) => {
      const appGuid = await resolveAppGuid(selector.appName);
      const [app, instances, sshEnabled, recent] = await Promise.all([
        client.fetchApp(appGuid),
        client.fetchWebProcessStats(appGuid),
        client.fetchSshEnabled(appGuid),
        client.fetchAuditEvents({ scope: { kind: "app", appGuid }, types: undefined, createdAfter: undefined, limit: 1 }),
      ]);
      return {
        appName: selector.appName,
        appGuid,
        requestedState: app.state,
        sshEnabled: sshEnabled.enabled,
        instances,
        lastEvent: recent[0],
      };
    });
  }

  async watchEvents(
    raw: string,
    credentials: CfCredentials,
    options: WatchOptions,
    onEvent: (event: AuditEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const selector = await this.deps.resolveSelector(raw);
    await this.deps.withCfTarget(selector, credentials, async (session) => {
      const scope = await resolveAuditScope(session);
      const seen = new Set<string>();
      let cursor = durationToCreatedAfter(options.lookback, this.deps.now());

      while (!signal.aborted) {
        const events = await session.client.fetchAuditEvents({
          scope,
          types: options.types.length > 0 ? options.types : undefined,
          createdAfter: cursor,
          limit: WATCH_FETCH_LIMIT,
        });

        const fresh: AuditEvent[] = [];
        for (const event of events) {
          if (!seen.has(event.guid)) {
            seen.add(event.guid);
            fresh.push(event);
          }
        }
        for (const event of [...fresh].reverse()) {
          onEvent(event);
        }

        const newest = events[0];
        if (newest !== undefined && newest.createdAt.length > 0) {
          cursor = newest.createdAt;
        }
        await delay(options.intervalMs, signal);
      }
    });
  }

  private resolveCreatedAfter(since: string | undefined): string | undefined {
    return since === undefined ? undefined : durationToCreatedAfter(since, this.deps.now());
  }
}
