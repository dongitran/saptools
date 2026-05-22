import { setTimeout as delayPromise } from "node:timers/promises";

import { fetchApp, fetchAuditEvents, fetchSshEnabled, fetchWebProcessStats } from "./api.js";
import type { CurlFn } from "./api.js";
import { cfAppGuid, cfCurl, prepareCfCliSession, withCfSession } from "./cf.js";
import { durationToCreatedAfter, summarizeCrashes } from "./events.js";
import { resolveSelector } from "./selector.js";
import { buildSshStatus } from "./ssh.js";
import { CRASH_EVENT_TYPES, SSH_EVENT_TYPES } from "./types.js";
import type {
  AppHealth,
  AppSummary,
  AuditEvent,
  CfCredentials,
  CrashSummary,
  FetchAuditEventsInput,
  ProcessInstanceStat,
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
}

export interface CfAppSession {
  readonly appGuid: string;
  readonly client: CfClient;
}

/** Injection seam so the orchestration can be unit-tested without a real CF. */
export interface CfEventsDependencies {
  readonly resolveSelector: (raw: string) => Promise<ResolvedSelector>;
  readonly withCfApp: <T>(
    selector: ResolvedSelector,
    credentials: CfCredentials,
    work: (session: CfAppSession) => Promise<T>,
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
  };
}

async function defaultWithCfApp<T>(
  selector: ResolvedSelector,
  credentials: CfCredentials,
  work: (session: CfAppSession) => Promise<T>,
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
    const appGuid = await cfAppGuid(selector.appName, ctx);
    const client = createCfClient((path) => cfCurl(path, ctx));
    return await work({ appGuid, client });
  });
}

export function createDefaultDependencies(): CfEventsDependencies {
  return {
    resolveSelector,
    withCfApp: defaultWithCfApp,
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
    return await this.deps.withCfApp(selector, credentials, async ({ appGuid, client }) => {
      return await client.fetchAuditEvents({
        appGuid,
        types: options.types.length > 0 ? options.types : undefined,
        createdAfter: this.resolveCreatedAfter(options.since),
        limit: options.limit,
      });
    });
  }

  async getSshStatus(raw: string, credentials: CfCredentials, since: string): Promise<SshStatus> {
    const selector = await this.deps.resolveSelector(raw);
    return await this.deps.withCfApp(selector, credentials, async ({ appGuid, client }) => {
      const [sshEnabled, events] = await Promise.all([
        client.fetchSshEnabled(appGuid),
        client.fetchAuditEvents({
          appGuid,
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
  ): Promise<CrashSummary> {
    const selector = await this.deps.resolveSelector(raw);
    return await this.deps.withCfApp(selector, credentials, async ({ appGuid, client }) => {
      const events = await client.fetchAuditEvents({
        appGuid,
        types: [...CRASH_EVENT_TYPES],
        createdAfter: this.resolveCreatedAfter(options.since),
        limit: options.limit,
      });
      return summarizeCrashes(selector.appName, events);
    });
  }

  async getStatus(raw: string, credentials: CfCredentials): Promise<AppHealth> {
    const selector = await this.deps.resolveSelector(raw);
    return await this.deps.withCfApp(selector, credentials, async ({ appGuid, client }) => {
      const [app, instances, sshEnabled, recent] = await Promise.all([
        client.fetchApp(appGuid),
        client.fetchWebProcessStats(appGuid),
        client.fetchSshEnabled(appGuid),
        client.fetchAuditEvents({ appGuid, types: undefined, createdAfter: undefined, limit: 1 }),
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
    await this.deps.withCfApp(selector, credentials, async ({ appGuid, client }) => {
      const seen = new Set<string>();
      let cursor = durationToCreatedAfter(options.lookback, this.deps.now());

      while (!signal.aborted) {
        const events = await client.fetchAuditEvents({
          appGuid,
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
