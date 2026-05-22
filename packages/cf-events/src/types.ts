import type { RegionKey } from "@saptools/cf-sync";

export type { RegionKey } from "@saptools/cf-sync";

/** Cloud Foundry v3 audit event types that target an application. */
export const APP_EVENT_TYPES = [
  "audit.app.create",
  "audit.app.update",
  "audit.app.delete-request",
  "audit.app.start",
  "audit.app.stop",
  "audit.app.restage",
  "audit.app.ssh-authorized",
  "audit.app.ssh-unauthorized",
  "audit.app.crash",
  "audit.app.process.create",
  "audit.app.process.scale",
  "audit.app.process.update",
  "audit.app.process.crash",
  "audit.app.process.terminate_instance",
  "audit.app.map-route",
  "audit.app.unmap-route",
  "audit.app.environment_variables.show",
] as const;

export type AppEventType = (typeof APP_EVENT_TYPES)[number];

/** Event types emitted when an SSH/debug connection is authorized or denied. */
export const SSH_EVENT_TYPES = ["audit.app.ssh-authorized", "audit.app.ssh-unauthorized"] as const;

/** Event types emitted when an application instance crashes. */
export const CRASH_EVENT_TYPES = ["audit.app.crash", "audit.app.process.crash"] as const;

export interface CfCredentials {
  readonly email: string;
  readonly password: string;
}

/** A fully resolved `region/org/space/app` target. */
export interface ResolvedSelector {
  readonly raw: string;
  readonly regionKey: RegionKey;
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
}

export interface CfSessionInput {
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly credentials: CfCredentials;
}

/** Handle for a CF CLI session bound to an isolated, ephemeral `CF_HOME`. */
export interface CfCliContext {
  readonly cfHomeDir: string;
}

export interface CfEntityRef {
  readonly guid: string;
  readonly type: string;
  readonly name: string;
}

export interface AuditEvent {
  readonly guid: string;
  readonly type: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly actor: CfEntityRef;
  readonly target: CfEntityRef;
  readonly data: Record<string, unknown>;
  readonly spaceGuid: string | undefined;
  readonly organizationGuid: string | undefined;
}

export interface AppSummary {
  readonly guid: string;
  readonly name: string;
  readonly state: string;
}

export interface SshEnabled {
  readonly enabled: boolean;
  readonly reason: string;
}

export interface ProcessInstanceStat {
  readonly type: string;
  readonly index: number;
  readonly state: string;
  readonly uptimeSeconds: number | undefined;
  readonly cpu: number | undefined;
  readonly memBytes: number | undefined;
  readonly memQuotaBytes: number | undefined;
  readonly diskBytes: number | undefined;
  readonly diskQuotaBytes: number | undefined;
}

export interface CrashRecord {
  readonly at: string;
  readonly index: number | undefined;
  readonly reason: string | undefined;
  readonly exitStatus: number | undefined;
}

export interface CrashSummary {
  readonly appName: string;
  readonly crashCount: number;
  readonly lastCrashAt: string | undefined;
  readonly lastCrashReason: string | undefined;
  readonly crashes: readonly CrashRecord[];
}

/**
 * An SSH/debug session inferred from a single `ssh-authorized` audit event.
 * Cloud Foundry does not expose live sessions, so `likelyActive` is a
 * best-effort signal based on how recently the session was authorized.
 */
export interface SshSession {
  readonly actor: string;
  readonly authorizedAt: string;
  readonly likelyActive: boolean;
}

export interface SshStatus {
  readonly appName: string;
  readonly sshEnabled: boolean;
  readonly sshReason: string;
  readonly sessions: readonly SshSession[];
  readonly deniedAttempts: readonly AuditEvent[];
  readonly activeSessionCount: number;
}

export interface AppHealth {
  readonly appName: string;
  readonly appGuid: string;
  readonly requestedState: string;
  readonly sshEnabled: boolean;
  readonly instances: readonly ProcessInstanceStat[];
  readonly lastEvent: AuditEvent | undefined;
}

export interface FetchAuditEventsInput {
  readonly appGuid: string;
  readonly types: readonly string[] | undefined;
  readonly createdAfter: string | undefined;
  readonly limit: number;
}
